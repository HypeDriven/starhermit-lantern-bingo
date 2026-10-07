'use strict';

// StarHermit platform adapter over the shared SDK (window.StarHermit, loaded
// from starhermit-sdk.js before this module). The SDK owns the launch token,
// renewal, profile lookup and the game:<slug> cloud-save slot; this adapter
// keeps the game's existing API (hosted, nickname, syncStatus, pushCloud …)
// and adds settings mirroring, key bindings, sign-in and invite links.
// Without a token nothing here touches the network.

const SETTINGS_DEBOUNCE_MS = 1500;

// deps (all optional): {sh} SDK instance (default globalThis.StarHermit),
// {fetch} for the Response-style api() used by the realtime-rooms client,
// {onPageHide(fn)}, {setTimeout, clearTimeout}.
export function createPlatform(deps = {}) {
  const sh = deps.sh || globalThis.StarHermit;
  const g = (name) => (deps[name] !== undefined ? deps[name] : globalThis[name]);
  sh.init();

  const syncListeners = new Set();
  const authListeners = new Set();
  const platform = {
    get hosted() { return !!sh.signedIn; },
    get token() { return sh.token; },
    get slug() { return sh.slug; },
    get sub() { return sh.userId; },
    get launchSessionId() { return sh.launchSessionId; },
    nickname: null, // filled by loadProfile()
    syncStatus: sh.signedIn ? 'synced' : 'offline',
  };

  function setSync(status) {
    platform.syncStatus = status;
    for (const fn of syncListeners) { try { fn(status); } catch (_) {} }
  }
  sh.on('saved', (ok) => setSync(ok ? 'synced' : 'error'));
  sh.on('auth', (a) => {
    if (!a.signedIn) { platform.nickname = null; setSync('offline'); }
    for (const fn of authListeners) { try { fn(a); } catch (_) {} }
  });

  // Response-returning Bearer fetch for the realtime-rooms lobby (hallnet.js
  // reads status codes itself). One renewal + retry on 401.
  async function api(path, opts = {}) {
    if (!sh.token) throw new Error('platform: not hosted');
    const send = () => g('fetch')(sh.base + path, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}), authorization: 'Bearer ' + sh.token },
    });
    let r = await send();
    if (r.status === 401 && await sh.refresh()) r = await send();
    return r;
  }

  async function profileFor(userId) {
    const p = await sh.profile(userId);
    return p ? { id: p.userId, nickname: p.displayName } : { id: userId, nickname: 'Player ' + String(userId).slice(0, 6) };
  }
  async function loadProfile() {
    if (!sh.signedIn) return null;
    const p = await sh.profile();
    platform.nickname = p ? p.displayName : null;
    return platform.nickname;
  }

  // ------------------------------------------------------------ cloud save
  function pushCloud(doc) {
    if (!sh.signedIn) return;
    setSync('saving');
    sh.saveJSON(doc);
  }
  function flushCloud() { return sh.signedIn ? sh.flushSave(true) : Promise.resolve(false); }
  function loadCloud() { return sh.signedIn ? sh.loadJSON() : Promise.resolve(null); }

  // ------------------------------------------------------------ settings KV
  let settingsTimer = null;
  let lastSettings = null;
  let pendingPatch = null;
  function flushSettings() {
    if (settingsTimer) { g('clearTimeout')(settingsTimer); settingsTimer = null; }
    if (!pendingPatch) return Promise.resolve(null);
    const p = pendingPatch; pendingPatch = null;
    return sh.patchSettings(p);
  }
  // Mirror changed top-level preference keys (debounced PATCH).
  function pushSettings(settings) {
    if (!sh.signedIn || lastSettings === null) return; // not primed yet: platform values still loading
    const json = JSON.stringify(settings);
    if (json === lastSettings) return;
    const prev = lastSettings ? JSON.parse(lastSettings) : {};
    lastSettings = json;
    pendingPatch = pendingPatch || {};
    for (const k of Object.keys(settings)) {
      if (JSON.stringify(settings[k]) !== JSON.stringify(prev[k])) pendingPatch[k] = settings[k];
    }
    if (settingsTimer) g('clearTimeout')(settingsTimer);
    settingsTimer = g('setTimeout')(flushSettings, SETTINGS_DEBOUNCE_MS);
  }
  async function loadSettings() {
    if (!sh.signedIn) return {};
    return (await sh.getSettings()) || {};
  }
  // Seed the change detector so the first local save only sends real changes.
  function primeSettings(settings) { lastSettings = JSON.stringify(settings); }

  platform.api = api;
  platform.profileFor = profileFor;
  platform.loadProfile = loadProfile;
  platform.pushCloud = pushCloud;
  platform.loadCloud = loadCloud;
  platform.flushCloud = flushCloud;
  platform.onSync = (fn) => syncListeners.add(fn);
  platform.onAuth = (fn) => authListeners.add(fn);
  platform.pushSettings = pushSettings;
  platform.loadSettings = loadSettings;
  platform.primeSettings = primeSettings;
  platform.flushSettings = flushSettings;
  platform.loadBindings = (defaults) => (sh.signedIn ? sh.loadBindings(defaults) : Promise.resolve(defaults));
  platform.canSignIn = () => sh.canSignIn();
  platform.signIn = () => sh.signIn();
  // Socket reconnects: renew first ('renewed' | 'retry' | 'relaunch'); relaunch()
  // must run from a click (top-window navigation needs a user gesture).
  platform.renewForReconnect = () => sh.renewForReconnect();
  platform.relaunch = () => sh.relaunch();
  platform.inviteLink = () => (sh.signedIn ? sh.inviteLink() : null);

  const attach = deps.onPageHide;
  if (typeof attach === 'function') attach(() => { platform.flushCloud(); flushSettings(); });
  return platform;
}
