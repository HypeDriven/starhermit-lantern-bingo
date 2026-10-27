// Plays the web package in Chrome on the machine's GPU (~/games/tools/gpu-chrome.mjs;
// GPU_ADAPTER=software for headless SwiftShader), past
// ~/games/tools/engine-web-smoke.mjs's start: at a desktop viewport, a tall
// desktop (the 3D hall under the card), a phone (DPR 3) and a phone held
// sideways it starts Quick Play by keys (Enter on Play, Enter on Start),
// waits out the countdown, calls a number (Space), takes a hint (H), taps a
// card cell on the phones, and opens the pause dialog (P), saving a
// screenshot at each step and failing on console errors or warnings or the
// runtime's error screen. (After hidden-council's tools/browser-play.mjs.)
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
// Serves GAME_DIR on loopback (never tests/, tools/ or dot-names; the
// platform's clock at /api/v1/time), the engine itself from
// wiki.starhermit.com as the loader pins it. playwright-core is resolved from
// GAME_DIR's node_modules or any sibling game's.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const gpuChrome = existsSync(join(dir, '..', 'tools', 'gpu-chrome.mjs')) ? join(dir, '..', 'tools', 'gpu-chrome.mjs') : join(homedir(), 'games/tools/gpu-chrome.mjs');
const { launchChrome } = await import(gpuChrome);
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
const dpr = 3;
// Title → Play (Enter) → Mode Setup → Start (Enter) → the round.
const start = [['shot', 'title'], ['key', 'Enter'], ['wait', 1500], ['shot', 'setup'], ['key', 'Enter'], ['wait', 5000], ['shot', 'play'],
  ['key', 'Space'], ['wait', 1500], ['key', 'KeyH'], ['wait', 800], ['shot', 'call-hint']];
const views = [
  { name: 'desktop', viewport: { width: 1366, height: 768 }, steps: [...start, ['key', 'KeyP'], ['wait', 800], ['shot', 'pause']] },
  { name: 'tall', viewport: { width: 1920, height: 1080 }, steps: [...start, ['wait', 3000], ['shot', 'hall'], ['key', 'KeyP'], ['wait', 800], ['shot', 'pause']] },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, steps: [...start, ['tap', 0.5, 0.45], ['wait', 1000], ['shot', 'tap'], ['key', 'KeyP'], ['wait', 800], ['shot', 'pause']] },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, steps: [...start, ['tap', 0.5, 0.5], ['wait', 1000], ['shot', 'tap'], ['key', 'KeyP'], ['wait', 800], ['shot', 'pause']] },
];
let failed = false;
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.isMobile ? dpr : 1 });
  const page = await ctx.newPage();
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text())) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
  // The first key press can be lost while the runtime starts: settle first.
  await page.waitForTimeout(4000);
  for (const [op, a, b] of v.steps) {
    if (op === 'key') { await page.keyboard.down(a); await page.waitForTimeout(100); await page.keyboard.up(a); await page.waitForTimeout(250); }
    if (op === 'wait') await page.waitForTimeout(a);
    if (op === 'tap') { await page.touchscreen.tap(v.viewport.width * a, v.viewport.height * b); await page.waitForTimeout(900); }
    if (op === 'shot' && shots) { mkdirSync(shots, { recursive: true }); await page.waitForTimeout(500); await page.screenshot({ path: join(shots, `${v.name}-${a}.png`) }); }
  }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state === 'running' && problems.length === 0;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);
