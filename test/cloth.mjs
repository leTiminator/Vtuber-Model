/**
 * The scarf's chain, in Node: rigid links that bend and never stretch.
 *
 *   node test/cloth.mjs
 */
const { LinkChain } = await import('../src/avatars/warp2d/cloth.js');

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

// A drawn ribbon: sixteen nodes along a gentle arc, in image UV.
const NODES = 16;
const rest = [];
for (let i = 0; i < NODES; i++) {
  const t = i / (NODES - 1);
  rest.push([0.3 + t * 0.5, 0.4 + Math.sin(t * 2.2) * 0.12]);
}
const chain = new LinkChain({ nodes: NODES, pinned: 2, bend: 160, rest: 14, damping: 3, tipBias: 3.2, carry: 3 });
chain.setRest(rest, 1);

const lengths = () => {
  const out = [];
  for (let i = 1; i < NODES; i++) out.push(Math.hypot(chain.px[i] - chain.px[i - 1], chain.py[i] - chain.py[i - 1]));
  return out;
};
const drawn = lengths();

// A minute of abuse: yanks, gusts and stillness, at a fixed step.
let worst = 0;
let finite = true;
let farthest = 0;
for (let f = 0; f < 3600; f++) {
  const s = f / 60;
  const gust = s % 10 < 1 ? 12 : 0;
  const fx = Math.sin(s * 3.1) * 6 + gust * Math.sign(Math.sin(s));
  const fy = Math.cos(s * 2.3) * 4;
  const out = chain.step(fx, fy, 0.5, 1 / 60);
  for (const v of out) if (!Number.isFinite(v)) finite = false;
  const now = lengths();
  for (let i = 0; i < now.length; i++) worst = Math.max(worst, Math.abs(now[i] - drawn[i]) / drawn[i]);
  for (let i = 0; i < NODES; i++) {
    farthest = Math.max(farthest, Math.hypot(out[i * 2], out[i * 2 + 1]));
  }
}
check('every link keeps its drawn length through a minute of yanks and gusts', worst < 1e-3,
  `worst stretch ${(worst * 100).toFixed(4)}%`);
check('every node stays finite', finite);
check('no node leaves the drawing by more than the chain\'s own limit', farthest <= chain.limit * 1.5,
  `farthest ${farthest.toFixed(3)} against a limit of ${chain.limit}`);

// Still air: the chain returns to the drawing.
for (let f = 0; f < 600; f++) chain.step(0, 0, 0, 1 / 60);
let away = 0;
const settled = chain.step(0, 0, 0, 1 / 60);
for (let i = 0; i < NODES; i++) away = Math.max(away, Math.hypot(settled[i * 2], settled[i * 2 + 1]));
check('in still air it settles back onto the drawing', away < 0.002, `${(away * 630).toFixed(2)}px off at 630px`);

console.log(`\n${failures ? `${failures} failing` : 'cloth clean'}`);
process.exit(failures ? 1 : 0);
