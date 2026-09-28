// Title-screen sky lanterns: a 2D canvas behind the main menu with paper lanterns drifting
// upward over the painted hall. Count follows the `lanterns` tier, halos follow `bloom`,
// and `background: static` (or reduced motion) draws a single still frame.
const COUNT = { low: 10, medium: 18, high: 28 };

export class TitleFx {
  constructor(host, isActive) {
    this.host = host;
    this.isActive = isActive; // () => boolean: title visible and page shown
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'title-fx';
    this.canvas.setAttribute('aria-hidden', 'true');
    host.prepend(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.g = null;
    this.moving = false;
    this.items = [];
    this._raf = 0;
    this._last = 0;
    this.onFrame = null; // (dtMs) => void, for the shared frame-rate meter
    this._seed = 7;
    window.addEventListener('resize', () => { this._resize(); if (!this.moving) this._draw(0); });
  }

  _rand() {
    this._seed = (this._seed * 16807) % 2147483647;
    return this._seed / 2147483647;
  }

  set(g, reducedMotion, pixelRatio) {
    this.g = g;
    this.pixelRatio = pixelRatio;
    this.moving = g.background === 'animated' && !reducedMotion;
    const n = COUNT[g.lanterns] || COUNT.low;
    if (this.items.length !== n) {
      this._seed = 7;
      this.items = Array.from({ length: n }, () => this._spawn(true));
    }
    this._resize();
    this.kick();
  }

  _spawn(anywhere) {
    const depth = 0.35 + this._rand() * 0.65; // nearer lanterns are bigger, brighter, faster
    return {
      x: this._rand(), y: anywhere ? this._rand() * 1.1 : 1.08 + this._rand() * 0.1,
      depth, phase: this._rand() * Math.PI * 2, speed: 0.012 + depth * 0.02,
      hue: this._rand(),
    };
  }

  _resize() {
    const r = this.host.getBoundingClientRect();
    const pr = Math.max(0.5, this.pixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * pr)), h = Math.max(1, Math.round(r.height * pr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
  }

  /** (Re)start drawing if the title is showing. */
  kick() {
    if (!this.isActive()) return;
    this._resize();
    if (!this.moving) { cancelAnimationFrame(this._raf); this._raf = 0; this._draw(0); return; }
    if (this._raf) return;
    this._last = 0;
    const loop = (ts) => {
      if (!this.isActive() || !this.moving) { this._raf = 0; return; }
      this._raf = requestAnimationFrame(loop);
      const dt = this._last ? Math.min(100, ts - this._last) : 16;
      this._last = ts;
      if (this.onFrame) this.onFrame(dt);
      this._draw(dt / 1000);
    };
    this._raf = requestAnimationFrame(loop);
  }

  _draw(dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);
    const halo = this.g && this.g.bloom === 'on';
    const unit = Math.min(W, H);
    this._t = (this._t || 0) + dt;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      it.y -= it.speed * dt;
      if (it.y < -0.1) this.items[i] = Object.assign(it, this._spawn(false));
      const sway = Math.sin(this._t * 0.6 + it.phase) * 0.012;
      const x = (it.x + sway) * W, y = it.y * H;
      const s = unit * (0.012 + it.depth * 0.022);
      const flicker = 0.85 + 0.15 * Math.sin(this._t * 3.1 + it.phase * 5);
      // keep the menu column legible: lanterns behind it are dimmed
      const nearMenu = Math.abs(it.x + sway - 0.5) < 0.2 ? 0.35 : 1;
      const a = (0.35 + it.depth * 0.55) * flicker * nearMenu;
      const warm = it.hue < 0.7 ? [255, 176, 84] : [255, 120, 70];
      if (halo) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, s * 3.2);
        g.addColorStop(0, `rgba(${warm[0]},${warm[1]},${warm[2]},${0.32 * a})`);
        g.addColorStop(1, 'rgba(255,150,60,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - s * 3.2, y - s * 3.2, s * 6.4, s * 6.4);
      }
      // paper body: warm core fading to the rim, with dark caps
      const body = ctx.createRadialGradient(x, y - s * 0.2, s * 0.1, x, y, s);
      body.addColorStop(0, `rgba(255,236,190,${a})`);
      body.addColorStop(0.6, `rgba(${warm[0]},${warm[1]},${warm[2]},${a * 0.9})`);
      body.addColorStop(1, `rgba(${warm[0] - 60},${warm[1] - 70},40,${a * 0.5})`);
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.ellipse(x, y, s * 0.8, s, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}
