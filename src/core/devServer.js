/** Two favours the dev server does for recordings; a published build has no server, so both throw there. */
export const UPLOAD_URL = 'https://github.com/leTiminator/Vtuber-Model/upload/recordings/test/fixtures/sessions';

async function post(path, body) {
  if (!import.meta.env.DEV) throw new Error('this build has no server to keep recordings');
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `${path}: ${res.status}`);
  return data;
}

export const saveRecording = (json) => post('/__record', json);
export const shareRecording = (name) => post('/__share', JSON.stringify({ name }));
