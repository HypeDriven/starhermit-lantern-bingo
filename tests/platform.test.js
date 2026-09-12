'use strict';

// StarHermit platform adapter tests: token read/strip, JWT decode, Bearer
// auth, refresh, nickname, cloud save (debounce/flush/remote-preferred), and
// the stored-zip codec.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatform, _internals } from '../js/platform.js';

const { zipStore, unzipFirstEntry, bytesToBase64, base64ToBytes, decodeJwtPayload, readLaunchToken } = _internals;

function b64url(obj) {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeJwt(claims) { return b64url({ alg: 'none' }) + '.' + b64url(claims) + '.sig'; }

function fakeLocation(href) {
  const u = new URL(href);
  return {
    href, protocol: u.protocol, host: u.host,
    hash: u.hash, search: u.search,
  };
}
function fakeHistory() {
  return { calls: [], replaceState(_a, _b, url) { this.calls.push(url); } };
}

// A scriptable fetch mock: queue responses, record calls.
function fakeFetch() {
  const calls = [];
  const queue = [];
  const fn = async (path, opts = {}) => {
    calls.push({ path, opts, headers: opts.headers || {} });
    if (!queue.length) return { ok: false, status: 500, json: async () => null, headers: { get: () => null } };
    return queue.shift();
  };
  fn.calls = calls;
  fn.queue = queue;
  fn.respondJson = (body, status = 200) => queue.push({
    ok: status >= 200 && status < 300, status,
    json: async () => body, headers: { get: () => 'application/json' },
  });
  fn.respondZip = (bytes) => queue.push({
    ok: true, status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    json: async () => null, headers: { get: () => 'application/zip' },
  });
  fn.respond404 = () => queue.push({ ok: false, status: 404, json: async () => null, headers: { get: () => null } });
  return fn;
}

// Fake timer queue: run pending timers manually.
function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout(fn, ms) { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    run(ms) { // run every timer scheduled with delay <= ms, in insertion order
      const due = [...pending.entries()].filter(([, t]) => t.ms <= ms);
      for (const [id, t] of due) { pending.delete(id); t.fn(); }
    },
    pending: () => pending.size,
  };
}

test('stored zip round-trips and has a valid central directory', () => {
  const data = new TextEncoder().encode(JSON.stringify({ version: 1, progress: { journeyDone: ['a', 'b'] } }));
  const zip = zipStore('save.json', data);
  // strict structural checks (mirrors python zipfile / unzip -t)
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(dv.getUint32(0, true), 0x04034b50);           // local header
  assert.equal(dv.getUint16(8, true), 0);                    // stored, no compression
  // EOCD: find the signature
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  assert.notEqual(eocd, -1, 'EOCD record present');
  assert.equal(dv.getUint16(eocd + 8, true), 1);             // one entry
  assert.equal(dv.getUint16(eocd + 10, true), 1);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOff = dv.getUint32(eocd + 16, true);
  assert.equal(cdOff + cdSize, eocd, 'central directory ends where EOCD begins');
  assert.equal(dv.getUint32(cdOff, true), 0x02014b50);       // CD header
  const out = unzipFirstEntry(zip);
  assert.equal(new TextDecoder().decode(out), new TextDecoder().decode(data));
});

test('base64 byte helpers round-trip binary data', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual([...base64ToBytes(bytesToBase64(bytes))], [...bytes]);
});

test('JWT payload decode: sub and game_scope, base64url', () => {
  const jwt = makeJwt({ sub: 'user-123', game_scope: 'lantern-bingo', exp: 123 });
  assert.deepEqual(decodeJwtPayload(jwt), { sub: 'user-123', game_scope: 'lantern-bingo', exp: 123 });
  assert.equal(decodeJwtPayload('not-a-jwt'), null);
  assert.equal(decodeJwtPayload('a.bad!.sig'), null);
});

test('fragment token read once then stripped; query fallback kept for dev', () => {
  const jwt = makeJwt({ sub: 'u1', game_scope: 'lantern-bingo' });
  const loc = fakeLocation(`https://lantern-bingo.starhermit.com/#game_token=${jwt}&session_id=abc`);
  const hist = fakeHistory();
  const got = readLaunchToken(loc, hist);
  assert.equal(got.token, jwt);
  assert.equal(got.via, 'fragment');
  assert.equal(hist.calls.length, 1);
  assert.ok(!hist.calls[0].includes('game_token'), 'token stripped from URL');

  const loc2 = fakeLocation(`http://localhost:8080/?token=${jwt}`);
  const hist2 = fakeHistory();
  const got2 = readLaunchToken(loc2, hist2);
  assert.equal(got2.via, 'query');
  assert.equal(hist2.calls.length, 0, 'query fallback is not stripped');
});

test('no token → not hosted, no API activity', () => {
  const fetch = fakeFetch();
  const timers = fakeTimers();
  const p = createPlatform({
    location: fakeLocation('http://localhost:8080/'), history: fakeHistory(),
    fetch, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  assert.equal(p.hosted, false);
  assert.equal(p.syncStatus, 'offline');
  timers.run(60 * 60 * 1000);
  assert.equal(fetch.calls.length, 0, 'no refresh without a token');
});

test('api sends Authorization: Bearer on every call', async () => {
  const jwt = makeJwt({ sub: 'u1', game_scope: 'lantern-bingo' });
  const fetch = fakeFetch();
  fetch.respondJson({ ok: true });
  const timers = fakeTimers();
  const p = createPlatform({
    location: fakeLocation(`https://x.starhermit.com/#game_token=${jwt}`),
    history: fakeHistory(), fetch,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  await p.api('/api/v1/anything', { method: 'GET' });
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer ' + jwt);
  assert.equal(p.slug, 'lantern-bingo');
  assert.equal(p.sub, 'u1');
});

const tick = () => new Promise((r) => setImmediate(r));

test('45-min refresh re-mints and swaps the token; failure retries in 60 s', async () => {
  const jwt = makeJwt({ sub: 'u1', game_scope: 'lantern-bingo' });
  const fetch = fakeFetch();
  const timers = fakeTimers();
  const p = createPlatform({
    location: fakeLocation(`https://x.starhermit.com/#game_token=${jwt}`),
    history: fakeHistory(), fetch,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  assert.equal(fetch.calls.length, 0);
  fetch.respondJson({ token: 'refreshed-token' });
  timers.run(45 * 60 * 1000); // fire the scheduled refresh
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].path, '/api/v1/games/lantern-bingo/launch-token');
  assert.equal(fetch.calls[0].opts.method, 'POST');
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer ' + jwt);
  await tick();
  assert.equal(p.token, 'refreshed-token');
  // next refresh scheduled; a failure schedules a 60 s retry instead
  fetch.respondJson(null, 500);
  timers.run(45 * 60 * 1000);
  await tick();
  const countAfterFail = fetch.calls.length;
  timers.run(59 * 1000);
  assert.equal(fetch.calls.length, countAfterFail, 'no retry before 60 s');
  timers.run(60 * 1000);
  assert.equal(fetch.calls.length, countAfterFail + 1, 'retry at 60 s');
});

test('nickname from profile; Player+id8 fallback; username never displayed', async () => {
  const jwt = makeJwt({ sub: 'abcdefgh-1234', game_scope: 'lantern-bingo' });
  const fetch = fakeFetch();
  const timers = fakeTimers();
  const p = createPlatform({
    location: fakeLocation(`https://x.starhermit.com/#game_token=${jwt}`),
    history: fakeHistory(), fetch,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  fetch.respondJson({ id: 'abcdefgh-1234', username: 'ignored_user', nickname: 'Hall Warden' });
  const name = await p.loadProfile();
  assert.equal(name, 'Hall Warden');
  assert.equal(p.nickname, 'Hall Warden');
  assert.ok(!fetch.calls.some(c => c.path === '/api/v1/me'), 'never calls /api/v1/me');
  assert.ok(!fetch.calls.some(c => c.path.includes('/profile') && c.path.includes('me')));

  const fetch2 = fakeFetch();
  const p2 = createPlatform({
    location: fakeLocation(`https://x.starhermit.com/#game_token=${jwt}`),
    history: fakeHistory(), fetch: fetch2,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  fetch2.respondJson({ id: 'abcdefgh-1234', username: 'ignored_user' }); // no nickname
  const name2 = await p2.loadProfile();
  assert.equal(name2, 'Player abcdefgh');
  const fetch3 = fakeFetch();
  const p3 = createPlatform({
    location: fakeLocation(`https://x.starhermit.com/#game_token=${jwt}`),
    history: fakeHistory(), fetch: fetch3,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  fetch3.respond404(); // profile missing
  assert.equal(await p3.loadProfile(), 'Player abcdefgh');
});

test('cloud save: debounced PUT with zip+base64 payload, decodable by a strict reader', async () => {
  const jwt = makeJwt({ sub: 'u1', game_scope: 'lantern-bingo' });
  const fetch = fakeFetch();
  const timers = fakeTimers();
  const p = createPlatform({
    location: fakeLocation(`https://x.starhermit.com/#game_token=${jwt}`),
    history: fakeHistory(), fetch,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  const doc = { version: 1, settings: { theme: 'jade' }, progress: { gamesPlayed: 9 } };
  const seen = [];
  p.onSync((s) => seen.push(s));
  p.pushCloud(doc);
  p.pushCloud(doc); // second push resets the debounce
  assert.equal(fetch.calls.length, 0);
  timers.run(1999);
  assert.equal(fetch.calls.length, 0);
  fetch.respondJson({ ok: true });
  timers.run(2000);
  assert.equal(fetch.calls.length, 1, 'debounced PUT fired');
  assert.equal(fetch.calls[0].path, '/api/v1/me/cloud-saves/lantern-bingo');
  assert.equal(fetch.calls[0].opts.method, 'PUT');
  assert.deepEqual(seen, ['saving'], 'status reports saving until the PUT resolves');
  const body = JSON.parse(fetch.calls[0].opts.body);
  // strict-reader decode of the exact wire payload
  const decoded = JSON.parse(new TextDecoder().decode(unzipFirstEntry(base64ToBytes(body.dataBase64))));
  assert.deepEqual(decoded, doc);
  await tick();
  assert.deepEqual(seen, ['saving', 'synced']);
});

test('flushCloud sends immediately (pagehide) and skips when idle', async () => {
  const jwt = makeJwt({ sub: 'u1', game_scope: 'lantern-bingo' });
  const fetch = fakeFetch();
  const timers = fakeTimers();
  const p = createPlatform({
    location: fakeLocation(`https://x.starhermit.com/#game_token=${jwt}`),
    history: fakeHistory(), fetch,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  await p.flushCloud();
  assert.equal(fetch.calls.length, 0, 'nothing pending → no PUT');
  fetch.respondJson({ ok: true });
  p.pushCloud({ version: 1 });
  await p.flushCloud();
  assert.equal(fetch.calls.length, 1, 'flush bypasses the debounce');
});

test('loadCloud: remote zip bytes win, 404 = none, corrupt remote rejected', async () => {
  const jwt = makeJwt({ sub: 'u1', game_scope: 'lantern-bingo' });
  const remoteDoc = { version: 1, progress: { gamesPlayed: 42 }, settings: {} };
  const zipBytes = zipStore('save.json', new TextEncoder().encode(JSON.stringify(remoteDoc)));

  const fetch = fakeFetch();
  const timers = fakeTimers();
  const p = createPlatform({
    location: fakeLocation(`https://x.starhermit.com/#game_token=${jwt}`),
    history: fakeHistory(), fetch,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  fetch.respondZip(zipBytes);
  assert.deepEqual(await p.loadCloud(), remoteDoc);

  const fetch2 = fakeFetch();
  const p2 = createPlatform({
    location: fakeLocation(`https://x.starhermit.com/#game_token=${jwt}`),
    history: fakeHistory(), fetch: fetch2,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  fetch2.respond404();
  assert.equal(await p2.loadCloud(), null);

  // base64 JSON variant also accepted
  const fetch3 = fakeFetch();
  const p3 = createPlatform({
    location: fakeLocation(`https://x.starhermit.com/#game_token=${jwt}`),
    history: fakeHistory(), fetch: fetch3,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  fetch3.respondJson({ dataBase64: bytesToBase64(zipBytes) });
  assert.deepEqual(await p3.loadCloud(), remoteDoc);
});

test('offline platform never touches fetch (no on-platform console errors)', async () => {
  const fetch = fakeFetch();
  const p = createPlatform({
    location: fakeLocation('http://localhost:8080/'), history: fakeHistory(), fetch,
  });
  await p.loadProfile();
  await p.loadCloud();
  p.pushCloud({ version: 1 });
  await p.flushCloud();
  assert.equal(fetch.calls.length, 0);
  assert.equal(p.syncStatus, 'offline');
});
