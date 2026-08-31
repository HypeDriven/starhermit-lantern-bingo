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

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

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
    muted: false, quality: 'medium', theme: 'ember',
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
  save() {
    const payload = JSON.stringify(this.data);
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ payload, checksum: checksum(payload) })); } catch (_) {}
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

// ---------------------------------------------------------------- renderer
const QUALITY = {
  low:    { dpr: 1,    lanterns: 12, shadows: false, sway: false },
  medium: { dpr: 1.5,  lanterns: 24, shadows: false, sway: true  },
  high:   { dpr: 2,    lanterns: 40, shadows: true,  sway: true  },
};

class HallRenderer {
  constructor(holder) {
    this.holder = holder;
    this.ok = false;
    this.cells = [];
    this.lanterns = null;
    this.onCellPick = null;
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._build();
  }

  _build() {
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'default' });
    } catch (e) {
      this._fail('3D graphics are unavailable in this browser. The card below remains fully playable.');
      return;
    }
    this.renderer = renderer;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    this.holder.appendChild(renderer.domElement);

    renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this._fail('Graphics context was lost. Reload the page to restore the 3D hall — your progress is saved.');
    });

    this.scene = new THREE.Scene();
    // authored framing constants
    this.camera = new THREE.PerspectiveCamera(42, 4 / 3, 0.1, 100);
    this.cameraHome = new THREE.Vector3(0, 4.4, 9.2);
    this.cameraLook = new THREE.Vector3(0, 0.8, 0);
    this.camera.position.copy(this.cameraHome);
    this.camera.lookAt(this.cameraLook);

    const key = new THREE.DirectionalLight(0xfff2dd, 3.2);
    key.position.set(4, 8, 5);
    this.scene.add(key);
    this.keyLight = key;
    this.scene.add(new THREE.HemisphereLight(0x8899bb, 0x443355, 1.6));
    // warm glow over the call ball
    const ballLight = new THREE.PointLight(0xffc370, 30, 12, 1.8);
    ballLight.position.set(0, 3.4, 1.5);
    this.scene.add(ballLight);

    // floor
    this.floor = new THREE.Mesh(
      new THREE.CylinderGeometry(7.5, 7.5, 0.2, 48),
      new THREE.MeshStandardMaterial({ color: 0x2b2135, roughness: 0.9 }));
    this.floor.position.y = -0.1;
    this.scene.add(this.floor);

    // call ball — the visual hero of the current call
    this.ballCanvas = document.createElement('canvas');
    this.ballCanvas.width = this.ballCanvas.height = 128;
    this.ballTexture = new THREE.CanvasTexture(this.ballCanvas);
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.85, 32, 24),
      new THREE.MeshStandardMaterial({
        color: 0xfff4e0, roughness: 0.3, map: this.ballTexture,
        emissive: 0xffffff, emissiveMap: this.ballTexture, emissiveIntensity: 0.85,
      }));
    this.ball.position.set(0, 2.6, 0);
    this.scene.add(this.ball);
    this.ballPole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 2.2, 8),
      new THREE.MeshStandardMaterial({ color: 0x554433, roughness: 0.8 }));
    this.ballPole.position.set(0, 1.0, 0);
    this.scene.add(this.ballPole);

    // 3D card cells (raycast interaction layer, mirrors the DOM grid)
    const cellGeo = new THREE.BoxGeometry(0.62, 0.08, 0.62);
    this.cellGroup = new THREE.Group();
    for (let i = 0; i < CELLS; i++) {
      const r = Math.floor(i / GRID), c = i % GRID;
      const m = new THREE.Mesh(cellGeo, new THREE.MeshStandardMaterial({ color: 0x2b3a67, roughness: 0.6 }));
      m.position.set((c - 2) * 0.72, 0.04, 1.9 + (r - 2) * 0.72);
      m.userData.cell = i;
      this.cellGroup.add(m);
      this.cells.push(m);
    }
    this.scene.add(this.cellGroup);

    this._buildLanterns(QUALITY[store.data.settings.quality].lanterns);
    this.applyTheme(store.data.settings.theme);
    this.applyQuality(store.data.settings.quality);

    renderer.domElement.addEventListener('pointerdown', (e) => this._pick(e));
    window.addEventListener('resize', () => this.resize());
    this.resize();

    this._t = 0;
    this._running = true;
    this.ok = true;
    const loop = (ts) => {
      if (!this._running) return;
      requestAnimationFrame(loop);
      const q = QUALITY[store.data.settings.quality];
      if (!document.hidden) {
        const dt = Math.min(0.05, (ts - (this._last || ts)) / 1000);
        this._last = ts;
        if (q.sway && !store.data.settings.reducedMotion) this._t += dt;
        this._animate();
        renderer.render(this.scene, this.camera);
      }
    };
    requestAnimationFrame(loop);
  }

  _fail(msg) {
    const p = document.createElement('p');
    p.className = 'webgl-fail';
    p.textContent = msg;
    p.style.padding = '1em';
    this.holder.appendChild(p);
  }

  _buildLanterns(count) {
    if (this.lanterns) {
      this.scene.remove(this.lanterns);
      this.lanterns.geometry.dispose();
      this.lanterns.material.dispose();
    }
    const geo = new THREE.SphereGeometry(0.28, 12, 10);
    geo.scale(1, 1.25, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: this._lanternColor || 0xffb454,
      emissive: this._lanternColor || 0xffb454, emissiveIntensity: 1.5, roughness: 0.5,
    });
    const inst = new THREE.InstancedMesh(geo, mat, count);
    const dummy = new THREE.Object3D();
    this._lanternData = [];
    const rngRows = Math.ceil(count / 8);
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / 8), col = i % 8;
      const x = (col - 3.5) * 1.5 + (row % 2) * 0.75;
      const z = -1.6 - row * (3.4 / Math.max(1, rngRows));
      const y = 3.5 + ((i * 37) % 10) / 16;
      const phase = (i * 0.77) % (Math.PI * 2);
      this._lanternData.push({ x, y, z, phase });
      dummy.position.set(x, y, z);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    this.lanterns = inst;
    this.scene.add(inst);
  }

  applyTheme(themeId) {
    const t = THEMES.find(x => x.id === themeId) || THEMES[0];
    this._lanternColor = t.lantern;
    if (!this.scene) return;
    this.scene.background = new THREE.Color(t.bg);
    this.scene.fog = new THREE.Fog(t.bg, 12, 26);
    this.floor.material.color.setHex(t.floor);
    if (this.lanterns) {
      this.lanterns.material.color.setHex(t.lantern);
      this.lanterns.material.emissive.setHex(t.lantern);
    }
  }

  applyQuality(q) {
    const tier = QUALITY[q] || QUALITY.medium;
    if (!this.renderer) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.dpr));
    this.renderer.shadowMap.enabled = tier.shadows;
    this.keyLight.castShadow = tier.shadows;
    if (this.lanterns && this.lanterns.count !== tier.lanterns) this._buildLanterns(tier.lanterns);
    this.resize();
  }

  resize() {
    if (!this.renderer) return;
    const w = this.holder.clientWidth || 320, h = this.holder.clientHeight || 240;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  resetCamera() {
    this.camera.position.copy(this.cameraHome);
    this.camera.lookAt(this.cameraLook);
  }

  _animate() {
    const t = this._t;
    if (this.lanterns && t !== 0) {
      const dummy = new THREE.Object3D();
      for (let i = 0; i < this._lanternData.length; i++) {
        const d = this._lanternData[i];
        dummy.position.set(d.x + Math.sin(t * 0.6 + d.phase) * 0.08, d.y + Math.sin(t * 0.8 + d.phase) * 0.05, d.z);
        dummy.updateMatrix();
        this.lanterns.setMatrixAt(i, dummy.matrix);
      }
      this.lanterns.instanceMatrix.needsUpdate = true;
    }
    if (this._ballPop > 0) {
      this._ballPop = Math.max(0, this._ballPop - 0.04);
      const s = 1 + Math.sin(this._ballPop * Math.PI) * 0.25;
      this.ball.scale.setScalar(s);
    }
  }

  showCall(value) {
    const ctx = this.ballCanvas.getContext('2d');
    ctx.fillStyle = '#fff2dc';
    ctx.fillRect(0, 0, 128, 128);
    if (value > 0) {
      ctx.fillStyle = '#1a2040';
      ctx.font = 'bold 64px "Segoe UI", Arial, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(value), 64, 68);
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
      if (p.marks[i]) { mat.color.setHex(0xffb454); mat.emissive.setHex(0x442200); }
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
  const first = $('#screen-' + name + ' button');
  if (first) first.focus({ preventScroll: true });
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
  setPhase('countdown');
  const holder = $('#canvas-holder');
  const el = document.createElement('div');
  el.className = 'countdown-num';
  el.setAttribute('role', 'timer');
  holder.style.position = 'relative';
  holder.appendChild(el);
  const seq = ['3', '2', '1', 'Go'];
  let i = 0;
  const step = () => {
    if (app.gamePhase === 'paused') { setTimeout(step, 300); return; }
    if (i >= seq.length) { el.remove(); done(); return; }
    el.textContent = seq[i];
    announce(seq[i]);
    audio.event('tick');
    i++;
    setTimeout(step, store.data.settings.reducedMotion ? 500 : 750);
  };
  step();
}

// ---------------------------------------------------------------- card DOM
function buildCardDom() {
  const grid = $('#card-grid');
  grid.innerHTML = '';
  const state = app.session.state;
  const me = state.players[0];
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
      b.addEventListener('click', () => tryMarkCell(i));
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
  const me = state.players[0];
  const stage = app.stage;

  $('#objective-text').textContent = 'Target: ' + PATTERNS[state.pattern].name;
  $('#pattern-desc').textContent = PATTERNS[state.pattern].desc;
  const lines = countLines(me.marks);
  $('#progress-text').textContent = `Calls: ${state.callIndex + 1} · Lines: ${lines} · Marks: ${me.marksMade}`;
  const sb = app.session.score('you');
  $('#score-preview').textContent = `Score so far: ${sb.total} (invalid −${sb.invalidPenalty})`;

  // claim button enabled only when a claim is legal (pattern complete)
  const claimReady = state.phase === 'active' && patternComplete(me.marks, state.pattern);
  $('#btn-claim').disabled = !claimReady;

  // card cells
  const acts = app.session.legalActions('you');
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

  if (app.renderer && app.renderer.ok) app.renderer.syncCells(state, 'you', markable);

  // roster
  const roster = $('#roster');
  roster.innerHTML = '';
  for (const p of state.players) {
    const li = document.createElement('li');
    li.textContent = p.id === 'you' ? 'You' : p.id;
    const span = document.createElement('span');
    span.textContent = `${countLines(p.marks)} lines`;
    li.appendChild(span);
    if (state.winner === p.id) li.classList.add('winner');
    roster.appendChild(li);
  }
  void stage;
}

// ---------------------------------------------------------------- pause
function pauseGame(reason) {
  if (app.gamePhase !== 'active') return;
  clearTimeout(app.callTimer);
  setPhase('paused', reason || 'paused');
  openModal('Paused', '<p>Take your time. The hall waits.</p>', [
    { label: 'Resume', primary: true, onClick: resumeGame },
    { label: 'Settings', onClick: () => { closeModal(); openSettings(true); } },
    { label: 'Help', onClick: () => { closeModal(); showScreen('help'); } },
    { label: 'Leave round', onClick: () => { closeModal(); abandonRound(); } },
  ]);
}

function resumeGame() {
  closeModal();
  if (!app.session || app.session.ended) { setPhase('active'); return; }
  setPhase('active', 'resumed');
  scheduleBots();
  scheduleNextCall();
}

function abandonRound() {
  clearTimeout(app.callTimer);
  app.botTimers.forEach(clearTimeout);
  app.botTimers = [];
  app.session = null;
  setPhase('title', 'round left');
  showScreen('title');
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && app.gamePhase === 'active' && app.mode !== 'hosted') pauseGame('tab hidden');
});

// ---------------------------------------------------------------- results
function showResults(winnerId, unlocked) {
  setPhase('results');
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
function startHosted() {
  setStatus('Connecting to hall…');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  try { ws = new WebSocket(proto + '//' + location.host + '/ws'); }
  catch (e) { hostedFail(); return; }
  const timeout = setTimeout(() => { try { ws.close(); } catch (_) {} hostedFail(); }, 4000);
  ws.onopen = () => {
    clearTimeout(timeout);
    ws.send(JSON.stringify({ type: 'join' }));
  };
  ws.onerror = hostedFail;
  ws.onclose = () => { if (app.mode === 'hosted' && app.gamePhase === 'active') setStatus('Disconnected from hall.'); };
  ws.onmessage = (m) => {
    let msg;
    try { msg = JSON.parse(m.data); } catch (_) { return; }
    if (msg.type === 'joined') {
      app.mode = 'hosted';
      app.hosted = { ws, playerId: msg.playerId, roomId: msg.roomId };
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
          // adapt hosted results into the results screen
          app.session.score = (id) => hostedScore(app.session.state, id);
          app.session.ranking = () => hostedRanking(app.session.state);
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
  const state = deserializeState(msg.state);
  return {
    state,
    ended: state.phase === 'ended',
    legalActions: (id) => hostedLegal(state, id),
    score: (id) => hostedScore(state, id),
    ranking: () => hostedRanking(state),
    exportReplay: () => msg.replay || {},
    onEvent: () => {},
  };
}

import { legalActions as rulesLegal, scoreBreakdown, compareResults } from './rules.js';
function hostedLegal(state, id) { return rulesLegal(state, id); }
function hostedScore(state, id) { return scoreBreakdown(state, id); }
function hostedRanking(state) { return state.players.map(p => p.id).sort((a, b) => compareResults(state, a, b)); }

function hostedSend(cmd) {
  if (app.hosted && app.hosted.ws.readyState === 1) {
    app.hosted.ws.send(JSON.stringify({ type: 'cmd', cmd }));
  }
}
function hostedMark(cell) {
  if (app.gamePhase !== 'active') return;
  hostedSend({ type: 'mark', cell });
}

function showHostedResults(winner) {
  setPhase('results');
  const state = app.session.state;
  const sb = hostedScore(state, app.hosted.playerId);
  const won = state.winner === app.hosted.playerId;
  audio.event(won ? 'win' : 'lose');
  const ranking = hostedRanking(state);
  $('#results-body').innerHTML = `
    <h3>${won ? '🏮 Bingo! You lit the hall.' : (winner || 'The hall') + ' claimed first.'}</h3>
    <p class="muted">Authoritative result from the hall server · Reason: ${state.terminalReason}</p>
    <table class="score-table">
      <tr><td>Pattern bonus</td><td>+${sb.patternBase}</td></tr>
      <tr><td>Line bonus</td><td>+${sb.lineBonus}</td></tr>
      <tr><td>Marks</td><td>+${sb.marksScore}</td></tr>
      <tr><td>Invalid actions</td><td>−${sb.invalidPenalty}</td></tr>
      <tr class="total"><td>Total</td><td>${sb.total}</td></tr>
    </table>
    <h4>Ranking</h4>
    <table class="score-table">${ranking.map((id, i) => `<tr><td>${i + 1}. ${id}</td><td>${hostedScore(state, id).total}</td></tr>`).join('')}</table>`;
  showScreen('results');
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
  f.elements['quality'].value = s.quality;
  f.elements['theme'].value = s.theme;
  f.elements['reducedMotion'].checked = s.reducedMotion;
  f.elements['highContrast'].checked = s.highContrast;
  f.elements['largeText'].checked = s.largeText;
  f.elements['leftHanded'].checked = s.leftHanded;
  f.elements['callSpeed'].value = String(s.callSpeed);
  f.elements['autoHint'].checked = s.autoHint;
  showScreen('settings');
}

$('#settings-form').addEventListener('input', (e) => {
  const f = e.target.form;
  const s = store.data.settings;
  s.volumes.music = Number(f.elements['vol-music'].value);
  s.volumes.effects = Number(f.elements['vol-effects'].value);
  s.volumes.ambience = Number(f.elements['vol-ambience'].value);
  s.volumes.voice = Number(f.elements['vol-voice'].value);
  s.muted = f.elements['muted'].checked;
  s.quality = f.elements['quality'].value;
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
  if (app.renderer && app.renderer.ok) {
    app.renderer.applyTheme(s.theme);
    app.renderer.applyQuality(s.quality);
  }
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

// Settings "Done" navigates back to pause if we came from there
$$('#screen-settings [data-nav="title"]').forEach(b => b.addEventListener('click', () => {
  if (settingsReturnPause && app.session && !app.session.ended) {
    settingsReturnPause = false;
    showScreen('play');
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

async function openDaily() {
  // Synchronize the daily boundary with server time when hosted; fall back to UTC.
  let day = new Date().toISOString().slice(0, 10);
  try {
    const t0 = Date.now();
    const r = await fetch('/api/v1/time');
    if (r.ok) {
      const j = await r.json();
      const offset = j.now - (t0 + Date.now()) / 2; // round-trip-adjusted
      day = new Date(Date.now() + offset).toISOString().slice(0, 10);
    }
  } catch (_) { /* offline: local UTC is fine */ }
  const stage = dailyFor(day);
  const played = store.data.progress.dailyHistory[day];
  openSetup('daily', { ...stage, title: stage.title + (played != null ? ` (today's best: ${played})` : '') });
}

function refreshTitleProgress() {
  const p = store.data.progress;
  $('#title-progress').textContent =
    `Journey ${p.journeyDone.length}/${JOURNEY_STAGES.length} · Achievements ${Object.keys(p.achievements).length}/${Object.keys(ACHIEVEMENTS).length} · Rounds played ${p.gamesPlayed}`;
}

// ---------------------------------------------------------------- action tray
$('#btn-call').addEventListener('click', () => { audio.event('ui'); if (app.mode !== 'hosted') doCall(); });
$('#btn-claim').addEventListener('click', () => { if (app.mode === 'hosted') hostedSend({ type: 'claim' }); else tryClaim(); });
$('#btn-undo').addEventListener('click', () => { if (app.session && app.session.undo()) { audio.event('ui'); syncPlayUi(); } });
$('#btn-hint').addEventListener('click', () => {
  if (!app.session) return;
  const acts = app.session.legalActions('you');
  const mark = acts.find(a => a.type === 'mark');
  const me = app.session.state.players[0];
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

document.addEventListener('keydown', (e) => {
  if ($('#modal-root').open) {
    if (e.key === 'Escape' && app.gamePhase === 'paused') { e.preventDefault(); resumeGame(); }
    return;
  }
  if (app.screen === 'play') {
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); moveFocus(-1, 0); return;
      case 'ArrowRight': e.preventDefault(); moveFocus(1, 0); return;
      case 'ArrowUp': e.preventDefault(); moveFocus(0, -1); return;
      case 'ArrowDown': e.preventDefault(); moveFocus(0, 1); return;
      case 'Enter': e.preventDefault(); tryMarkCell(app.focusCell); return;
      case ' ':
        e.preventDefault();
        if (document.activeElement && document.activeElement.classList.contains('card-cell')) tryMarkCell(app.focusCell);
        else if (app.mode !== 'hosted') doCall();
        return;
      case 'c': case 'C': if (app.mode === 'hosted') hostedSend({ type: 'claim' }); else tryClaim(); return;
      case 'u': case 'U': if (!$('#btn-undo').hidden && app.session && app.session.undo()) { audio.event('ui'); syncPlayUi(); } return;
      case 'h': case 'H': $('#btn-hint').click(); return;
      case 'p': case 'P': app.gamePhase === 'paused' ? resumeGame() : pauseGame(); return;
      case 'r': case 'R': if (app.renderer && app.renderer.ok) app.renderer.resetCamera(); return;
      case 'Escape': pauseGame(); return;
      default: return;
    }
  } else if (e.key === 'Escape' && app.screen !== 'title') {
    nav('title');
  }
});

// ---------------------------------------------------------------- boot
function boot() {
  store.load();
  applyAudioSettings();
  applyAccessibility();
  refreshTitleProgress();
  showScreen('title');
  setPhase('title', 'ready');
  // audio contexts need a user gesture; unlock on first interaction
  const unlockAudio = () => { audio.ensure(); audio.startAmbience(); document.removeEventListener('pointerdown', unlockAudio); };
  document.addEventListener('pointerdown', unlockAudio);
}

boot();
