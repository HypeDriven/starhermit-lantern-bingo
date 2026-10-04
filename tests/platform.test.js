'use strict';

// StarHermit adapter tests: js/platform.js driven by the real shared SDK
// (starhermit-sdk.js) with a stubbed fetch and launch fragment.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPlatform } from '../js/platform.js';

const SDK_SRC = fs.readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8');
function loadSdk() {
  const mod = { exports: {} };
  new Function('module', 'exports', 'self', SDK_SRC)(mod, mod.exports, globalThis);
  return mod.exports;
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const SLUG = 'lantern-bingo';
const USER = 'a1b2c3d4-0000-4000-8000-000000000001';
function makeJwt() {
  return b64url({ alg: 'none' }) + '.' +
    b64url({ sub: USER, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.sig';
}

function fakeWindow(href) {
  const u = new URL(href);
  const win = {
    location: {
      href, hostname: u.hostname, pathname: u.pathname, search: u.search, hash: u.hash, origin: u.origin,
      assign() {},
    },
    history: { state: null, replaceState(_s, _t, url) { win.replaced = url; win.location.hash = ''; } },
  };
  return win;
}

// Fake platform: records calls, keeps one cloud-save slot and a settings KV.
function fakePlatform() {
  const calls = [];
  let slot = null;
  const settings = { theme: 'jade' };
  const res = (status, body, bytes) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => (body == null ? '' : JSON.stringify(body)),
    json: async () => body,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    headers: { get: () => null },
  });
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, auth: (init.headers || {}).Authorization || (init.headers || {}).authorization });
    if (url === `/api/v1/users/${USER}/profile`) return res(200, { nickname: 'Lamplighter', username: 'secret_user' });
    if (url === `/api/v1/me/cloud-saves/${encodeURIComponent('game:' + SLUG)}`) {
      if (method === 'PUT') { slot = Buffer.from(body.dataBase64, 'base64'); return res(204); }
      return slot ? res(200, null, new Uint8Array(slot)) : res(404);
    }
    if (url === `/api/v1/games/${SLUG}/settings`) {
      if (method === 'PATCH') { Object.assign(settings, body.settings); return res(200, { settings }); }
      return res(200, { settings });
    }
    if (url === `/api/v1/games/${SLUG}/controls`) {
      return res(200, { actions: [{ action: 'claim', codes: ['KeyX'] }] });
    }
    return res(404);
  };
  return { fetch, calls, settings };
}

function timers() {
  const q = [];
  return {
    setTimeout(fn) { q.push(fn); return q.length; },
    clearTimeout() {},
    runAll() { while (q.length) q.shift()(); },
  };
}

function hostedSetup() {
  const fp = fakePlatform();
  const t = timers();
  const win = fakeWindow(`https://${SLUG}.starhermit.com/index.html#game_token=${makeJwt()}&session_id=s-1`);
  const sh = loadSdk().create({ window: win, fetch: fp.fetch, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  const p = createPlatform({ sh, fetch: fp.fetch, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  return { fp, t, win, sh, p };
}

test('launch token is read from the fragment, stripped, and decoded', () => {
  const { p, win } = hostedSetup();
  assert.equal(p.hosted, true);
  assert.equal(p.slug, SLUG);
  assert.equal(p.sub, USER);
  assert.equal(p.launchSessionId, 's-1');
  assert.ok(!String(win.replaced).includes('game_token'));
});

test('profile nickname is the display name (never the username)', async () => {
  const { p, fp } = hostedSetup();
  assert.equal(await p.loadProfile(), 'Lamplighter');
  const call = fp.calls.find((c) => c.url.endsWith('/profile'));
  assert.match(call.auth, /^Bearer /);
});

test('cloud save round-trips through /me/cloud-saves/game:<slug>', async () => {
  const { p, fp } = hostedSetup();
  const statuses = [];
  p.onSync((s) => statuses.push(s));
  p.pushCloud({ version: 1, progress: { gamesPlayed: 7 } });
  await p.flushCloud();
  const put = fp.calls.find((c) => c.method === 'PUT');
  assert.equal(put.url, '/api/v1/me/cloud-saves/game%3Alantern-bingo');
  assert.deepEqual(await p.loadCloud(), { version: 1, progress: { gamesPlayed: 7 } });
  assert.deepEqual(statuses, ['saving', 'synced']);
});

test('settings: load from KV, then patch only changed keys after priming', async () => {
  const { p, fp, t } = hostedSetup();
  assert.deepEqual(await p.loadSettings(), { theme: 'jade' });
  p.pushSettings({ theme: 'jade', muted: false }); // before priming: ignored
  p.primeSettings({ theme: 'jade', muted: false });
  p.pushSettings({ theme: 'plum', muted: false });
  t.runAll();
  await new Promise((r) => setImmediate(r));
  const patch = fp.calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.url, `/api/v1/games/${SLUG}/settings`);
  assert.deepEqual(patch.body, { settings: { theme: 'plum' } });
  assert.equal(fp.settings.theme, 'plum');
});

test('bindings apply platform overrides over defaults; invite link uses user + slug', async () => {
  const { p } = hostedSetup();
  const b = await p.loadBindings({ claim: ['KeyC'], hint: ['KeyH'] });
  assert.deepEqual(b, { claim: ['KeyX'], hint: ['KeyH'] });
  assert.equal(p.inviteLink(), `https://dashboard.starhermit.com/game-invite/${USER}/${SLUG}`);
  assert.equal(p.canSignIn(), false);
});

test('standalone: no token means no fetch at all, local defaults everywhere', async () => {
  const fp = fakePlatform();
  const win = fakeWindow('http://localhost:8080/index.html');
  const sh = loadSdk().create({ window: win, fetch: fp.fetch });
  const p = createPlatform({ sh, fetch: fp.fetch });
  assert.equal(p.hosted, false);
  assert.equal(await p.loadProfile(), null);
  assert.equal(await p.loadCloud(), null);
  assert.deepEqual(await p.loadSettings(), {});
  assert.deepEqual(await p.loadBindings({ claim: ['KeyC'] }), { claim: ['KeyC'] });
  p.pushCloud({ version: 1 });
  p.primeSettings({});
  p.pushSettings({ theme: 'plum' });
  await p.flushCloud();
  assert.equal(p.canSignIn(), false);
  assert.equal(p.inviteLink(), null);
  assert.equal(fp.calls.length, 0);
  assert.equal(p.syncStatus, 'offline');
});

test('sign-in is offered on the platform host without a token', () => {
  const fp = fakePlatform();
  const sh = loadSdk().create({ window: fakeWindow(`https://${SLUG}.starhermit.com/`), fetch: fp.fetch });
  const p = createPlatform({ sh, fetch: fp.fetch });
  assert.equal(p.hosted, false);
  assert.equal(p.canSignIn(), true);
  assert.equal(fp.calls.length, 0);
});
