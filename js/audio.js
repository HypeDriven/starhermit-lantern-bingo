'use strict';

// Audio: procedural WebAudio buses (music / effects / ambience / voice),
// event mapping, captions hook, and seeded pitch variants for replay consistency.
// Sampled one-shots (sfx/<name>.opus, listed in sfx/manifest.json) are fetched
// lazily after the user-gesture unlock; each event prefers its mapped sample and
// falls back to the original synthesis while the clip is loading or unavailable.

import { mulberry32 } from './rules.js';

// Captions emitted when a sampled one-shot replaces the synthesized event.
const SFX_CAPTIONS = {
  ui: 'tap', call: 'number called', mark: 'marked', invalid: 'not allowed',
  line: 'line complete', win: 'bingo! round won', lose: 'round lost',
};

export class AudioEngine {
  constructor(seed = 1) {
    this.ctx = null;
    this.buses = {};
    this.volumes = { music: 0.5, effects: 0.8, ambience: 0.4, voice: 0.7 };
    this.muted = false;
    this.captionListener = null;
    this._variantRng = mulberry32(seed ^ 0xa51ced);
    this._musicTimer = null;
    this._sfxByEvent = null; // event type -> [clip basenames], null until manifest loads
    this._sfxBuffers = new Map(); // basename -> AudioBuffer
    this._sfxPending = new Map(); // basename -> in-flight decode Promise
    this._sfxFailed = new Set(); // basenames that failed to fetch/decode
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      const master = this.ctx.createGain();
      master.connect(this.ctx.destination);
      this.master = master;
      for (const name of ['music', 'effects', 'ambience', 'voice']) {
        const g = this.ctx.createGain();
        g.gain.value = this.muted ? 0 : this.volumes[name];
        g.connect(master);
        this.buses[name] = g;
      }
      this._loadSfxManifest();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return true;
  }

  // Fetch the clip index once, after the AudioContext exists (post-unlock).
  _loadSfxManifest() {
    fetch('sfx/manifest.json')
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        const byEvent = {};
        for (const item of Array.isArray(list) ? list : []) {
          if (!item || typeof item.name !== 'string' || typeof item.event !== 'string') continue;
          (byEvent[item.event] = byEvent[item.event] || []).push(item.name);
        }
        this._sfxByEvent = byEvent;
      })
      .catch(() => { this._sfxByEvent = {}; });
  }

  // Lazy fetch + decode of a single clip; deduped, failures are remembered.
  _loadSample(name) {
    if (this._sfxBuffers.has(name) || this._sfxFailed.has(name)) return;
    if (this._sfxPending.has(name)) return;
    const p = fetch(`sfx/${name}.opus`)
      .then((r) => { if (!r.ok) throw new Error('sfx missing'); return r.arrayBuffer(); })
      .then((ab) => this.ctx.decodeAudioData(ab))
      .then((buf) => { this._sfxBuffers.set(name, buf); })
      .catch(() => { this._sfxFailed.add(name); })
      .finally(() => { this._sfxPending.delete(name); });
    this._sfxPending.set(name, p);
  }

  // Play a cached clip through the effects bus (inherits volume/mute).
  _playSample(name) {
    const buf = this._sfxBuffers.get(name);
    if (!buf) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.buses.effects);
    src.start();
    return true;
  }

  // Prefer a mapped sample for this event; kick off its lazy load otherwise.
  _trySfx(type) {
    const names = this._sfxByEvent && this._sfxByEvent[type];
    if (!names || !names.length) return false;
    const name = names[Math.floor(this._variantRng() * names.length)];
    if (this._playSample(name)) {
      const caption = SFX_CAPTIONS[type];
      if (caption) this._caption(caption);
      return true;
    }
    this._loadSample(name);
    return false;
  }

  setVolume(bus, v) {
    this.volumes[bus] = v;
    if (this.buses[bus]) this.buses[bus].gain.value = this.muted ? 0 : v;
  }

  setMuted(m) {
    this.muted = m;
    for (const name of Object.keys(this.buses)) {
      this.buses[name].gain.value = m ? 0 : this.volumes[name];
    }
  }

  onCaption(fn) { this.captionListener = fn; }
  _caption(text) { if (this.captionListener) this.captionListener(text); }

  _tone(bus, freq, dur, type = 'sine', gain = 0.25, when = 0) {
    if (!this.ensure()) return;
    const t = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(this.buses[bus]);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  // Event mapping — short original transients tied to logical events.
  event(type) {
    if (this.ensure() && this._trySfx(type)) return;
    const v = 0.9 + this._variantRng() * 0.2; // seeded pitch variant
    switch (type) {
      case 'ui': this._tone('effects', 620 * v, 0.06, 'triangle', 0.12); this._caption('tap'); break;
      case 'call':
        this._tone('voice', 340 * v, 0.1, 'sine', 0.2);
        this._tone('voice', 510 * v, 0.12, 'sine', 0.16, 0.09);
        this._caption('number called');
        break;
      case 'mark': this._tone('effects', 740 * v, 0.09, 'triangle', 0.22); this._caption('marked'); break;
      case 'invalid': this._tone('effects', 160, 0.18, 'sawtooth', 0.14); this._caption('not allowed'); break;
      case 'line':
        this._tone('effects', 523 * v, 0.1, 'triangle', 0.2);
        this._tone('effects', 659 * v, 0.1, 'triangle', 0.2, 0.1);
        this._tone('effects', 784 * v, 0.16, 'triangle', 0.22, 0.2);
        this._caption('line complete');
        break;
      case 'win':
        [523, 659, 784, 1047].forEach((f, i) => this._tone('music', f, 0.22, 'triangle', 0.25, i * 0.14));
        this._caption('bingo! round won');
        break;
      case 'lose':
        [392, 330, 262].forEach((f, i) => this._tone('music', f, 0.25, 'sine', 0.2, i * 0.16));
        this._caption('round lost');
        break;
      case 'tick': this._tone('effects', 900, 0.03, 'square', 0.05); break;
      default: break;
    }
  }

  // Quiet deterministic ambience: slow lantern-hum pad.
  startAmbience() {
    if (!this.ensure() || this._amb) return;
    const osc = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine'; osc.frequency.value = 110;
    osc2.type = 'sine'; osc2.frequency.value = 165;
    g.gain.value = 0.05;
    osc.connect(g); osc2.connect(g); g.connect(this.buses.ambience);
    osc.start(); osc2.start();
    this._amb = { osc, osc2, g };
  }

  stopAll() {
    if (this._amb) { try { this._amb.osc.stop(); this._amb.osc2.stop(); } catch (_) {} this._amb = null; }
  }
}
