'use strict';

// StarHermit platform adapter: launch token, account profile, cloud save.
// Hosted mode activates iff a launch token was read from the URL fragment.
// All platform calls are same-origin /api/v1 with `Authorization: Bearer`.
// Everything here is DOM-free (deps are injectable) so node tests can drive it.

// ---------------------------------------------------------------- zip (stored)
// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

// ---------------------------------------------------------------- token
// base64url JWT payload decode (no signature verification — the platform
// minted the token and the API is the only thing that trusts it).
function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)));
    return json && typeof json === 'object' ? json : null;
  } catch (_) { return null; }
}

// Read `#game_token=<jwt>` (&session_id=…) once, then strip the fragment.
// Query fallbacks (?token= / ?launch= / ?launch_token=) are local-dev only.
function readLaunchToken(loc, hist) {
  const stripFragment = () => {
    try {
      const url = loc.href.split('#')[0];
      hist.replaceState(null, '', url);
    } catch (_) { /* history unavailable: token simply stays in the URL */ }
  };
  const hash = (loc.hash || '').replace(/^#/, '');
  const params = new URLSearchParams(hash);
  const frag = params.get('game_token');
  if (frag) { stripFragment(); return { token: frag, via: 'fragment' }; }
  const query = new URLSearchParams(loc.search || '');
  for (const key of ['game_token', 'token', 'launch', 'launch_token']) {
    const q = query.get(key);
    if (q) return { token: q, via: 'query' };
  }
  return null;
}

const REFRESH_MS = 45 * 60 * 1000; // re-mint 15 min before the 60 min expiry
const REFRESH_RETRY_MS = 60 * 1000;
const CLOUD_DEBOUNCE_MS = 2000;

// deps (all optional): {location, history, fetch, btoa, atob, setTimeout,
// clearTimeout, onPageHide} — defaults come from globalThis at call time.
export function createPlatform(deps = {}) {
  const g = (name) => (deps[name] !== undefined ? deps[name] : globalThis[name]);
  const loc = deps.location !== undefined ? deps.location : globalThis.location;

  const launch = loc ? readLaunchToken(loc, deps.history !== undefined ? deps.history : globalThis.history) : null;
  const claims = launch ? decodeJwtPayload(launch.token) : null;
  const hosted = !!(launch && claims && claims.sub);
  const slug = claims && claims.game_scope ? String(claims.game_scope) : null;
  const sub = claims && claims.sub ? String(claims.sub) : null;

  const platform = {
    hosted, token: launch ? launch.token : null,
    slug, sub,
    tokenVia: launch ? launch.via : null,
    nickname: null, // filled by loadProfile()
    syncStatus: hosted ? 'synced' : 'offline',
  };

  async function api(path, opts = {}) {
    if (!platform.hosted) throw new Error('platform: not hosted');
    const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
    if (platform.token) headers.authorization = 'Bearer ' + platform.token;
    const r = await g('fetch')(path, { ...opts, headers });
    return r;
  }

  // Launch tokens live 60 min; re-mint scoped tokens via the game route.
  let refreshTimer = null;
  async function refreshToken() {
    if (!platform.hosted) return;
    try {
      const r = await api(`/api/v1/games/${encodeURIComponent(platform.slug)}/launch-token`, {
        method: 'POST', body: '{}',
      });
      if (!r.ok) throw new Error('refresh failed: ' + r.status);
      const j = await r.json().catch(() => null);
      if (!j || !(j.token || j.launchToken)) throw new Error('refresh missing token');
      platform.token = j.token || j.launchToken;
    } catch (_) {
      refreshTimer = g('setTimeout')(refreshToken, REFRESH_RETRY_MS);
      return;
    }
    scheduleRefresh();
  }
  function scheduleRefresh() {
    if (refreshTimer) g('clearTimeout')(refreshTimer);
    refreshTimer = g('setTimeout')(refreshToken, REFRESH_MS);
  }

  // Account nickname via the public profile route. NEVER /api/v1/me,
  // never usernames. Fallback: "Player " + id.slice(0, 8).
  const profileCache = new Map();
  async function profileFor(userId) {
    if (profileCache.has(userId)) return profileCache.get(userId);
    const fallback = 'Player ' + String(userId).slice(0, 8);
    let out = { id: userId, nickname: fallback };
    try {
      const r = await api(`/api/v1/users/${encodeURIComponent(userId)}/profile`);
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j) {
          // display NICKNAME only; never fall back to the username
          out = { id: userId, nickname: (typeof j.nickname === 'string' && j.nickname) ? j.nickname : fallback };
        }
      }
    } catch (_) { /* offline / 404: fallback name */ }
    profileCache.set(userId, out);
    return out;
  }
  async function loadProfile() {
    if (!platform.hosted || !platform.sub) return null;
    const p = await profileFor(platform.sub);
    platform.nickname = p.nickname;
    return p.nickname;
  }

  // ------------------------------------------------------------ cloud save
  // ONE slot at /api/v1/me/cloud-saves/{slug}, zip+base64. localStorage stays
  // the offline cache; the cloud slot is a mirror, remote wins on conflict.
  let cloudTimer = null;
  let cloudPending = null;
  const syncListeners = new Set();
  function onSync(fn) { syncListeners.add(fn); }
  function setSync(status) {
    platform.syncStatus = status;
    for (const fn of syncListeners) { try { fn(status); } catch (_) {} }
  }

  function encodeSaveDoc(doc) {
    return bytesToBase64(zipStore('save.json', new TextEncoder().encode(JSON.stringify(doc))));
  }
  function decodeSaveDoc(base64) {
    const bytes = base64ToBytes(base64);
    const json = new TextDecoder().decode(unzipFirstEntry(bytes));
    return JSON.parse(json);
  }

  async function pushCloud(doc) {
    if (!platform.hosted || !platform.slug) return;
    cloudPending = doc;
    if (cloudTimer) g('clearTimeout')(cloudTimer);
    cloudTimer = g('setTimeout')(async () => {
      cloudTimer = null;
      const payload = cloudPending;
      cloudPending = null;
      if (!payload) return;
      setSync('saving');
      try {
        const r = await api(`/api/v1/me/cloud-saves/${encodeURIComponent(platform.slug)}`, {
          method: 'PUT',
          body: JSON.stringify({ dataBase64: encodeSaveDoc(payload) }),
        });
        setSync(r.ok ? 'synced' : 'error');
      } catch (_) { setSync('error'); }
    }, CLOUD_DEBOUNCE_MS);
  }

  async function flushCloud() {
    if (!cloudTimer) return;
    g('clearTimeout')(cloudTimer);
    cloudTimer = null;
    const payload = cloudPending;
    cloudPending = null;
    if (!payload || !platform.hosted || !platform.slug) return;
    setSync('saving');
    try {
      const r = await api(`/api/v1/me/cloud-saves/${encodeURIComponent(platform.slug)}`, {
        method: 'PUT',
        body: JSON.stringify({ dataBase64: encodeSaveDoc(payload) }),
      });
      setSync(r.ok ? 'synced' : 'error');
    } catch (_) { setSync('error'); }
  }

  // Remote-preferred load: 404 = no save; a corrupt remote never clobbers local.
  async function loadCloud() {
    if (!platform.hosted || !platform.slug) return null;
    try {
      const r = await api(`/api/v1/me/cloud-saves/${encodeURIComponent(platform.slug)}`);
      if (r.status === 404) return null;
      if (!r.ok) return null;
      const ct = (r.headers && r.headers.get && r.headers.get('content-type')) || '';
      if (ct.includes('application/zip')) {
        const buf = new Uint8Array(await r.arrayBuffer());
        return JSON.parse(new TextDecoder().decode(unzipFirstEntry(buf)));
      }
      const j = await r.json().catch(() => null);
      if (j && j.dataBase64) return decodeSaveDoc(j.dataBase64);
      return null;
    } catch (_) { return null; }
  }

  platform.api = api;
  platform.profileFor = profileFor;
  platform.loadProfile = loadProfile;
  platform.pushCloud = pushCloud;
  platform.loadCloud = loadCloud;
  platform.flushCloud = flushCloud;
  platform.onSync = onSync;
  platform.encodeSaveDoc = encodeSaveDoc;
  platform.decodeSaveDoc = decodeSaveDoc;
  platform._refreshToken = refreshToken;
  platform._scheduleRefresh = scheduleRefresh;

  if (platform.hosted) {
    scheduleRefresh();
    const attach = deps.onPageHide;
    if (typeof attach === 'function') attach(() => { platform.flushCloud(); });
  }
  return platform;
}

export const _internals = { zipStore, unzipFirstEntry, bytesToBase64, base64ToBytes, decodeJwtPayload, readLaunchToken, crc32 };
