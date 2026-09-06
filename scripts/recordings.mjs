/**
 * Keeps the app's recordings. Dev server only: `POST /__record` writes a
 * recording into the project, and `POST /__share` pushes one to the
 * `recordings` branch on GitHub with git plumbing, so the checkout's HEAD,
 * index and working tree are never touched and the developer finds it there.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defaultAllowedOrigins } from 'vite';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const BRANCH = 'recordings';
const LIMIT = 20 * 1024 * 1024;
const NAME = /^[\w-]+\.json$/;

/** Where recordings land; tests point this somewhere disposable. */
export const sessionsDir = () => process.env.VTUBER_SESSIONS_DIR || join(ROOT, 'test', 'fixtures', 'sessions');

export function recordings() {
  return {
    name: 'vtuber-recordings',
    configureServer(server) {
      server.middlewares.use('/__record', route(saveRecording));
      server.middlewares.use('/__share', route(async (body) => shareRecording(body.name)));
    },
  };
}

/** A JSON POST from this origin, answered with JSON; anything else is a 4xx. */
function route(handler) {
  return async (req, res) => {
    const reply = (status, data) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(data));
    };
    if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });
    const origin = req.headers.origin;
    if (origin && !defaultAllowedOrigins.test(origin)) return reply(403, { ok: false, error: 'origin not allowed' });
    if (!/application\/json/.test(req.headers['content-type'] ?? '')) return reply(415, { ok: false, error: 'send JSON' });
    let text;
    try {
      text = await readBody(req);
    } catch (err) {
      return reply(413, { ok: false, error: err.message });
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return reply(400, { ok: false, error: 'not JSON' });
    }
    try {
      reply(200, { ok: true, ...(await handler(body, text)) });
    } catch (err) {
      reply(400, { ok: false, error: err.message });
    }
  };
}

function readBody(req) {
  return new Promise((done, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > LIMIT) { fail(new Error('recording too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);

async function saveRecording(body, text) {
  if (!body || body.version !== 1 || !Array.isArray(body.samples)) throw new Error('not a recording');
  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true });
  const name = `${stamp()}.json`;
  writeFileSync(join(dir, name), text);
  return { name, path: relative(ROOT, join(dir, name)).split('\\').join('/') };
}

/** git without a shell; ENOENT means git is not installed. */
function git(args, env = {}) {
  return new Promise((done, fail) => {
    execFile('git', args, {
      cwd: ROOT, timeout: 60000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    }, (err, stdout, stderr) => {
      if (err) {
        fail(err.code === 'ENOENT' ? new Error('git is not installed on this machine')
          : new Error(`${args[0]}: ${(stderr || err.message).trim()}`));
      } else done(stdout.trim());
    });
  });
}

/**
 * One recording onto the `recordings` branch: a fresh index in a temp file,
 * the branch's tree read into it, the file added, a commit written on top of
 * the remote branch, pushed by sha. Never fast-forwards anything local.
 */
async function shareRecording(name) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error('which recording?');
  const file = join(sessionsDir(), name);
  if (!existsSync(file)) throw new Error(`${name} is not in ${relative(ROOT, sessionsDir())}`);
  const identity = {
    GIT_AUTHOR_NAME: 'VTuber Model recorder', GIT_AUTHOR_EMAIL: 'recorder@vtuber-model.invalid',
    GIT_COMMITTER_NAME: 'VTuber Model recorder', GIT_COMMITTER_EMAIL: 'recorder@vtuber-model.invalid',
  };
  try {
    await git(['rev-parse', '--git-dir']);
  } catch (err) {
    if (/not installed/.test(err.message)) throw err;
    throw new Error('this folder is not a git checkout, so it cannot push; use the upload page');
  }
  let parent = null;
  try {
    await git(['fetch', 'origin', BRANCH]);
    parent = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${BRANCH}`]);
  } catch {
    parent = null; // no branch yet: this commit starts it
  }
  const index = join(tmpdir(), `vtuber-share-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: index };
  const blob = await git(['hash-object', '-w', file]);
  if (parent) await git(['read-tree', parent], env);
  else await git(['read-tree', '--empty'], env);
  const inTree = `test/fixtures/sessions/${name}`;
  await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${inTree}`], env);
  const tree = await git(['write-tree'], env);
  const commit = await git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `Recording ${name}`], identity);
  try {
    await git(['push', 'origin', `${commit}:refs/heads/${BRANCH}`]);
  } catch (err) {
    throw new Error(`push refused: ${err.message}. Use the upload page instead.`);
  }
  return { branch: BRANCH, commit: commit.slice(0, 7), file: inTree };
}
