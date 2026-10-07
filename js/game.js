'use strict';

// Lantern Bingo — client bootstrap, render, and UI modules.
// Rendering consumes immutable rules snapshots; all state changes go through
// Session.dispatch (local) or the hosted WebSocket (authoritative server).

import * as THREE from './three.module.js';
import {
  GRID, CELLS, CENTER, PATTERNS, countLines, patternComplete,
  serialize as serializeState, deserialize as deserializeState, hashState,
} from './rules.js';
import { Session } from './session.js';
import {
  JOURNEY_STAGES, CHALLENGES, LESSONS, THEMES, dailyFor, CONTENT_VERSION,
} from './content.js';
import { AudioEngine } from './audio.js';
import { createPlatform } from './platform.js';
import { RoomsClient, HallHost } from './hallnet.js';
import {
  PRESETS, CATEGORIES, SHADOW_MAP, LANTERN_COUNT, detectPreset, resolve, presetTier, choosePreset, describe,
} from './gfx.js';
import { GFX_STRINGS, pickLocale } from './gfx-strings.js';
import { TitleFx } from './title-fx.js';
import { shStrings } from './sh-strings.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------------------------------------------------------------- platform
// StarHermit hosted mode: active iff a launch token was read from the URL
// fragment. Same-origin /api/v1 calls only; the cloud slot mirrors the
// localStorage save (which stays the offline cache).
const platform = createPlatform({
  onPageHide: (fn) => window.addEventListener('pagehide', fn),
});
platform.onSync(() => refreshAccountLine());
const shT = shStrings(navigator.languages || [navigator.language]);

// ---------------------------------------------------------------- persistence
const SAVE_KEY = 'lantern-bingo-v1';

function checksum(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

const defaultSave = () => ({
  version: 1,
  settings: {
    volumes: { music: 0.5, effects: 0.8, ambience: 0.4, voice: 0.7 },
    muted: false, theme: 'ember',
    graphics: { preset: 'auto' },
    reducedMotion: window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    highContrast: false, largeText: false, leftHanded: false,
    callSpeed: 5000, autoHint: true,
  },
  progress: {
    journeyDone: [], lessonsDone: [], bestScores: {}, dailyHistory: {},
    streakDays: [], achievements: {}, gamesPlayed: 0,
  },
});

const store = {
  data: defaultSave(),
  cloudHold: false, cloudHeld: false,
  load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      const o = JSON.parse(raw);
      if (checksum(o.payload) !== o.checksum) return; // corrupt — start clean, never crash
      const parsed = JSON.parse(o.payload);
      if (parsed.version === 1) {
        this.data = { ...defaultSave(), ...parsed,
          settings: { ...defaultSave().settings, ...parsed.settings },
          progress: { ...defaultSave().progress, ...parsed.progress } };
      }
    } catch (_) { /* corrupted storage: fall back to defaults */ }
  },
  _writeLocal() {
    const payload = JSON.stringify(this.data);
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ payload, checksum: checksum(payload) })); } catch (_) {}
  },
  save() {
    this._writeLocal();
    if (platform.hosted) {
      // Held during the boot cloud load: a doc queued then would still be PUT
      // after the remote one is adopted, over the newer cloud save.
      if (this.cloudHold) this.cloudHeld = true;
      else platform.pushCloud(this.data); // debounced mirror
      platform.pushSettings(this.data.settings); // per-player settings KV (changed keys only)
    }
  },
  // Remote-preferred cloud load: a valid remote doc replaces local data and
  // is re-written to localStorage so the cache always mirrors the cloud.
  // Platform settings KV wins over the local/cloud-save copy, key by key.
  adoptSettings(remote) {
    const s = this.data.settings;
    let changed = false;
    for (const k of Object.keys(defaultSave().settings)) {
      if (remote && remote[k] !== undefined && remote[k] !== null) { s[k] = remote[k]; changed = true; }
    }
    if (changed) this._writeLocal();
    return changed;
  },
  adoptRemote(remote) {
    if (!remote || remote.version !== 1) return false;
    this.data = { ...defaultSave(), ...remote,
      settings: { ...defaultSave().settings, ...remote.settings },
      progress: { ...defaultSave().progress, ...remote.progress } };
    this._writeLocal();
    return true;
  },
};

// ---------------------------------------------------------------- achievements
const ACHIEVEMENTS = {
  first_win:     { name: 'First Light',    desc: 'Win your first round.' },
  line_master:   { name: 'Line Keeper',    desc: 'Complete 50 lines across all rounds.' },
  streak_3:      { name: 'Steady Flame',   desc: 'Win 3 rounds in a row.' },
  full_lantern:  { name: 'Full Lantern',   desc: 'Win a Full Lantern (blackout) round.' },
  long_road:     { name: 'Long Road',      desc: 'Complete every Journey stage.' },
};

const achievementCtx = { linesTotal: 0, winStreak: 0 };
function unlock(key) {
  if (store.data.progress.achievements[key]) return null;
  store.data.progress.achievements[key] = new Date().toISOString();
  store.save();
  return ACHIEVEMENTS[key];
}

// ---------------------------------------------------------------- audio
const audio = new AudioEngine(20260829);
audio.onCaption((text) => { $('#captions').textContent = '♪ ' + text; });

function applyAudioSettings() {
  const s = store.data.settings;
  for (const k of Object.keys(s.volumes)) audio.setVolume(k, s.volumes[k]);
  audio.setMuted(s.muted);
}

// ---------------------------------------------------------------- graphics quality
// Pure model in gfx.js; this section probes the GPU once, owns the adaptive scale and the
// frame-rate meter, and applies the resolved tiers to the hall, the title and the DOM card.
const gfxEnv = (() => {
  let gpu = '';
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }
  } catch (_) { gpu = ''; }
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches &&
    !window.matchMedia('(any-pointer: fine)').matches;
  const mobile = coarse || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '');
  return { gpu, mobile, detected: detectPreset(gpu, { mobile }) };
})();

const gfxRuntime = { adaptiveScale: 1, frames: [], fps: 0, postFailed: false };

function currentGfx() {
  return resolve(store.data.settings.graphics, gfxEnv.detected);
}

/** Device pixel ratio for a resolved setting: min(dpr, preset cap) × render scale × adaptive. */
function gfxPixelRatio(g) {
  return Math.min(window.devicePixelRatio || 1, g.dprCap) * g.scale * gfxRuntime.adaptiveScale;
}

function fpsMeter(on) {
  let el = document.getElementById('fps-meter');
  if (on && !el) {
    el = document.createElement('div');
    el.id = 'fps-meter';
    el.setAttribute('aria-hidden', 'true');
    document.body.append(el);
  }
  if (el) el.hidden = !on;
}

// Adaptive resolution: average ~90 frames; step down 0.1 (min 0.6) when slow, up 0.05 when fast.
function gfxFrame(dtMs) {
  const f = gfxRuntime.frames;
  f.push(dtMs);
  if (f.length < 90) return false;
  const avg = f.reduce((a, b) => a + b, 0) / f.length;
  f.length = 0;
  gfxRuntime.fps = 1000 / avg;
  const g = currentGfx();
  const el = document.getElementById('fps-meter');
  if (el && !el.hidden) el.textContent = `${Math.round(gfxRuntime.fps)} fps · ${Math.round(gfxPixelRatio(g) * 100) / 100}×`;
  if (!g.adaptive) return false;
  const before = gfxRuntime.adaptiveScale;
  if (avg > 26) gfxRuntime.adaptiveScale = Math.max(0.6, before - 0.1);
  else if (avg < 14 && before < 1) gfxRuntime.adaptiveScale = Math.min(1, before + 0.05);
  return before !== gfxRuntime.adaptiveScale;
}

let hallPost = null;        // the loaded hall-post.js module
let hallPostLoading = null;
function loadHallPost() {
  if (hallPost || gfxRuntime.postFailed) return Promise.resolve(hallPost);
  if (!hallPostLoading) {
    hallPostLoading = import('./hall-post.js')
      .then((m) => { hallPost = m; return m; })
      .catch(() => { gfxRuntime.postFailed = true; refreshGfxPanel(); return null; });
  }
  return hallPostLoading;
}

// ---------------------------------------------------------------- renderer
// Procedural floor texture: lacquered boards in concentric rings with grain (greyscale, so the
// theme's floor colour still tints it).
function makeFloorTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d');
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  ctx.fillStyle = '#d8d8d8';
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 1400; i++) { // grain streaks
    const x = rnd() * 512, y = rnd() * 512, l = 20 + rnd() * 90, v = 190 + Math.floor(rnd() * 60);
    ctx.strokeStyle = `rgba(${v},${v},${v},0.35)`;
    ctx.lineWidth = 0.6 + rnd() * 1.4;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + l, y + (rnd() - 0.5) * 3); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(40,40,40,0.55)';
  ctx.lineWidth = 2;
  for (let y = 0; y <= 512; y += 64) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(512, y); ctx.stroke(); }
  for (let row = 0; row < 8; row++) {
    const off = (row % 2) * 128;
    for (let x = off; x <= 512; x += 256) { ctx.beginPath(); ctx.moveTo(x, row * 64); ctx.lineTo(x, row * 64 + 64); ctx.stroke(); }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.anisotropy = 4;
  return tex;
}

// Rounded, bevelled card tile (lies flat, top face at y = 0.08).
function makeTileGeometry() {
  const s = 0.29, r = 0.08;
  const sh = new THREE.Shape();
  sh.moveTo(-s + r, -s); sh.lineTo(s - r, -s); sh.quadraticCurveTo(s, -s, s, -s + r);
  sh.lineTo(s, s - r); sh.quadraticCurveTo(s, s, s - r, s); sh.lineTo(-s + r, s);
  sh.quadraticCurveTo(-s, s, -s, s - r); sh.lineTo(-s, -s + r); sh.quadraticCurveTo(-s, -s, -s + r, -s);
  const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.04, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2, curveSegments: 4 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0.02, 0);
  return geo;
}

// Paper lantern profile (lathe) — ribbed silhouette for the detailed tier.
function makeLanternGeometry() {
  const pts = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12, y = (t - 0.5) * 0.7;
    const rib = 1 + 0.035 * Math.cos(t * Math.PI * 12);
    pts.push(new THREE.Vector2(Math.max(0.06, Math.sin(t * Math.PI) * 0.3 * rib + 0.06 * (1 - Math.sin(t * Math.PI))), y));
  }
  return new THREE.LatheGeometry(pts, 16);
}

class HallRenderer {
  constructor(holder) {
    this.holder = holder;
    this.ok = false;
    this.cells = [];
    this.lanterns = null;
    this.onCellPick = null;
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this.g = currentGfx();
    this.size = [0, 0];
    this.pixelRatio = 0;
    this.composer = null;
    this.postKey = null;
    this._build();
  }

  // (Re)create the WebGL renderer. Canvas MSAA is fixed at context creation, so switching it
  // swaps the renderer; the scene and its objects are kept.
  _makeGL() {
    const aa = this.g.antialias === 'msaa' && !this.g.post;
    if (this.renderer && this._glAA === aa) return true;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: aa, powerPreference: 'default' });
    } catch (e) {
      if (!this.renderer) this._fail('3D graphics are unavailable in this browser. The card below remains fully playable.');
      return !!this.renderer;
    }
    if (this.renderer) {
      this._swapping = true;
      this._disposePost();
      if (this.envMap) { this.envMap.dispose(); this.envMap = null; this.scene.environment = null; }
      this.renderer.dispose();
      this.renderer.domElement.remove();
      this._swapping = false;
    }
    this._glAA = aa;
    this.renderer = renderer;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.holder.appendChild(renderer.domElement);
    renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (this._swapping || renderer !== this.renderer) return;
      this._fail('Graphics context was lost. Reload the page to restore the 3D hall — your progress is saved.');
    });
    renderer.domElement.addEventListener('pointerdown', (e) => this._pick(e));
    this.size = [0, 0];
    this.pixelRatio = 0;
    this.postKey = null;
    return true;
  }

  _build() {
    if (!this._makeGL()) return;

    this.scene = new THREE.Scene();
    // authored framing constants
    this.camera = new THREE.PerspectiveCamera(42, 4 / 3, 0.1, 100);
    this.cameraHome = new THREE.Vector3(0, 4.4, 9.2);
    this.cameraLook = new THREE.Vector3(0, 0.8, 0);
    this.camera.position.copy(this.cameraHome);
    this.camera.lookAt(this.cameraLook);

    // Key light: warm directional with a shadow box fitted tightly around card, ball and pole.
    const key = new THREE.DirectionalLight(0xfff2dd, 3.2);
    key.position.set(4, 8, 5);
    key.target.position.set(0, 0.6, 1.2);
    const sc = key.shadow.camera;
    Object.assign(sc, { left: -3.4, right: 3.4, top: 3.4, bottom: -3.4, near: 4, far: 16 });
    sc.updateProjectionMatrix();
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 3;
    this.scene.add(key, key.target);
    this.keyLight = key;
    this.hemi = new THREE.HemisphereLight(0x8899bb, 0x443355, 1.6);
    this.scene.add(this.hemi);
    // warm glow over the call ball
    const ballLight = new THREE.PointLight(0xffc370, 30, 12, 1.8);
    ballLight.position.set(0, 3.4, 1.5);
    this._ballLightBase = 30;
    this.scene.add(ballLight);
    this.ballLight = ballLight;
    // lantern-row fill from behind, tinted by the theme
    this.lanternFill = new THREE.PointLight(0xffb454, 8, 14, 1.6);
    this.lanternFill.position.set(0, 2.2, -3.2);
    this.scene.add(this.lanternFill);

    // floor
    this.floorTex = null;
    this.floor = new THREE.Mesh(
      new THREE.CylinderGeometry(7.5, 7.5, 0.2, 64),
      new THREE.MeshStandardMaterial({ color: 0x2b2135, roughness: 0.9 }));
    this.floor.position.y = -0.1;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    // lacquered card board under the tiles (detailed tier)
    this.board = new THREE.Mesh(
      new THREE.BoxGeometry(3.95, 0.06, 3.95),
      new THREE.MeshPhysicalMaterial({ color: 0x5a1c1c, roughness: 0.45, clearcoat: 0.8, clearcoatRoughness: 0.2 }));
    this.board.position.set(0, 0.0, 1.9);
    this.board.receiveShadow = true;
    this.scene.add(this.board);

    // call ball — the visual hero of the current call
    this.ballCanvas = document.createElement('canvas');
    this.ballCanvas.width = this.ballCanvas.height = 256;
    this.ballTexture = new THREE.CanvasTexture(this.ballCanvas);
    this.ballTexture.colorSpace = THREE.SRGBColorSpace;
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.85, 48, 32),
      new THREE.MeshPhysicalMaterial({
        color: 0xfff4e0, roughness: 0.3, map: this.ballTexture,
        emissive: 0xffffff, emissiveMap: this.ballTexture, emissiveIntensity: 0.85,
      }));
    this.ball.position.set(0, 2.6, 0);
    this.ball.rotation.y = -Math.PI / 2; // number faces the camera
    this.ball.castShadow = true;
    this.scene.add(this.ball);
    this.ballPole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 2.2, 12),
      new THREE.MeshStandardMaterial({ color: 0x554433, roughness: 0.8 }));
    this.ballPole.position.set(0, 1.0, 0);
    this.ballPole.castShadow = true;
    this.scene.add(this.ballPole);

    // 3D card cells (raycast interaction layer, mirrors the DOM grid)
    this.boxGeo = new THREE.BoxGeometry(0.62, 0.08, 0.62);
    this.boxGeo.translate(0, 0.04, 0);
    this.tileGeo = null;
    this.cellGroup = new THREE.Group();
    for (let i = 0; i < CELLS; i++) {
      const r = Math.floor(i / GRID), c = i % GRID;
      const m = new THREE.Mesh(this.boxGeo, new THREE.MeshPhysicalMaterial({ color: 0x2b3a67, roughness: 0.6 }));
      m.position.set((c - 2) * 0.72, 0.0, 1.9 + (r - 2) * 0.72);
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.cell = i;
      this.cellGroup.add(m);
      this.cells.push(m);
    }
    this.scene.add(this.cellGroup);

    // warm dust motes drifting up through the lantern light (animated background only)
    const motes = 90;
    const pos = new Float32Array(motes * 3);
    for (let i = 0; i < motes; i++) {
      pos[i * 3] = ((i * 73) % 100) / 100 * 12 - 6;
      pos[i * 3 + 1] = ((i * 37) % 100) / 100 * 5;
      pos[i * 3 + 2] = ((i * 53) % 100) / 100 * 6 - 3.5;
    }
    const moteGeo = new THREE.BufferGeometry();
    moteGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({
      color: 0xffc98a, size: 0.05, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.scene.add(this.motes);

    this.applyTheme(store.data.settings.theme);
    this.setGraphics(this.g);

    window.addEventListener('resize', () => this.resize());
    this.resize();

    this._t = 0;
    this._running = true;
    this.ok = true;
    const loop = (ts) => {
      if (!this._running) return;
      requestAnimationFrame(loop);
      if (document.hidden) { this._last = 0; return; }
      const dtMs = this._last ? Math.min(250, ts - this._last) : 16;
      this._last = ts;
      // Hidden hall (compact layouts collapse it): skip rendering entirely.
      if (!this.holder.clientWidth) return;
      if (this._moving()) this._t += dtMs / 1000;
      this._animate();
      this.render(gfxFrame(dtMs));
    };
    requestAnimationFrame(loop);
  }

  _moving() {
    return this.g.background === 'animated' && !store.data.settings.reducedMotion;
  }

  _fail(msg) {
    if (this.holder.querySelector('.webgl-fail')) return;
    const p = document.createElement('p');
    p.className = 'webgl-fail';
    p.textContent = msg;
    p.style.padding = '1em';
    this.holder.appendChild(p);
  }

  _buildLanterns(count, detailed) {
    for (const k of ['lanterns', 'lanternCaps']) {
      if (this[k]) { this.scene.remove(this[k]); this[k].geometry.dispose(); this[k].material.dispose(); this[k] = null; }
    }
    let geo;
    if (detailed) geo = makeLanternGeometry();
    else { geo = new THREE.SphereGeometry(0.28, 12, 10); geo.scale(1, 1.25, 1); }
    const col = this._lanternColor || 0xffb454;
    const mat = new THREE.MeshStandardMaterial({
      color: col, emissive: col, emissiveIntensity: detailed ? 2.2 : 1.5, roughness: 0.5,
    });
    const inst = new THREE.InstancedMesh(geo, mat, count);
    let caps = null;
    if (detailed) {
      const capGeo = new THREE.CylinderGeometry(0.1, 0.12, 0.06, 10);
      caps = new THREE.InstancedMesh(capGeo, new THREE.MeshStandardMaterial({ color: 0x2a1a14, roughness: 0.5, metalness: 0.3 }), count * 2);
    }
    const dummy = new THREE.Object3D();
    this._lanternData = [];
    const rngRows = Math.ceil(count / 8);
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / 8), col2 = i % 8;
      const x = (col2 - 3.5) * 1.5 + (row % 2) * 0.75;
      const z = -1.6 - row * (3.4 / Math.max(1, rngRows));
      const y = 3.5 + ((i * 37) % 10) / 16;
      const phase = (i * 0.77) % (Math.PI * 2);
      this._lanternData.push({ x, y, z, phase });
    }
    this.lanterns = inst;
    this.lanternCaps = caps;
    this._placeLanterns(dummy, 0, true);
    this.scene.add(inst);
    if (caps) this.scene.add(caps);
  }

  _placeLanterns(dummy, t, force) {
    if (!this.lanterns) return;
    for (let i = 0; i < this._lanternData.length; i++) {
      const d = this._lanternData[i];
      const x = d.x + (t ? Math.sin(t * 0.6 + d.phase) * 0.08 : 0);
      const y = d.y + (t ? Math.sin(t * 0.8 + d.phase) * 0.05 : 0);
      const tilt = t ? Math.sin(t * 0.6 + d.phase) * 0.05 : 0;
      dummy.position.set(x, y, d.z);
      dummy.rotation.set(0, 0, tilt);
      dummy.updateMatrix();
      this.lanterns.setMatrixAt(i, dummy.matrix);
      if (this.lanternCaps) {
        for (const [k, dy] of [[0, 0.36], [1, -0.36]]) {
          dummy.position.set(x - Math.sin(tilt) * dy, y + dy, d.z);
          dummy.updateMatrix();
          this.lanternCaps.setMatrixAt(i * 2 + k, dummy.matrix);
        }
      }
    }
    this.lanterns.instanceMatrix.needsUpdate = true;
    if (this.lanternCaps) this.lanternCaps.instanceMatrix.needsUpdate = true;
  }

  applyTheme(themeId) {
    const t = THEMES.find(x => x.id === themeId) || THEMES[0];
    this._lanternColor = t.lantern;
    this._themeId = t.id;
    if (!this.scene) return;
    this.scene.background = new THREE.Color(t.bg);
    this.scene.fog = new THREE.Fog(t.bg, 12, 26);
    this.floor.material.color.setHex(t.floor);
    if (this.floor.material.map) this.floor.material.color.multiplyScalar(1.3); // texture is mid-grey
    this.lanternFill.color.setHex(t.lantern);
    if (this.lanterns) {
      this.lanterns.material.color.setHex(t.lantern);
      this.lanterns.material.emissive.setHex(t.lantern);
    }
  }

  /** Apply resolved graphics tiers live (no reload). */
  setGraphics(g) {
    const key = JSON.stringify(g) + store.data.settings.reducedMotion;
    if (key === this._gfxKey) return;
    this._gfxKey = key;
    this.g = g;
    if (!this._makeGL()) return;
    const detailed = g.detail === 'detailed';
    // shadows
    const size = SHADOW_MAP[g.shadows];
    this.renderer.shadowMap.enabled = size > 0;
    this.keyLight.castShadow = size > 0;
    if (size > 0 && this.keyLight.shadow.mapSize.x !== size) {
      this.keyLight.shadow.mapSize.set(size, size);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
    }
    // lanterns
    const count = LANTERN_COUNT[g.lanterns];
    if (!this.lanterns || this.lanterns.count !== count || this._lanternsDetailed !== detailed) {
      this._buildLanterns(count, detailed);
      this._lanternsDetailed = detailed;
    }
    // surface detail: textured floor, lacquered board, bevelled glossy tiles, brass pole, glossy ball
    if (detailed && !this.floorTex) this.floorTex = makeFloorTexture();
    const fm = this.floor.material;
    fm.map = detailed ? this.floorTex : null;
    fm.roughness = detailed ? 0.55 : 0.9;
    fm.metalness = 0;
    this.board.visible = detailed;
    if (detailed && !this.tileGeo) this.tileGeo = makeTileGeometry();
    for (const m of this.cells) {
      m.geometry = detailed ? this.tileGeo : this.boxGeo;
      m.material.clearcoat = detailed ? 0.8 : 0;
      m.material.clearcoatRoughness = 0.15;
      m.material.roughness = detailed ? 0.42 : 0.6;
    }
    const bm = this.ball.material;
    bm.clearcoat = detailed ? 1 : 0;
    bm.clearcoatRoughness = 0.08;
    bm.emissiveIntensity = detailed ? 0.3 : 0.85;
    const pm = this.ballPole.material;
    pm.color.setHex(detailed ? 0xb08d57 : 0x554433);
    pm.metalness = detailed ? 0.85 : 0;
    pm.roughness = detailed ? 0.32 : 0.8;
    this.motes.visible = g.background === 'animated';
    this._ballLightBase = detailed ? 14 : 30;
    this.ballLight.intensity = this._ballLightBase;
    this.ballLight.position.set(0, detailed ? 4.2 : 3.4, detailed ? 2.6 : 1.5);
    this.lanternFill.visible = detailed;
    // reflections: RoomEnvironment IBL (loaded with the post addons)
    this._applyReflections();
    this.applyTheme(this._themeId || store.data.settings.theme);
    // Materials pick up shadow-map / map / clearcoat changes on recompile.
    for (const o of [this.floor, this.board, this.ball, this.ballPole, this.lanterns, this.lanternCaps, ...this.cells]) {
      if (o) o.material.needsUpdate = true;
    }
    if (!this._moving()) this._placeLanterns(new THREE.Object3D(), 0, true);
    this.postKey = null; // rebuild the post chain on the next frame
    if (g.post || g.reflections === 'on') loadHallPost().then(() => { this.postKey = null; this._applyReflections(); });
    this.resize();
  }

  _applyReflections() {
    const want = this.g.reflections === 'on' && hallPost;
    if (want && !this.envMap) {
      try { this.envMap = hallPost.buildEnvironment(this.renderer); } catch (_) { this.envMap = null; }
    }
    this.scene.environment = want ? this.envMap : null;
    this.scene.environmentIntensity = 0.22;
    if (!want && this.envMap) { this.envMap.dispose(); this.envMap = null; }
  }

  _disposePost() {
    if (this.composer) {
      try { this.composer.dispose(); } catch (_) { /* already gone */ }
    }
    this.composer = null;
  }

  _buildPost(w, h) {
    this._disposePost();
    if (!this.g.post || !hallPost || gfxRuntime.postFailed) return;
    try {
      this.composer = hallPost.buildComposer(this.renderer, this.scene, this.camera, this.g, w, h, this.pixelRatio);
    } catch (_) {
      // Post-processing is an enhancement: render directly if the chain cannot be built.
      gfxRuntime.postFailed = true;
      this.composer = null;
      refreshGfxPanel();
    }
  }

  render(rescale) {
    const w = this.holder.clientWidth || 320, h = this.holder.clientHeight || 240;
    // the canvas sits in the zoomed page (ui-scale.js): its backing store follows the zoom
    const ratio = gfxPixelRatio(this.g) * ((window.UIScale && window.UIScale.value) || 1);
    if (w !== this.size[0] || h !== this.size[1] || ratio !== this.pixelRatio || rescale || this._needsResize) {
      this._needsResize = false;
      this.size = [w, h];
      this.pixelRatio = ratio;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(w, h, false);
    }
    const key = this.g.post && hallPost ? [this.g.ao, this.g.bloom, this.g.grade, this.g.antialias, w, h, ratio].join('|') : 'none';
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost(w, h);
    }
    if (this.composer) {
      try { this.composer.render(); return; } catch (_) {
        gfxRuntime.postFailed = true;
        this._disposePost();
        refreshGfxPanel();
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    this._needsResize = true; // re-measured on the next frame
  }

  /** Rendered pixel size (for the Graphics summary). */
  pixels() {
    if (!this.size[0]) return null;
    return [Math.round(this.size[0] * this.pixelRatio), Math.round(this.size[1] * this.pixelRatio)];
  }

  resetCamera() {
    this.camera.position.copy(this.cameraHome);
    this.camera.lookAt(this.cameraLook);
  }

  _animate() {
    const t = this._t;
    const dummy = this._dummy || (this._dummy = new THREE.Object3D());
    if (this.lanterns && t !== 0 && this._moving()) this._placeLanterns(dummy, t);
    if (this._moving()) {
      this.ball.position.y = 2.6 + Math.sin(t * 1.1) * 0.04;
      this.ball.rotation.y = -Math.PI / 2 + Math.sin(t * 0.4) * 0.12;
      this.ballLight.intensity = this._ballLightBase * (0.94 + 0.06 * Math.sin(t * 7.3) * Math.sin(t * 3.1));
      const p = this.motes.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        let y = p.getY(i) + 0.004;
        if (y > 5) y = 0;
        p.setY(i, y);
      }
      p.needsUpdate = true;
    }
    if (this._ballPop > 0) {
      this._ballPop = Math.max(0, this._ballPop - 0.04);
      const s = 1 + Math.sin(this._ballPop * Math.PI) * 0.25;
      this.ball.scale.setScalar(s);
    }
  }

  showCall(value) {
    const ctx = this.ballCanvas.getContext('2d');
    const S = this.ballCanvas.width;
    ctx.fillStyle = '#fff2dc';
    ctx.fillRect(0, 0, S, S);
    if (value > 0) {
      // lettered band like a real bingo ball
      ctx.fillStyle = '#c0392b';
      ctx.fillRect(0, S * 0.3, S, S * 0.08);
      ctx.fillRect(0, S * 0.62, S, S * 0.08);
      ctx.fillStyle = '#1a2040';
      ctx.font = `bold ${S / 2}px "Segoe UI", Arial, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(value), S / 2, S * 0.53);
    }
    this.ballTexture.needsUpdate = true;
    this._ballPop = store.data.settings.reducedMotion ? 0 : 1;
  }

  // Sync 3D cell colors from an immutable snapshot + legal-action info.
  syncCells(state, playerId, markable) {
    const p = state.players.find(pl => pl.id === playerId);
    if (!p) return;
    for (let i = 0; i < CELLS; i++) {
      const mat = this.cells[i].material;
      if (p.marks[i]) { mat.color.setHex(0xffb454); mat.emissive.setHex(0x663300); }
      else if (markable && markable.has(i)) { mat.color.setHex(0xffd7a0); mat.emissive.setHex(0x553a00); }
      else { mat.color.setHex(0x2b3a67); mat.emissive.setHex(0x000000); }
    }
  }

  _pick(e) {
    if (!this.onCellPick) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._pointer, this.camera);
    const hits = this._raycaster.intersectObjects(this.cells, false);
    if (hits.length) this.onCellPick(hits[0].object.userData.cell);
  }

  dispose() {
    this._running = false;
    this._disposePost();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
    }
  }
}

// ---------------------------------------------------------------- app
const app = {
  screen: 'title',
  gamePhase: 'boot', // boot|title|mode-select|preparing|countdown|active|paused|results
  session: null,
  hosted: null,
  renderer: null,
  stage: null,          // active content descriptor
  mode: null,           // learn|journey|daily|practice|challenge|hosted
  callTimer: null,
  botTimers: [],
  lesson: null,         // active lesson runner
  focusCell: CENTER,
  pendingAck: new Set(), // action identifiers prevent double commits
};

function setPhase(p, reason) {
  app.gamePhase = p;
  setStatus(`${p}${reason ? ' — ' + reason : ''}`);
}

function setStatus(text) { $('#live-status').textContent = text; }
function announce(text) { $('#live-alert').textContent = ''; requestAnimationFrame(() => { $('#live-alert').textContent = text; }); }

// ---------------------------------------------------------------- screens
const SCREENS = ['title', 'setup', 'journey', 'learn', 'play', 'results', 'settings', 'help'];
function showScreen(name) {
  for (const s of SCREENS) $('#screen-' + s).hidden = s !== name;
  app.screen = name;
  if (name === 'title') titleFx.kick();
  const first = $('#screen-' + name + ' button');
  if (first) first.focus({ preventScroll: true });
  window.scrollTo(0, 0); // screens share the document scroll: each opens at its top
}

// ---------------------------------------------------------------- modal
let modalLastFocus = null;
function openModal(title, bodyHTML, actions) {
  modalLastFocus = document.activeElement;
  const dlg = $('#modal-root');
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHTML;
  const act = $('#modal-actions');
  act.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'menu-btn' + (a.primary ? ' primary' : '');
    b.textContent = a.label;
    b.addEventListener('click', () => { audio.event('ui'); a.onClick(); });
    act.appendChild(b);
  }
  dlg.showModal();
  const first = act.querySelector('button');
  if (first) first.focus();
}
function closeModal() {
  const dlg = $('#modal-root');
  if (dlg.open) dlg.close();
  if (modalLastFocus && document.contains(modalLastFocus)) modalLastFocus.focus({ preventScroll: true });
}
$('#modal-root').addEventListener('cancel', (e) => { e.preventDefault(); if (app.gamePhase === 'paused') resumeGame(); });
$('#modal-root').addEventListener('click', (e) => { if (e.target === $('#modal-root') && app.gamePhase === 'paused') resumeGame(); });

// ---------------------------------------------------------------- setup flows
function setupDescriptor(mode, stage) {
  const lines = [];
  lines.push(`<p><strong>${stage.title || stage.id}</strong></p>`);
  lines.push(`<p>Pattern: <strong>${PATTERNS[stage.pattern].name}</strong> — ${PATTERNS[stage.pattern].desc}</p>`);
  lines.push(`<p>Opponents: ${stage.bots} lantern${stage.bots === 1 ? '' : 's'} · Expected duration: ~${stage.expectedMinutes} min</p>`);
  lines.push(`<p>Par: ${stage.parCalls} calls · Seed: ${stage.seed} · Content v${stage.version || CONTENT_VERSION}</p>`);
  lines.push(`<p>${stage.ranked ? 'Ranked result.' : 'Unranked practice — undo allowed, no rating effect.'}</p>`);
  if (stage.constraint) lines.push(`<p>Constraint: ${stage.constraint}</p>`);
  return lines.join('');
}

let pendingSetup = null;
function openSetup(mode, stage) {
  pendingSetup = { mode, stage };
  $('#setup-details').innerHTML = setupDescriptor(mode, stage);
  showScreen('setup');
}

$('#setup-start').addEventListener('click', () => {
  audio.event('ui');
  if (pendingSetup) startRound(pendingSetup.mode, pendingSetup.stage);
});

function buildJourneyList() {
  const ol = $('#journey-list');
  ol.innerHTML = '';
  const done = new Set(store.data.progress.journeyDone);
  const maxUnlocked = JOURNEY_STAGES.findIndex(s => !done.has(s.id));
  const unlockUpTo = maxUnlocked === -1 ? JOURNEY_STAGES.length : maxUnlocked + 1;
  JOURNEY_STAGES.forEach((s, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${s.mastery ? '★ ' : ''}${s.title} — ${PATTERNS[s.pattern].name}`;
    if (done.has(s.id)) b.classList.add('done');
    if (s.mastery) b.classList.add('mastery');
    if (i > unlockUpTo) { b.classList.add('locked'); b.disabled = true; b.setAttribute('aria-label', s.title + ' locked'); }
    else b.addEventListener('click', () => { audio.event('ui'); openSetup('journey', s); });
    li.appendChild(b);
    ol.appendChild(li);
  });
}

function buildLearnList() {
  const ol = $('#learn-list');
  ol.innerHTML = '';
  const done = new Set(store.data.progress.lessonsDone);
  LESSONS.forEach((l) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = l.title + (done.has(l.id) ? ' ✓' : '');
    if (done.has(l.id)) b.classList.add('done');
    b.addEventListener('click', () => { audio.event('ui'); startLesson(l); });
    li.appendChild(b);
    ol.appendChild(li);
  });
}

// ---------------------------------------------------------------- round setup
function playerIdsFor(stage) {
  const ids = ['you'];
  for (let i = 0; i < (stage.bots || 0); i++) ids.push('lantern-' + (i + 1));
  return ids;
}

function startRound(mode, stage) {
  app.mode = mode;
  app.stage = stage;
  settingsReturnPause = false;
  helpReturnPause = false;
  setPhase('preparing', stage.title || stage.id);
  app.session = new Session({
    seed: stage.seed >>> 0,
    pattern: stage.pattern,
    parCalls: stage.parCalls,
    playerIds: playerIdsFor(stage),
    meta: { mode, contentId: stage.id, version: stage.version || CONTENT_VERSION },
  });
  app.session.onEvent(onSessionEvent);
  $('#btn-undo').hidden = !(mode === 'practice' || mode === 'learn');
  $('#btn-claim').disabled = true;
  $('#btn-call').disabled = false; // may have been left disabled by a hosted round
  $('#hint-text').textContent = '';
  buildCardDom();
  showScreen('play');
  if (!app.renderer) app.renderer = new HallRenderer($('#canvas-holder'));
  if (app.renderer.ok) {
    app.renderer.onCellPick = (cell) => tryMarkCell(cell);
    app.renderer.applyTheme(stage.theme || store.data.settings.theme);
    app.renderer.resize();
    app.renderer.showCall(0);
  }
  syncPlayUi();
  countdown(() => {
    setPhase('active');
    setStatus('Round active — ' + PATTERNS[stage.pattern].name);
    scheduleNextCall();
  });
}

function countdown(done) {
  const session = app.session;
  app.countdownSession = session;
  setPhase('countdown');
  // The countdown overlays the card area (the decorative hall may be hidden
  // on compact layouts).
  const holder = $('.playfield') || $('#canvas-holder');
  const el = document.createElement('div');
  el.className = 'countdown-num';
  el.setAttribute('role', 'timer');
  holder.style.position = 'relative';
  holder.appendChild(el);
  const seq = ['3', '2', '1', 'Go'];
  let i = 0;
  const step = () => {
    if (app.session !== session) { el.remove(); return; }
    if (app.gamePhase === 'paused') { setTimeout(step, 300); return; }
    if (i >= seq.length) { el.remove(); app.countdownSession = null; done(); return; }
    el.textContent = seq[i];
    announce(seq[i]);
    audio.event(i === seq.length - 1 ? 'go' : 'tick');
    i++;
    setTimeout(step, store.data.settings.reducedMotion ? 500 : 750);
  };
  step();
}

// ---------------------------------------------------------------- card DOM
// The local player is 'you' offline; in hosted rounds it is the server-assigned
// guest id, which is not necessarily the first seat.
function meId() {
  return (app.mode === 'hosted' && app.hosted) ? app.hosted.playerId : 'you';
}
function mePlayer(state) {
  return state.players.find(p => p.id === meId()) || state.players[0];
}
function markCell(cell) {
  if (app.mode === 'hosted') hostedMark(cell);
  else tryMarkCell(cell);
}

function buildCardDom() {
  const grid = $('#card-grid');
  grid.innerHTML = '';
  const state = app.session.state;
  const me = mePlayer(state);
  for (let i = 0; i < CELLS; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'card-cell';
    b.dataset.cell = i;
    b.setAttribute('role', 'gridcell');
    const r = Math.floor(i / GRID), c = i % GRID;
    b.setAttribute('aria-label', `row ${r + 1} column ${c + 1}`);
    if (i === CENTER) { b.classList.add('free'); b.textContent = 'FREE'; b.disabled = true; }
    else {
      b.textContent = String(me.card[i]);
      b.setAttribute('aria-label', `row ${r + 1} column ${c + 1}, number ${me.card[i]}`);
      b.addEventListener('click', () => markCell(i));
    }
    b.tabIndex = i === app.focusCell ? 0 : -1;
    grid.appendChild(b);
  }
  updatePatternHints();
}

function updatePatternHints() {
  const stage = app.stage;
  if (!stage || !app.session) return;
  const me = app.session.state.players[0];
  // highlight cells belonging to the target pattern
  const inPattern = new Set();
  const mark = (arr) => arr.forEach(i => inPattern.add(i));
  switch (stage.pattern) {
    case 'corners': mark([0, GRID - 1, (GRID - 1) * GRID, CELLS - 1]); break;
    case 'frame': for (let i = 0; i < CELLS; i++) { const r = Math.floor(i / GRID), c = i % GRID; if (r === 0 || r === GRID - 1 || c === 0 || c === GRID - 1) inPattern.add(i); } break;
    case 'diagonal': case 'x-shape': mark([0,1,2,3,4].map(i => i * GRID + i)); mark([0,1,2,3,4].map(i => (GRID - 1 - i) * GRID + i)); break;
    default: break;
  }
  $$('#card-grid .card-cell').forEach((el, i) => el.classList.toggle('pattern-hint', inPattern.has(i)));
  void me;
}

// ---------------------------------------------------------------- play loop
function scheduleNextCall() {
  clearTimeout(app.callTimer);
  if (app.mode === 'hosted') return; // the server is the caller in hosted rounds
  const speed = Number(store.data.settings.callSpeed);
  if (speed <= 0 || app.gamePhase !== 'active') { updateCallTimerLabel(); return; }
  app.callTimer = setTimeout(() => doCall(), speed);
  updateCallTimerLabel(speed);
}

function updateCallTimerLabel(ms) {
  $('#call-timer').textContent = ms ? `(auto in ${Math.round(ms / 1000)}s)` : '(manual calls)';
}

function doCall() {
  if (!app.session || app.session.ended || app.gamePhase !== 'active') return;
  const r = app.session.dispatch({ type: 'call' });
  if (!r.ok) { setStatus(r.error === 'deck-exhausted' ? 'No numbers left in the deck.' : r.error); return; }
  audio.event('call');
  const v = app.session.state.currentCall;
  $('#call-display').textContent = String(v);
  if (app.renderer && app.renderer.ok) app.renderer.showCall(v);
  announce('Called ' + v);
  scheduleBots();
  scheduleNextCall();
  syncPlayUi();
}

function tryMarkCell(cell) {
  if (!app.session || app.gamePhase !== 'active') return;
  if (cell === CENTER) return; // free cell is pre-marked; selecting it is never a penalty
  const ack = 'mark-' + cell + '-' + app.session.state.tick;
  if (app.pendingAck.has(ack)) return;
  app.pendingAck.add(ack);
  setTimeout(() => app.pendingAck.delete(ack), 400);
  const r = app.session.dispatch({ type: 'mark', player: 'you', cell });
  if (!r.ok) {
    audio.event('invalid');
    const me = app.session.state.players[0];
    const msg = r.error === 'already-marked' ? 'Already marked.'
      : r.error === 'number-not-called' ? `Number ${me.card[cell]} has not been called yet.`
      : r.error;
    $('#hint-text').textContent = msg;
    announce(msg);
  } else {
    audio.event('mark');
    $('#hint-text').textContent = '';
  }
  syncPlayUi();
}

function tryClaim() {
  if (!app.session || app.session.ended || app.gamePhase !== 'active') return;
  const r = app.session.dispatch({ type: 'claim', player: 'you' });
  if (!r.ok) {
    audio.event('invalid');
    const msg = 'Pattern not complete yet — false claim −25.';
    $('#hint-text').textContent = msg;
    announce(msg);
  }
  syncPlayUi();
}

function scheduleBots() {
  // Bots react to the latest call; reaction time scales with skill but their
  // commands are logged like any other, keeping replays verifiable.
  // Hosted rounds are driven by the server — never simulate bots locally.
  if (app.mode === 'hosted') return;
  const state = app.session.state;
  for (const p of state.players) {
    if (!p.id.startsWith('lantern-')) continue;
    const skill = app.stage.botSkill || 0.6;
    const delay = 600 + (1 - skill) * 4000 + ((state.tick * 7919 + p.id.length * 131) % 700);
    const t = setTimeout(() => {
      if (!app.session || app.session.ended || app.gamePhase === 'paused') return;
      const st = app.session.state;
      const me = st.players.find(pl => pl.id === p.id);
      if (!me) return;
      // mark everything legal
      const acts = app.session.legalActions(p.id);
      const mark = acts.find(a => a.type === 'mark');
      const notices = ((st.tick * 2654435761 + p.id.length * 97) % 1000) / 1000 < skill;
      if (mark && notices) {
        for (const cell of mark.cells) {
          if (app.session.ended) break;
          app.session.dispatch({ type: 'mark', player: p.id, cell });
        }
      }
      // claim if pattern complete
      const me2 = app.session.state.players.find(pl => pl.id === p.id);
      if (!app.session.ended && patternComplete(me2.marks, app.session.state.pattern)) {
        app.session.dispatch({ type: 'claim', player: p.id });
      }
    }, delay);
    app.botTimers.push(t);
  }
}

function onSessionEvent(ev) {
  if (ev.type !== 'applied') return;
  for (const e of ev.events) {
    if (e.type === 'lines' && e.player === 'you') audio.event('line');
    if (e.type === 'invalid-claim' && e.player !== 'you') setStatus(e.player + ' made a false claim.');
    if (e.type === 'win') endRound(e.player);
  }
  if (app.lesson) lessonOnEvent(ev);
  syncPlayUi();
}

function endRound(winnerId) {
  clearTimeout(app.callTimer);
  app.botTimers.forEach(clearTimeout);
  app.botTimers = [];
  setPhase('resolving');
  const won = winnerId === 'you';
  audio.event(won ? 'win' : 'lose');
  const me = app.session.state.players[0];
  achievementCtx.linesTotal += countLines(me.marks);
  const unlocked = [];
  const push = (k) => { const a = unlock(k); if (a) unlocked.push(a); };
  if (won) {
    push('first_win');
    achievementCtx.winStreak++;
    if (achievementCtx.winStreak >= 3) push('streak_3');
    if (app.stage.pattern === 'full-house') push('full_lantern');
  } else achievementCtx.winStreak = 0;
  if (achievementCtx.linesTotal >= 50) push('line_master');

  // persistence
  const prog = store.data.progress;
  prog.gamesPlayed++;
  const score = app.session.score('you');
  const key = app.stage.id;
  if (!prog.bestScores[key] || score.total > prog.bestScores[key]) prog.bestScores[key] = score.total;
  if (app.mode === 'journey' && won && !prog.journeyDone.includes(app.stage.id)) {
    prog.journeyDone.push(app.stage.id);
    if (prog.journeyDone.length >= JOURNEY_STAGES.length) push('long_road');
  }
  if (app.mode === 'daily') prog.dailyHistory[app.stage.day] = score.total;
  store.save();

  setTimeout(() => showResults(winnerId, unlocked), won ? 900 : 1200);
}

// ---------------------------------------------------------------- UI sync
function syncPlayUi() {
  if (!app.session) return;
  const state = app.session.state;
  const me = mePlayer(state);
  const stage = app.stage;

  $('#objective-text').textContent = 'Target: ' + PATTERNS[state.pattern].name;
  $('#pattern-desc').textContent = PATTERNS[state.pattern].desc;
  const lines = countLines(me.marks);
  $('#progress-text').textContent = `Calls: ${state.callIndex + 1} · Lines: ${lines} · Marks: ${me.marksMade}`;
  const sb = app.session.score(me.id);
  $('#score-preview').textContent = `Score so far: ${sb.total} (invalid −${sb.invalidPenalty})`;

  // claim button enabled only when a claim is legal (pattern complete)
  const claimReady = state.phase === 'active' && patternComplete(me.marks, state.pattern);
  $('#btn-claim').disabled = !claimReady;

  // card cells
  const acts = app.session.legalActions(me.id);
  const markAct = acts.find(a => a.type === 'mark');
  const markable = new Set(markAct ? markAct.cells : []);
  $$('#card-grid .card-cell').forEach((el, i) => {
    const marked = me.marks[i];
    el.classList.toggle('marked', marked);
    el.classList.toggle('markable', !marked && markable.has(i) && store.data.settings.autoHint);
    el.setAttribute('aria-pressed', marked ? 'true' : 'false');
    if (i !== CENTER) {
      const base = `row ${Math.floor(i / GRID) + 1} column ${(i % GRID) + 1}, number ${me.card[i]}`;
      el.setAttribute('aria-label', base + (marked ? ', marked' : markable.has(i) ? ', callable' : ''));
    }
  });

  if (app.renderer && app.renderer.ok) app.renderer.syncCells(state, me.id, markable);

  // roster
  const roster = $('#roster');
  roster.innerHTML = '';
  for (const p of state.players) {
    const li = document.createElement('li');
    li.textContent = p.id === me.id ? 'You' : hostedName(p.id);
    const span = document.createElement('span');
    span.textContent = `${countLines(p.marks)} lines`;
    li.appendChild(span);
    if (state.winner === p.id) li.classList.add('winner');
    roster.appendChild(li);
  }
  void stage;
}

// ---------------------------------------------------------------- pause
let helpReturnPause = false;
function pauseGame(reason) {
  if (app.gamePhase !== 'active' && app.gamePhase !== 'countdown') return;
  clearTimeout(app.callTimer);
  setPhase('paused', reason || 'paused');
  openModal('Paused', '<p>Take your time. The hall waits.</p>', [
    { label: 'Resume', primary: true, onClick: resumeGame },
    { label: 'Settings', onClick: () => { closeModal(); openSettings(true); } },
    { label: 'Help', onClick: () => { helpReturnPause = true; closeModal(); showScreen('help'); } },
    { label: 'Leave round', onClick: () => { closeModal(); abandonRound(); } },
  ]);
}

function resumeGame() {
  closeModal();
  if (!app.session || app.session.ended) { setPhase('active'); return; }
  if (app.countdownSession === app.session) { setPhase('countdown', 'resumed countdown'); return; }
  setPhase('active', 'resumed');
  scheduleBots();
  scheduleNextCall();
}

function abandonRound() {
  clearTimeout(app.callTimer);
  app.botTimers.forEach(clearTimeout);
  app.botTimers = [];
  settingsReturnPause = false;
  helpReturnPause = false;
  leaveHosted();
  app.session = null;
  setPhase('title', 'round left');
  showScreen('title');
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  platform.flushCloud(); // flush the debounced cloud mirror before backgrounding
  if ((app.gamePhase === 'active' || app.gamePhase === 'countdown') && app.mode !== 'hosted') pauseGame('tab hidden');
});

// ---------------------------------------------------------------- results
function showResults(winnerId, unlocked) {
  setPhase('results');
  $('#results-retry').hidden = false;
  $('#results-replay').hidden = false;
  const state = app.session.state;
  const sb = app.session.score('you');
  const won = state.winner === 'you';
  const rows = [
    ['Pattern bonus', sb.patternBase],
    [`Line bonus (${sb.lines} lines)`, sb.lineBonus],
    [`Marks (${state.players[0].marksMade})`, sb.marksScore],
    [`Speed bonus (par ${state.parCalls}, used ${sb.callsUsed})`, sb.speedBonus],
    ['Invalid actions', -sb.invalidPenalty],
  ];
  const ranking = app.session.ranking();
  const table = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v >= 0 ? '+' : ''}${v}</td></tr>`).join('');
  const rankList = ranking.map((id, i) => {
    const s = app.session.score(id);
    return `<tr><td>${i + 1}. ${id === 'you' ? 'You' : id}</td><td>${s.total}</td></tr>`;
  }).join('');
  $('#results-body').innerHTML = `
    <h3>${won ? '🏮 Bingo! You lit the hall.' : state.winner ? state.winner + ' claimed first.' : 'Round ended.'}</h3>
    <p class="muted">Reason: ${state.terminalReason} · Seed ${state.seed} · Hash ${hashState(state)}</p>
    <table class="score-table">${table}<tr class="total"><td>Total</td><td>${sb.total}</td></tr></table>
    <h4>Ranking</h4>
    <table class="score-table">${rankList}</table>
    ${unlocked.length ? `<h4>Achievements unlocked</h4><ul class="achievements">${unlocked.map(a => `<li>🏅 ${a.name}</li>`).join('')}</ul>` : ''}
    <h4>Next</h4>
    <p class="muted">${nextRecommendation()}</p>`;
  $('#results-next').textContent = app.mode === 'journey' && won ? 'Next stage' : 'Continue';
  if (unlocked.length) setTimeout(() => audio.event('achievement'), 450);
  showScreen('results');
  announce(won ? 'You won the round' : 'Round over');
}

function nextRecommendation() {
  const prog = store.data.progress;
  if (app.mode === 'learn') return 'Journey stage 1 puts your new skill to the test.';
  if (app.mode === 'journey' && prog.journeyDone.length < JOURNEY_STAGES.length) return 'Continue the Journey — the next stage is unlocked.';
  if (!prog.dailyHistory[new Date().toISOString().slice(0, 10)]) return 'Try today\'s Daily Lantern — one shared seed for everyone.';
  return 'Practice a harder pattern, or take on a Challenge.';
}

$('#results-retry').addEventListener('click', () => { audio.event('ui'); startRound(app.mode, app.stage); });
$('#results-next').addEventListener('click', () => {
  audio.event('ui');
  if (app.mode === 'journey') {
    const idx = JOURNEY_STAGES.findIndex(s => s.id === app.stage.id);
    const next = JOURNEY_STAGES[idx + 1];
    if (next && app.session && app.session.state.winner === 'you') { openSetup('journey', next); return; }
    buildJourneyList(); showScreen('journey'); return;
  }
  if (app.mode === 'hosted') { leaveHosted(); refreshTitleProgress(); }
  showScreen('title');
});
$('#results-replay').addEventListener('click', () => {
  audio.event('ui');
  const replay = JSON.stringify(app.session.exportReplay(), null, 2);
  const done = () => setStatus('Replay copied to clipboard.');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(replay).then(done, () => prompt('Copy replay:', replay));
  } else prompt('Copy replay:', replay);
});

// ---------------------------------------------------------------- learn mode
function startLesson(lesson) {
  app.lesson = { def: lesson, step: 0 };
  const stage = {
    id: lesson.id, title: lesson.title, seed: lesson.seed, pattern: lesson.pattern,
    bots: 0, botSkill: 0, parCalls: 0, ranked: false, expectedMinutes: 2, theme: 'ember',
  };
  startRound('learn', stage);
  clearTimeout(app.callTimer); // lessons are manual-paced
  lessonPrompt();
}

function lessonPrompt() {
  const l = app.lesson;
  if (!l) return;
  const step = l.def.steps[l.step];
  if (!step) return;
  $('#hint-text').textContent = step.text;
  announce(step.text);
  setStatus(`Lesson ${l.step + 1}/${l.def.steps.length}: ${l.def.title}`);
}

function lessonOnEvent(ev) {
  const l = app.lesson;
  if (!l) return;
  const step = l.def.steps[l.step];
  if (!step) return;
  const hit = ev.events.some(e =>
    (step.waitFor === 'call' && e.type === 'call') ||
    (step.waitFor === 'mark' && e.type === 'mark' && e.player === 'you') ||
    (step.waitFor === 'claim' && e.type === 'win' && e.player === 'you') ||
    (step.waitFor === 'auto-line' && e.type === 'lines' && e.player === 'you'));
  if (hit) {
    l.step++;
    if (l.step >= l.def.steps.length) {
      const prog = store.data.progress;
      if (!prog.lessonsDone.includes(l.def.id)) { prog.lessonsDone.push(l.def.id); store.save(); }
      if (!app.session.ended) {
        setStatus('Lesson complete! Finish the round or leave when ready.');
        announce('Lesson complete');
      }
      app.lesson = null;
    } else lessonPrompt();
  }
}

// ---------------------------------------------------------------- hosted play
// Two transports, one hall protocol:
//  - hosted (a launch token was read): StarHermit realtime rooms, host-routed.
//    The room's host client runs the caller/rounds and broadcasts the same
//    JSON messages the repo's own hall server used; guests send their
//    existing mark/claim commands as binary frames (guest→host).
//  - offline (no token): the repo's own server.js hall over /ws (local dev).
let hallHost = null;   // HallHost instance while this client hosts the room
let roomsClient = null;

function leaveHosted() {
  if (hallHost) { try { hallHost.stop(); } catch (_) {} hallHost = null; }
  app.joiningHall = false;
  if (app.hosted) {
    const sock = app.hosted.socket || app.hosted.ws;
    app.hosted.socket = null;
    app.hosted.ws = null;
    if (app.hosted.roomId && roomsClient) roomsClient.leave(app.hosted.roomId);
    if (sock) {
      sock.onclose = null;
      try { sock.close(); } catch (_) {}
    }
    app.hosted = null;
  }
  if (app.mode === 'hosted') app.mode = null;
}

function startHosted(reconnect) {
  if (platform.hosted) return startHostedRooms(reconnect);
  startHostedLegacy(reconnect);
}

function hostedFail() {
  setStatus('Hosted play is unavailable right now. Try Practice instead.');
  announce('Hosted play unavailable');
}

// -------- hosted via StarHermit realtime rooms (token present)
async function startHostedRooms(reconnect) {
  setStatus(reconnect ? 'Reconnecting to hall…' : 'Finding a hall…');
  try {
    if (!platform.nickname) await platform.loadProfile();
    if (!roomsClient) roomsClient = new RoomsClient({ api: platform.api, loc: location });
    let room = null, created = false;
    if (reconnect) {
      const mine = await roomsClient.mine();
      room = mine.find(r => roomsClient.roomId(r)) || null;
    }
    if (!room) ({ room, created } = await roomsClient.quickJoinOrCreate(platform.slug));
    const roomId = roomsClient.roomId(room);
    const socket = await roomsClient.connect(roomId, platform.token);
    socket.observeRoom(room);
    const selfId = await socket.resolveSelf();
    if (!selfId) throw new Error('no participant id');
    socket.onroster = (list) => handleHallRoster(socket, list, selfId);
    const isHost = (socket.hostId && socket.hostId === selfId) || (!socket.hostId && created);
    if (isHost) enterHallAsHost(socket, roomId, selfId);
    else enterHallAsGuest(socket, roomId, selfId, reconnect);
  } catch (e) {
    hostedFail();
  }
}

function handleHallRoster(socket, list, selfId) {
  if (app.mode !== 'hosted' || !app.hosted) return;
  const ids = new Set(list.map(p => String(p && (p.id || p.participantId || p.userId))));
  if (app.hosted.isHost) {
    // seat leavers keep their seat until the round ends; prune absent members
    if (hallHost) for (const pid of hallHost.members.keys()) {
      if (pid !== selfId && !ids.has(pid)) hallHost.markAbsent(pid);
    }
    if (socket.hostId && socket.hostId !== selfId) {
      setStatus('The hall moved to a new host — returning to the title.');
      abandonRound();
    }
  } else if (socket.hostId && socket.hostId === selfId) {
    setStatus('The hall host left — returning to the title.');
    abandonRound();
  }
}

function enterHallAsHost(socket, roomId, selfId) {
  socket.isHost = true;
  socket.onbinary = ({ from, msg }) => {
    if (msg && msg.type === 'you-are') return;
    if (hallHost) hallHost.handleGuestMessage(from, msg);
  };
  socket.onclose = () => { if (app.mode === 'hosted') hostedFail(); };
  app.mode = 'hosted';
  app.hosted = { isHost: true, socket, roomId, playerId: 'you', spectator: false, seats: null };
  hallHost = new HallHost({
    send: (obj) => { try { socket.sendBinary(obj); } catch (_) {} },
    selfId,
    nickname: platform.nickname || undefined,
    onEvent: hostHallEvent,
    onRoundEnd: hostHallEnded,
    onRoundStart: hostHallRoundStart,
  });
  hostHallRoundStart();
}

// New round (also the entry point): the host plays seat 'you' locally.
function hostHallRoundStart() {
  if (app.mode !== 'hosted' || !app.hosted || !app.hosted.isHost || !hallHost) return;
  app.stage = hallHost.stage;
  app.session = hallHost.session;
  app.focusCell = CENTER;
  app.hosted.seats = hallHost.seats();
  app.hosted.spectator = false;
  $('#btn-undo').hidden = true;
  $('#btn-call').disabled = true; // the host is the caller, on a fixed 4 s cadence
  $('#btn-claim').disabled = true;
  $('#call-display').textContent = '—';
  $('#hint-text').textContent = '';
  buildCardDom();
  showScreen('play');
  if (!app.renderer) app.renderer = new HallRenderer($('#canvas-holder'));
  if (app.renderer.ok) {
    app.renderer.onCellPick = (cell) => hostedMark(cell);
    app.renderer.applyTheme(hallHost.stage.theme || store.data.settings.theme);
    app.renderer.resize();
    app.renderer.showCall(0);
  }
  setPhase('active', 'hosted hall — you are the caller');
  syncPlayUi();
}

function hostHallEvent(events) {
  for (const e of events) {
    if (e.type === 'call') {
      audio.event('call');
      const v = hallHost.session.state.currentCall;
      $('#call-display').textContent = String(v);
      if (app.renderer && app.renderer.ok) app.renderer.showCall(v);
      announce('Called ' + v);
    }
    if (e.type === 'lines' && e.player === 'you') audio.event('line');
    if (e.type === 'invalid-claim' && e.player !== 'you') setStatus(hostedName(e.player) + ' made a false claim.');
  }
  syncPlayUi();
}

function hostHallEnded(winner) {
  setPhase('resolving');
  if (app.hosted && app.hosted.roomId && roomsClient && hallHost) {
    roomsClient.postResult(app.hosted.roomId, {
      winner, stage: hallHost.stage.id, rounds: hallHost.rounds,
    });
  }
  setTimeout(() => {
    if (!app.session || app.mode !== 'hosted' || !app.hosted || !app.hosted.isHost) return;
    showHostedResults(winner);
  }, 900);
}

function enterHallAsGuest(socket, roomId, selfId, reconnect) {
  socket.onbinary = ({ msg }) => handleGuestHallMessage(msg, socket, roomId, selfId);
  app.joiningHall = true;
  socket.onclose = () => {
    if (app.mode !== 'hosted') return;
    if (app.gamePhase === 'active' && !reconnect) {
      setStatus('Disconnected from hall. Reconnecting…');
      setTimeout(() => {
        if (app.mode === 'hosted' && app.gamePhase === 'active') startHostedRooms(true);
      }, 1500);
    } else {
      hostedFail();
    }
  };
  socket.sendBinary({ type: 'join-hall', name: platform.nickname || undefined });
}

function handleGuestHallMessage(msg, socket, roomId, selfId) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type !== 'seated' && (!app.session || app.mode !== 'hosted' || !app.hosted)) return;
  if (msg.type === 'seated') {
    // only apply a seat notice meant for us: our join intent, or a new-round
    // broadcast while we are a seated guest (never another joiner's `you`)
    const expected = app.joiningHall || (app.hosted && !app.hosted.isHost);
    if (!expected) return;
    if (msg.you && msg.you !== selfId) return;
    if (app.mode === 'hosted' && (!app.hosted || app.hosted.isHost)) return;
    app.joiningHall = false;
    const seats = Array.isArray(msg.seats) ? msg.seats : [];
    const mine = seats.find(s => s.participantId === selfId);
    app.mode = 'hosted';
    app.hosted = {
      isHost: false, socket, roomId,
      playerId: mine && mine.playerId ? mine.playerId : null,
      spectator: !(mine && mine.playerId), seats,
    };
    app.stage = msg.stage;
    // mirror snapshots into a read-only session-shaped object for the UI
    app.session = hostedSessionFacade({ state: msg.state });
    $('#btn-undo').hidden = true;
    $('#btn-call').disabled = true; // host is the caller
    $('#btn-claim').disabled = true;
    $('#hint-text').textContent = '';
    buildCardDom();
    showScreen('play');
    if (!app.renderer) app.renderer = new HallRenderer($('#canvas-holder'));
    if (app.renderer.ok) { app.renderer.onCellPick = (cell) => hostedMark(cell); app.renderer.resize(); }
    setPhase('active', 'hosted round');
    if (app.hosted.spectator) setStatus('Spectating this round — you will be seated for the next one.');
    syncPlayUi();
    const last = app.session.state.currentCall;
    if (last) { $('#call-display').textContent = String(last); if (app.renderer.ok) app.renderer.showCall(last); }
  } else if (msg.type === 'snapshot') {
    if (app.hosted.isHost) return;
    const prevCall = app.session.state.currentCall;
    app.session.state = deserializeState(msg.state);
    if (app.hosted.seats && Array.isArray(msg.seats)) app.hosted.seats = msg.seats;
    if (app.session.state.currentCall !== prevCall) {
      audio.event('call');
      $('#call-display').textContent = String(app.session.state.currentCall);
      if (app.renderer.ok) app.renderer.showCall(app.session.state.currentCall);
      announce('Called ' + app.session.state.currentCall);
    }
    if (app.session.state.ended) {
      const winner = app.session.state.winner;
      setPhase('resolving');
      setTimeout(() => {
        if (!app.session || app.mode !== 'hosted' || !app.hosted || app.hosted.isHost) return; // left meanwhile
        showHostedResults(winner);
      }, 900);
    }
    syncPlayUi();
  } else if (msg.type === 'rejected') {
    if (msg.to && msg.to !== selfId) return;
    announce('Rejected: ' + msg.reason);
    $('#hint-text').textContent = msg.reason;
    audio.event('invalid');
  }
}

function startHostedLegacy(reconnect) {
  setStatus(reconnect ? 'Reconnecting to hall…' : 'Connecting to hall…');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  try { ws = new WebSocket(proto + '//' + location.host + '/ws'); }
  catch (e) { hostedFail(); return; }
  const timeout = setTimeout(() => { try { ws.close(); } catch (_) {} hostedFail(); }, 4000);
  ws.onopen = () => {
    clearTimeout(timeout);
    // reclaim our seat after a reconnect; the server ignores unknown ids
    const reclaim = app.hosted && app.hosted.playerId;
    ws.send(JSON.stringify(reclaim ? { type: 'join', playerId: reclaim } : { type: 'join' }));
  };
  ws.onerror = hostedFail;
  ws.onclose = () => {
    if (app.mode === 'hosted' && app.gamePhase === 'active' && !reconnect) {
      setStatus('Disconnected from hall. Reconnecting…');
      setTimeout(() => {
        if (app.mode === 'hosted' && app.gamePhase === 'active') startHosted(true);
      }, 1500);
    }
  };
  ws.onmessage = (m) => {
    let msg;
    try { msg = JSON.parse(m.data); } catch (_) { return; }
    // ignore frames arriving after we left the hosted round (socket closing)
    if (msg.type !== 'joined' && (!app.session || app.mode !== 'hosted')) return;
    if (msg.type === 'joined') {
      app.mode = 'hosted';
      app.hosted = { ws, playerId: msg.playerId, roomId: msg.roomId, spectator: !!msg.spectator };
      app.stage = msg.stage;
      // mirror snapshots into a read-only session-shaped object for the UI
      app.session = hostedSessionFacade(msg);
      $('#btn-undo').hidden = true;
      $('#btn-call').disabled = true; // server is the caller
      buildCardDom();
      showScreen('play');
      if (!app.renderer) app.renderer = new HallRenderer($('#canvas-holder'));
      if (app.renderer.ok) { app.renderer.onCellPick = (cell) => hostedMark(cell); app.renderer.resize(); }
      setPhase('active', 'hosted round');
      if (msg.spectator) setStatus('Spectating this round — you will be seated for the next one.');
      if (msg.whileAway) setStatus(msg.whileAway);
      syncPlayUi();
      const last = app.session.state.currentCall;
      if (last) { $('#call-display').textContent = String(last); if (app.renderer.ok) app.renderer.showCall(last); }
    } else if (msg.type === 'snapshot') {
      const prevCall = app.session.state.currentCall;
      app.session.state = deserializeState(msg.state);
      if (app.session.state.currentCall !== prevCall) {
        audio.event('call');
        $('#call-display').textContent = String(app.session.state.currentCall);
        if (app.renderer.ok) app.renderer.showCall(app.session.state.currentCall);
        announce('Called ' + app.session.state.currentCall);
      }
      if (app.session.state.ended) {
        const winner = app.session.state.winner;
        setPhase('resolving');
        setTimeout(() => {
          if (!app.session || app.mode !== 'hosted' || !app.hosted) return; // left meanwhile
          showHostedResults(winner);
        }, 900);
      }
      syncPlayUi();
    } else if (msg.type === 'rejected') {
      announce('Rejected: ' + msg.reason);
      $('#hint-text').textContent = msg.reason;
      audio.event('invalid');
    }
  };
  function hostedFail() {
    clearTimeout(timeout);
    setStatus('Hosted play is unavailable (no hall server). Try Practice instead.');
    announce('Hosted play unavailable');
  }
}

function hostedSessionFacade(msg) {
  // Methods read this.state so snapshot replacement never leaves stale closures.
  return {
    state: deserializeState(msg.state),
    get ended() { return this.state.phase === 'ended'; },
    legalActions(id) { return hostedLegal(this.state, id); },
    score(id) { return hostedScore(this.state, id); },
    ranking() { return hostedRanking(this.state); },
    exportReplay: () => msg.replay || {},
    onEvent: () => {},
  };
}

import { legalActions as rulesLegal, scoreBreakdown, compareResults } from './rules.js';
function hostedLegal(state, id) { return rulesLegal(state, id); }
function hostedScore(state, id) { return scoreBreakdown(state, id); }
function hostedRanking(state) { return state.players.map(p => p.id).sort((a, b) => compareResults(state, a, b)); }

function hostedSend(cmd) {
  if (!app.hosted) return;
  if (app.hosted.isHost) {
    // the host's own claim lands in the authoritative session directly
    if (app.gamePhase !== 'active' || !hallHost) return;
    const r = hallHost.dispatch({ ...cmd, player: 'you' });
    if (!r.ok) {
      audio.event('invalid');
      const msg = 'Pattern not complete yet — false claim −25.';
      $('#hint-text').textContent = msg;
      announce(msg);
    }
    syncPlayUi();
    return;
  }
  if (app.hosted.socket && app.hosted.socket.ws.readyState === 1) {
    app.hosted.socket.sendBinary({ type: 'cmd', cmd });
  } else if (app.hosted.ws && app.hosted.ws.readyState === 1) {
    app.hosted.ws.send(JSON.stringify({ type: 'cmd', cmd }));
  }
}
function hostedMark(cell) {
  if (app.gamePhase !== 'active' || !app.hosted) return;
  if (app.hosted.isHost) {
    if (cell === CENTER) return; // free cell is pre-marked; selecting it is never a penalty
    const ack = 'mark-' + cell + '-' + app.session.state.tick;
    if (app.pendingAck.has(ack)) return;
    app.pendingAck.add(ack);
    setTimeout(() => app.pendingAck.delete(ack), 400);
    const r = hallHost.dispatch({ type: 'mark', player: 'you', cell });
    if (!r.ok) {
      audio.event('invalid');
      const me = app.session.state.players[0];
      const msg = r.error === 'already-marked' ? 'Already marked.'
        : r.error === 'number-not-called' ? `Number ${me.card[cell]} has not been called yet.`
        : r.error;
      $('#hint-text').textContent = msg;
      announce(msg);
    } else {
      audio.event('mark');
      $('#hint-text').textContent = '';
    }
    syncPlayUi();
    return;
  }
  if (app.hosted.spectator) {
    const msg = 'Spectating — you will be seated for the next round.';
    $('#hint-text').textContent = msg;
    announce(msg);
    return;
  }
  if (cell === CENTER) return;
  hostedSend({ type: 'mark', cell });
}

function showHostedResults(winner) {
  setPhase('results');
  const state = app.session.state;
  const myId = meId() || state.players[0].id;
  const sb = hostedScore(state, myId);
  const won = state.winner === myId;
  audio.event(won ? 'win' : 'lose');
  const ranking = hostedRanking(state);
  // Retry would start a broken local round in hosted mode; replay envelopes
  // are server-owned. Both are hidden for hosted results.
  $('#results-retry').hidden = true;
  $('#results-replay').hidden = true;
  $('#results-next').textContent = 'Continue';
  $('#results-body').innerHTML = `
    <h3>${won ? '🏮 Bingo! You lit the hall.' : winner ? hostedName(winner) + ' claimed first.' : 'Round ended.'}</h3>
    <p class="muted">Authoritative result from the hall host · Reason: ${state.terminalReason}</p>
    <table class="score-table">
      <tr><td>Pattern bonus</td><td>+${sb.patternBase}</td></tr>
      <tr><td>Line bonus</td><td>+${sb.lineBonus}</td></tr>
      <tr><td>Marks</td><td>+${sb.marksScore}</td></tr>
      <tr><td>Invalid actions</td><td>−${sb.invalidPenalty}</td></tr>
      <tr class="total"><td>Total</td><td>${sb.total}</td></tr>
    </table>
    <h4>Ranking</h4>
    <table class="score-table">${ranking.map((id, i) => `<tr><td>${i + 1}. ${id === myId ? 'You' : hostedName(id)}</td><td>${hostedScore(state, id).total}</td></tr>`).join('')}</table>`;
  showScreen('results');
}

// ---------------------------------------------------------------- graphics settings
const gfxT = GFX_STRINGS[pickLocale(navigator.languages || [navigator.language])];
const titleFx = new TitleFx($('#screen-title'), () => app.screen === 'title' && !document.hidden);
titleFx.onFrame = (dt) => {
  if (!gfxFrame(dt)) return;
  const g = currentGfx();
  titleFx.set(g, store.data.settings.reducedMotion, gfxPixelRatio(g));
};
document.addEventListener('visibilitychange', () => titleFx.kick());

function gfxSaved() {
  const s = store.data.settings;
  if (!s.graphics || typeof s.graphics !== 'object') s.graphics = { preset: 'auto' };
  return s.graphics;
}

/** Apply the saved graphics settings everywhere: hall, title, DOM card, panel. */
function applyGraphics() {
  const g = currentGfx();
  document.body.dataset.gfxPreset = g.preset;
  document.body.classList.toggle('gfx-detailed', g.detail === 'detailed');
  document.body.classList.toggle('gfx-animated', g.background === 'animated');
  document.body.classList.toggle('gfx-bloom', g.bloom === 'on');
  fpsMeter(g.showFps);
  titleFx.set(g, store.data.settings.reducedMotion, gfxPixelRatio(g));
  if (app.renderer && app.renderer.ok) app.renderer.setGraphics(g);
  refreshGfxPanel();
}

function gfxOption(value, label) {
  const o = document.createElement('option');
  o.value = value; o.textContent = label;
  return o;
}

function buildGfxPanel() {
  const panel = $('#gfx-panel');
  $('#gfx-legend').textContent = gfxT.graphics;
  panel.textContent = '';
  const row = (labelText, control, extra) => {
    const l = document.createElement('label');
    const span = document.createElement('span');
    span.textContent = labelText;
    l.append(span, control);
    if (extra) l.append(extra);
    panel.append(l);
    return l;
  };
  const preset = document.createElement('select');
  preset.id = 'gfx-preset';
  preset.dataset.gfx = 'preset';
  row(gfxT.quality, preset);

  const scale = document.createElement('input');
  Object.assign(scale, { type: 'range', id: 'gfx-scale', min: '50', max: '200', step: '5' });
  scale.dataset.gfx = 'render_scale';
  const scaleOut = document.createElement('output');
  scaleOut.id = 'gfx-scale-val';
  scaleOut.className = 'gfx-scale-val';
  row(gfxT.renderScale, scale, scaleOut).classList.add('gfx-scale-row');

  for (const cat of Object.keys(CATEGORIES)) {
    const sel = document.createElement('select');
    sel.id = `gfx-${cat}`;
    sel.dataset.gfx = 'cat';
    sel.dataset.gfxCat = cat;
    row(gfxT.cat[cat], sel);
  }
  const check = (id, key, text) => {
    const l = document.createElement('label');
    l.className = 'gfx-check';
    const c = document.createElement('input');
    Object.assign(c, { type: 'checkbox', id });
    c.dataset.gfx = key;
    const span = document.createElement('span');
    span.textContent = text;
    l.append(c, span);
    panel.append(l);
  };
  check('gfx-adaptive', 'adaptive', gfxT.adaptive);
  check('gfx-fps', 'show_fps', gfxT.showFps);
  const sum = document.createElement('p');
  sum.id = 'gfx-summary';
  sum.className = 'gfx-summary muted';
  sum.setAttribute('aria-live', 'polite');
  const note = document.createElement('p');
  note.id = 'gfx-post-note';
  note.className = 'gfx-note';
  note.hidden = true;
  note.textContent = gfxT.postUnavailable;
  panel.append(sum, note);

  panel.addEventListener('input', onGfxInput);
  panel.addEventListener('change', onGfxInput);
}

function onGfxInput(e) {
  const el = e.target;
  if (!el.dataset || !el.dataset.gfx) return;
  // sliders apply while dragging; selects and checkboxes on change
  if (el.type === 'range' ? e.type !== 'input' : e.type !== 'change') return;
  let saved = gfxSaved();
  switch (el.dataset.gfx) {
    case 'preset': saved = choosePreset(saved, el.value); break;
    case 'render_scale': saved.render_scale = Number(el.value) / 100; break;
    case 'adaptive': saved.adaptive = el.checked; gfxRuntime.adaptiveScale = 1; break;
    case 'show_fps': saved.show_fps = el.checked; break;
    case 'cat':
      if (el.value === 'preset') delete saved[el.dataset.gfxCat];
      else saved[el.dataset.gfxCat] = el.value;
      break;
    default: return;
  }
  store.data.settings.graphics = saved;
  gfxRuntime.frames.length = 0;
  store.save();
  applyGraphics();
}

/** Sync the Graphics controls and summary with the current settings. */
function refreshGfxPanel() {
  const panel = $('#gfx-panel');
  if (!panel || !panel.firstChild) return;
  const saved = gfxSaved();
  const g = currentGfx();
  const tierName = (p) => gfxT[p] || p;
  const preset = $('#gfx-preset');
  if (!preset.options.length) {
    preset.append(gfxOption('auto', gfxT.auto.replace('{tier}', tierName(gfxEnv.detected))));
    for (const p of PRESETS) preset.append(gfxOption(p, tierName(p)));
  }
  preset.value = PRESETS.includes(saved.preset) ? saved.preset : 'auto';
  const pct = Math.round(g.renderScale * 100);
  $('#gfx-scale').value = String(pct);
  $('#gfx-scale-val').textContent = `${pct}%`;
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    const sel = $(`#gfx-${cat}`);
    sel.textContent = '';
    sel.append(gfxOption('preset', gfxT.fromPreset.replace('{tier}', gfxT.tier[presetTier(g.preset, cat)])));
    for (const t of tiers) sel.append(gfxOption(t, gfxT.tier[t]));
    sel.value = tiers.includes(saved[cat]) ? saved[cat] : 'preset';
  }
  $('#gfx-adaptive').checked = g.adaptive;
  $('#gfx-fps').checked = g.showFps;
  const r = app.renderer && app.renderer.ok ? app.renderer.pixels() : null;
  const pr = gfxPixelRatio(g);
  const px = r || [Math.round(window.innerWidth * pr), Math.round(window.innerHeight * pr)];
  $('#gfx-summary').textContent = `${gfxEnv.gpu || gfxT.gpuUnknown} · ${describe(g, px, gfxT.sum)}`;
  $('#gfx-post-note').hidden = !gfxRuntime.postFailed;
}

// ---------------------------------------------------------------- settings
let settingsReturnPause = false;
function openSettings(fromPause) {
  settingsReturnPause = !!fromPause;
  const s = store.data.settings;
  const f = $('#settings-form');
  f.elements['vol-music'].value = s.volumes.music;
  f.elements['vol-effects'].value = s.volumes.effects;
  f.elements['vol-ambience'].value = s.volumes.ambience;
  f.elements['vol-voice'].value = s.volumes.voice;
  f.elements['muted'].checked = s.muted;
  f.elements['theme'].value = s.theme;
  f.elements['reducedMotion'].checked = s.reducedMotion;
  f.elements['highContrast'].checked = s.highContrast;
  f.elements['largeText'].checked = s.largeText;
  f.elements['leftHanded'].checked = s.leftHanded;
  f.elements['callSpeed'].value = String(s.callSpeed);
  f.elements['autoHint'].checked = s.autoHint;
  refreshGfxPanel();
  showScreen('settings');
}

$('#settings-form').addEventListener('input', (e) => {
  if (e.target.dataset && e.target.dataset.gfx) return; // Graphics controls handle themselves
  const f = e.target.form;
  const s = store.data.settings;
  s.volumes.music = Number(f.elements['vol-music'].value);
  s.volumes.effects = Number(f.elements['vol-effects'].value);
  s.volumes.ambience = Number(f.elements['vol-ambience'].value);
  s.volumes.voice = Number(f.elements['vol-voice'].value);
  s.muted = f.elements['muted'].checked;
  s.theme = f.elements['theme'].value;
  s.reducedMotion = f.elements['reducedMotion'].checked;
  s.highContrast = f.elements['highContrast'].checked;
  s.largeText = f.elements['largeText'].checked;
  s.leftHanded = f.elements['leftHanded'].checked;
  s.callSpeed = Number(f.elements['callSpeed'].value);
  s.autoHint = f.elements['autoHint'].checked;
  store.save();
  applyAudioSettings();
  applyAccessibility();
  if (app.renderer && app.renderer.ok) app.renderer.applyTheme(s.theme);
  applyGraphics(); // reduced motion also freezes the hall and title lanterns
  if (app.screen === 'play') { scheduleNextCall(); syncPlayUi(); }
});

function applyAccessibility() {
  const s = store.data.settings;
  document.body.classList.toggle('reduced-motion', s.reducedMotion);
  document.body.classList.toggle('high-contrast', s.highContrast);
  document.body.classList.toggle('large-text', s.largeText);
  document.body.classList.toggle('left-handed', s.leftHanded);
}

$('#settings-reset').addEventListener('click', () => {
  openModal('Reset progress', '<p>This clears journey progress, best scores, and achievements on this device. Settings are kept. Continue?</p>', [
    { label: 'Cancel', primary: true, onClick: () => { closeModal(); openSettings(settingsReturnPause); } },
    { label: 'Reset', onClick: () => {
      store.data.progress = defaultSave().progress;
      store.save(); closeModal(); openSettings(settingsReturnPause);
      setStatus('Progress reset.');
    } },
  ]);
});

// Settings "Done" navigates back to pause if we came from there. Must swallow
// the click so the global data-nav handler doesn't also run nav('title'),
// which would abandon the paused round.
$$('#screen-settings [data-nav="title"]').forEach(b => b.addEventListener('click', (e) => {
  if (settingsReturnPause && app.session && !app.session.ended) {
    e.stopPropagation();
    audio.event('ui');
    settingsReturnPause = false;
    showScreen('play');
    setPhase('active', 'settings closed');
    pauseGame();
  }
}));

// Help "Back" likewise returns to the pause modal when opened from pause.
$$('#screen-help [data-nav="title"]').forEach(b => b.addEventListener('click', (e) => {
  if (helpReturnPause && app.session && !app.session.ended) {
    e.stopPropagation();
    audio.event('ui');
    helpReturnPause = false;
    showScreen('play');
    setPhase('active', 'help closed');
    pauseGame();
  }
}));

// ---------------------------------------------------------------- navigation
function nav(to) {
  audio.event('ui');
  switch (to) {
    case 'title': abandonIfPlaying(); showScreen('title'); refreshTitleProgress(); break;
    case 'play-quick': openSetup('practice', practiceStage('normal')); break;
    case 'journey': buildJourneyList(); showScreen('journey'); break;
    case 'learn': buildLearnList(); showScreen('learn'); break;
    case 'daily': openDaily(); break;
    case 'practice': openPracticePicker(); break;
    case 'challenge': openChallengePicker(); break;
    case 'hosted': startHosted(); break;
    case 'settings': openSettings(false); break;
    case 'help': showScreen('help'); break;
    default: break;
  }
}

function abandonIfPlaying() {
  if (app.session && !app.session.ended && (app.gamePhase === 'active' || app.gamePhase === 'paused')) abandonRound();
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-nav]');
  if (b) nav(b.dataset.nav);
});

function practiceStage(difficulty) {
  const map = {
    easy:   { pattern: 'any-line', bots: 1, botSkill: 0.4, parCalls: 42 },
    normal: { pattern: 'two-lines', bots: 2, botSkill: 0.6, parCalls: 58 },
    hard:   { pattern: 'frame', bots: 3, botSkill: 0.8, parCalls: 70 },
  }[difficulty];
  return {
    id: 'practice-' + difficulty + '-' + Date.now(), title: 'Practice (' + difficulty + ')',
    seed: (Math.floor(Math.random() * 2 ** 31)) >>> 0, version: CONTENT_VERSION,
    pattern: map.pattern, bots: map.bots, botSkill: map.botSkill, parCalls: map.parCalls,
    ranked: false, expectedMinutes: 4, theme: store.data.settings.theme,
  };
}

function openPracticePicker() {
  openModal('Practice', '<p>Select difficulty. Practice is unranked and undo is allowed.</p>', [
    { label: 'Easy', onClick: () => { closeModal(); openSetup('practice', practiceStage('easy')); } },
    { label: 'Normal', primary: true, onClick: () => { closeModal(); openSetup('practice', practiceStage('normal')); } },
    { label: 'Hard', onClick: () => { closeModal(); openSetup('practice', practiceStage('hard')); } },
    { label: 'Cancel', onClick: closeModal },
  ]);
}

function openChallengePicker() {
  openModal('Challenge', '<p>Constrained ranked goals. Pick one:</p>' +
    CHALLENGES.map(c => `<p><strong>${c.title}</strong> — ${c.constraint}</p>`).join(''),
    CHALLENGES.map((c, i) => ({
      label: c.title, primary: i === 0,
      onClick: () => { closeModal(); openSetup('challenge', c); },
    })).concat([{ label: 'Cancel', onClick: closeModal }]));
}

function openDaily() {
  // Daily Lantern is seeded by the local UTC day — identical for everyone on
  // the same day, no server clock needed (the old /api/v1/time probe was a
  // fabricated platform route and is gone).
  const day = new Date().toISOString().slice(0, 10);
  const stage = dailyFor(day);
  const played = store.data.progress.dailyHistory[day];
  openSetup('daily', { ...stage, title: stage.title + (played != null ? ` (today's best: ${played})` : '') });
}

function refreshTitleProgress() {
  const p = store.data.progress;
  $('#title-progress').textContent =
    `Journey ${p.journeyDone.length}/${JOURNEY_STAGES.length} · Achievements ${Object.keys(p.achievements).length}/${Object.keys(ACHIEVEMENTS).length} · Rounds played ${p.gamesPlayed}`;
}

// Account nickname + cloud sync status (hosted mode only; hidden offline so
// local play looks exactly as it always has).
function refreshAccountLine() {
  const el = $('#account-line');
  if (!el) return;
  if (!platform.hosted) { el.hidden = true; return; }
  el.hidden = false;
  const statusText = {
    synced: 'cloud save synced', saving: 'saving…',
    error: 'cloud save offline', offline: 'cloud save offline',
  }[platform.syncStatus] || String(platform.syncStatus);
  el.textContent = `${shT.playingAs.replace('{name}', platform.nickname || '…')} · ${statusText}`;
}

// Sign-in (only on <id>.starhermit.com without a token) and invite link
// (only when signed in). Both hidden for local play.
function refreshAccountButtons() {
  $('#btn-signin').hidden = !platform.canSignIn();
  $('#btn-invite').hidden = !platform.hosted;
}
let toastTimer = null;
function toast(text) {
  const el = $('#sh-toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}
$('#btn-signin').textContent = shT.signIn;
$('#btn-invite').textContent = shT.invite;
$('#btn-signin').addEventListener('click', () => { audio.event('ui'); platform.signIn(); });
$('#btn-invite').addEventListener('click', async () => {
  audio.event('ui');
  const link = platform.inviteLink();
  if (!link) return;
  try { await navigator.clipboard.writeText(link); toast(shT.copied); }
  catch (_) { toast(shT.copyFailed); }
});
platform.onAuth((a) => {
  refreshAccountLine();
  refreshAccountButtons();
  if (!a.signedIn) toast(shT.signedOut); // keep playing locally
});

// Seat display name in a hosted hall (host-provided), else the raw id.
function hostedName(id) {
  if (app.hosted && app.hosted.seats) {
    const seat = app.hosted.seats.find(s => s.playerId === id);
    if (seat && seat.name) return seat.name;
  }
  return id === 'you' ? 'You' : id;
}

// ---------------------------------------------------------------- action tray
$('#btn-call').addEventListener('click', () => { audio.event('ui'); if (app.mode !== 'hosted') doCall(); });
$('#btn-claim').addEventListener('click', () => { if (app.mode === 'hosted') hostedSend({ type: 'claim' }); else tryClaim(); });
$('#btn-undo').addEventListener('click', () => { if (app.session && app.session.undo()) { audio.event('ui'); syncPlayUi(); } });
$('#btn-hint').addEventListener('click', () => {
  if (!app.session) return;
  const acts = app.session.legalActions(meId());
  const mark = acts.find(a => a.type === 'mark');
  const me = mePlayer(app.session.state);
  const msg = mark ? `Callable now: ${mark.cells.map(i => me.card[i]).join(', ')}.`
    : patternComplete(me.marks, app.session.state.pattern) ? 'Pattern complete — press Claim!'
    : 'Nothing callable yet. Wait for the next call.';
  $('#hint-text').textContent = msg;
  announce(msg);
  audio.event('ui');
});
$('#btn-pause').addEventListener('click', () => { audio.event('ui'); pauseGame(); });

// ---------------------------------------------------------------- keyboard
function moveFocus(dx, dy) {
  const r = Math.floor(app.focusCell / GRID), c = app.focusCell % GRID;
  const nr = (r + dy + GRID) % GRID, nc = (c + dx + GRID) % GRID;
  app.focusCell = nr * GRID + nc;
  $$('#card-grid .card-cell').forEach((el, i) => { el.tabIndex = i === app.focusCell ? 0 : -1; });
  const el = $('#card-grid .card-cell[data-cell="' + app.focusCell + '"]');
  if (el) el.focus();
}

// Key bindings: defaults mirror the control.* lines in starhermit.txt; the
// player's StarHermit overrides replace them at boot. Routed by event.code.
const DEFAULT_BINDINGS = {
  left: ['ArrowLeft'], right: ['ArrowRight'], up: ['ArrowUp'], down: ['ArrowDown'],
  mark: ['Enter'], call: ['Space'], claim: ['KeyC'], undo: ['KeyU'], hint: ['KeyH'],
  pause: ['KeyP'], camera: ['KeyR'], back: ['Escape'],
};
let bindings = DEFAULT_BINDINGS;
let codeToAction = new Map();
function setBindings(b) {
  bindings = b;
  codeToAction = new Map();
  for (const [action, codes] of Object.entries(b)) for (const c of codes) codeToAction.set(c, action);
  renderKeyHints();
}
function keyLabel(code) {
  if (!code) return '';
  const arrows = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };
  if (arrows[code]) return arrows[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (code === 'Escape') return 'Esc';
  return code;
}
function renderKeyHints() {
  $$('kbd[data-key]').forEach((k) => { k.textContent = keyLabel((bindings[k.dataset.key] || [])[0]); });
}
setBindings(DEFAULT_BINDINGS);

document.addEventListener('keydown', (e) => {
  const act = codeToAction.get(e.code);
  if ($('#modal-root').open) {
    if (act === 'back' && app.gamePhase === 'paused') { e.preventDefault(); resumeGame(); }
    return;
  }
  if (app.screen === 'play') {
    switch (act) {
      case 'left': e.preventDefault(); moveFocus(-1, 0); return;
      case 'right': e.preventDefault(); moveFocus(1, 0); return;
      case 'up': e.preventDefault(); moveFocus(0, -1); return;
      case 'down': e.preventDefault(); moveFocus(0, 1); return;
      case 'mark': e.preventDefault(); markCell(app.focusCell); return;
      case 'call':
        e.preventDefault();
        if (document.activeElement && document.activeElement.classList.contains('card-cell')) markCell(app.focusCell);
        else if (app.mode !== 'hosted') doCall();
        return;
      case 'claim': if (app.mode === 'hosted') hostedSend({ type: 'claim' }); else tryClaim(); return;
      case 'undo': if (!$('#btn-undo').hidden && app.session && app.session.undo()) { audio.event('ui'); syncPlayUi(); } return;
      case 'hint': $('#btn-hint').click(); return;
      case 'pause': app.gamePhase === 'paused' ? resumeGame() : pauseGame(); return;
      case 'camera': if (app.renderer && app.renderer.ok) app.renderer.resetCamera(); return;
      case 'back': pauseGame(); return;
      default: return;
    }
  } else if (act === 'back' && app.screen !== 'title') {
    // route through the pause-aware Back/Done buttons when those flows are active;
    // preventDefault so the same Escape can't immediately cancel the pause
    // modal those buttons reopen
    if (app.screen === 'settings' && settingsReturnPause) { e.preventDefault(); $('#screen-settings [data-nav="title"]').click(); return; }
    if (app.screen === 'help' && helpReturnPause) { e.preventDefault(); $('#screen-help [data-nav="title"]').click(); return; }
    nav('title');
  }
});

// ---------------------------------------------------------------- boot
function boot() {
  store.load();
  applyAudioSettings();
  applyAccessibility();
  buildGfxPanel();
  refreshTitleProgress();
  refreshAccountLine();
  refreshAccountButtons();
  showScreen('title');
  applyGraphics();
  setPhase('title', 'ready');
  // audio contexts need a user gesture; unlock on first interaction
  const unlockAudio = () => { audio.ensure(); audio.startAmbience(); document.removeEventListener('pointerdown', unlockAudio); };
  document.addEventListener('pointerdown', unlockAudio);
  if (platform.hosted) {
    // Remote-preferred cloud load: a valid remote save replaces the local
    // cache; a missing/corrupt remote leaves local play untouched.
    platform.loadProfile().then(() => {
      refreshAccountLine();
      if (hallHost) hallHost.me().name = platform.nickname || hallHost.me().name;
    });
    platform.loadBindings(DEFAULT_BINDINGS).then(setBindings);
    // Remote-first: cloud save, then the settings KV on top (platform wins).
    store.cloudHold = true;
    Promise.all([platform.loadCloud(), platform.loadSettings()]).catch(() => [null, null]).then(([remote, kv]) => {
      const adopted = store.adoptRemote(remote);
      const tuned = store.adoptSettings(kv);
      // A save held during the load is stale once the remote doc is adopted.
      store.cloudHold = false;
      if (store.cloudHeld && !adopted) platform.pushCloud(store.data);
      store.cloudHeld = false;
      platform.primeSettings(store.data.settings);
      if (!adopted && !tuned) return;
      applyAudioSettings();
      applyAccessibility();
      refreshTitleProgress();
      refreshAccountLine();
      if (app.renderer && app.renderer.ok) app.renderer.applyTheme(store.data.settings.theme);
      applyGraphics();
    });
  }
}

boot();
