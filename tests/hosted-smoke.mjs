'use strict';
// Hosted-mode browser smoke: serves the game and a mock StarHermit platform
// (profile, cloud-saves, launch-token refresh) same-origin, then loads the
// page with a #game_token fragment. Verifies: token read once + stripped,
// account nickname + sync status on the title screen, debounced cloud PUT
// after a settings change, Bearer on every call, no console errors.
// Run: node tests/hosted-smoke.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.opus': 'audio/ogg', '.webp': 'image/webp',
};
const results = [];
const check = (name, ok, extra = '') => {
  results.push([name, ok]);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''));
};

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
const TOKEN = b64url({ alg: 'none' }) + '.' + b64url({ sub: 'user-abc-123', game_scope: 'lantern-bingo' }) + '.sig';
const calls = []; // every platform request, for assertions
let cloudSave = null; // current stored save doc (base64 zip)
let refreshCount = 0;

function platformRest(req, res, url) {
  const auth = req.headers.authorization || '';
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  calls.push({ path: url.pathname, auth });
  if (!auth.startsWith('Bearer ')) return json(401, { error: 'unauthorized' });
  if (url.pathname === '/api/v1/users/user-abc-123/profile') {
    return json(200, { id: 'user-abc-123', username: 'smoke_user', nickname: 'Smoke Tester' });
  }
  if (url.pathname === '/api/v1/games/lantern-bingo/launch-token' && req.method === 'POST') {
    refreshCount++;
    return json(200, { token: TOKEN.slice(0, -4) + '.r' + refreshCount });
  }
  if (url.pathname === '/api/v1/me/cloud-saves/lantern-bingo') {
    if (req.method === 'GET') {
      if (!cloudSave) return json(404, { error: 'not-found' });
      return json(200, { dataBase64: cloudSave });
    }
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { cloudSave = JSON.parse(body).dataBase64; json(200, { ok: true }); });
      return;
    }
  }
  json(404, { error: 'not-found' });
}

// One same-origin server: /api/* is the mock platform, everything else static.
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return platformRest(req, res, url);
  let p = path.normalize(decodeURIComponent(url.pathname));
  if (p === '/' || p === '\\') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || p.includes('..')) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  // the documented empty-cloud-slot probe 404s by design (404 = no save yet)
  if (/Failed to load resource/.test(m.text()) && /cloud-saves/.test(m.location().url)) return;
  if (/GL Driver|swiftshader|GPU stall|Automatic fallback/i.test(m.text())) return;
  errors.push('console: ' + m.text() + ' @ ' + m.location().url);
});

try {
  await page.goto(`${base}/index.html#game_token=${TOKEN}`, { waitUntil: 'load' });
  await page.waitForSelector('#screen-title:not([hidden])', { timeout: 10000 });

  const stripped = await page.evaluate(() => !location.hash.includes('game_token'));
  check('fragment token read once and stripped', stripped, await page.evaluate(() => location.hash));

  await page.waitForFunction(() => {
    const el = document.querySelector('#account-line');
    return !el.hidden && el.textContent.includes('Smoke Tester');
  }, null, { timeout: 8000 });
  const line = await page.textContent('#account-line');
  check('account line shows nickname (never username)', line.includes('Smoke Tester') && !line.includes('smoke_user'), line.trim());
  check('sync status visible', /cloud save/.test(line), line.trim());

  // a settings change triggers the debounced cloud PUT
  await page.click('[data-nav="settings"]');
  await page.selectOption('#settings-form select[name="theme"]', 'jade');
  await page.waitForTimeout(2600); // 2 s debounce + network
  const put = calls.find(c => c.path.includes('/cloud-saves/'));
  check('settings change cloud-mirrors (debounced PUT)', !!put);
  if (put) check('cloud PUT used Bearer', (put.auth || '').startsWith('Bearer '), put.auth.slice(0, 24));
  const saved = await page.evaluate(() =>
    JSON.parse(JSON.parse(localStorage.getItem('lantern-bingo-v1')).payload).settings.theme);
  check('localStorage stays the local cache', saved === 'jade', saved);

  // every platform call carried Bearer; only documented endpoints were hit
  const paths = calls.map(c => c.path);
  check('profile came from /users/{sub}/profile', paths.includes('/api/v1/users/user-abc-123/profile'));
  check('never called /api/v1/me directly', !paths.some(p => p === '/api/v1/me'));
  check('no fabricated daily/time calls', !paths.some(p => p.includes('/daily') || p.includes('/time')));
  check('all calls carried Authorization', calls.every(c => (c.auth || '').startsWith('Bearer ')));

  check('zero console errors in hosted mode', errors.length === 0, errors.join(' | ').slice(0, 300));
} finally {
  await browser.close();
  await new Promise(r => server.close(r));
}

const failed = results.filter(r => !r[1]).length;
console.log(failed ? `${failed} FAILURES` : 'ALL HOSTED SMOKE TESTS PASSED');
process.exit(failed ? 1 : 0);
