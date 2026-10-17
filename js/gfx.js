// Graphics quality model: presets, per-category overrides, hardware-level detection, per-preset
// budgets and a cost summary.
// Pure (no three.js, no DOM), so the settings panel, the 3D hall and the tests agree on
// what a setting means.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],       // RoomEnvironment image-based lighting on the hall
  lanterns: ['low', 'medium', 'high'], // hanging lanterns in the hall + drifting lanterns on the title
  background: ['static', 'animated'],  // title-screen sky lanterns, hall sway and light flicker
  detail: ['plain', 'detailed'],       // paper/lacquer card styling, textured floor, glossy pieces
};

// Each preset is a row of tiers, a device-pixel-ratio cap and a render scale.
const TABLE = {
  low: { dprCap: 1, scale: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', lanterns: 'low', background: 'static', detail: 'plain' },
  balanced: { dprCap: 1.5, scale: 1, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', lanterns: 'medium', background: 'animated', detail: 'detailed' },
  high: { dprCap: 2, scale: 1, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', lanterns: 'high', background: 'animated', detail: 'detailed' },
  ultra: { dprCap: 2, scale: 1.25, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', lanterns: 'high', background: 'animated', detail: 'detailed' },
};

export const SHADOW_MAP = { off: 0, low: 512, medium: 1024, high: 2048 };
export const LANTERN_COUNT = { low: 12, medium: 24, high: 40 };

// StarHermit hardware level (0–20, js/gpu-level.js → window.StarHermitGpu) at which Auto starts choosing
// each preset. 0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX 5090; phones, tablets and ≤ 4 GB machines
// are capped at level 9 (Balanced); software renderers are level 0 (Low).
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };

/*
 * Per-preset asset and effect budgets, each tuned to hold 60 FPS on the weakest GPU Auto gives the preset
 * (Low: level 0 phones / Intel UHD; Balanced: level 4 Iris Xe; High: level 10 GTX 1070; Ultra: level 17
 * RTX 4080; measured with tests/gfx-bench.mjs). Gameplay is identical on every preset.
 *   material  hall tiles, board, call ball, pole, floor and lanterns: 'lambert' (Low) | 'standard'
 *             (Balanced) | 'physical' (clearcoated tiles, board and ball with Hall detail on; High/Ultra)
 *   floor     lacquered floor texture size in px (Hall detail on)
 *   segments  geometry LOD: multiplies the floor, ball, pole, lantern lathe/cap and tile-bevel segments
 *   motes     warm dust motes drifting through the hall (Ambient motion on)
 *   title     multiplies the title screen's drifting sky lanterns (2D canvas)
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
  low: { material: 'lambert', floor: 256, segments: 0.5, motes: 30, title: 0.75, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', floor: 512, segments: 0.75, motes: 60, title: 1, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', floor: 512, segments: 1, motes: 90, title: 1, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', floor: 1024, segments: 1.5, motes: 150, title: 1.25, bloomRes: 1, aoRes: 1 },
};

const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system = {}) {
  const G = gpuApi();
  if (!G) return LEVELS.balanced;
  return G.detectLevel({ webgl: true, webgl2: true, ...system, gpu: String(gpu || '') });
}

/** Auto preset for a hardware level: Low 0, Balanced 4, High 10, Ultra 17. */
export function presetForLevel(level) {
  const G = gpuApi();
  if (G) return G.presetForLevel(level, LEVELS);
  return PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU; phones and tablets are capped at Balanced by the hardware level. */
export function detectPreset(gpu, system = {}) {
  return presetForLevel(detectLevel(gpu, system));
}

/** A preset's concrete budget for a hardware level (motes scale within the preset, ≤ 2×). */
export function budget(preset, level) {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const G = gpuApi(), floor = LEVELS[preset] ?? 0;
  const k = G ? Math.min(2, G.scaleBudget(1, Number.isFinite(level) ? level : floor, floor)) : 1;
  b.motes = Math.round(b.motes * k);
  return b;
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const preset = PRESETS.includes(s.preset) ? s.preset : PRESETS.includes(detected) ? detected : 'balanced';
  const row = TABLE[preset];
  const out = {
    preset, auto: !PRESETS.includes(s.preset),
    dprCap: row.dprCap,
    renderScale: clamp(Number(s.render_scale) || 1, 0.5, 2),
  };
  out.scale = row.scale * out.renderScale;
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budget(preset, out.level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing runs only when something needs it; otherwise the canvas MSAA is used.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** Saved settings after choosing a preset: overrides are cleared, scale/adaptive/fps kept. */
export function choosePreset(saved, preset) {
  const s = saved || {};
  const out = { preset: PRESETS.includes(preset) ? preset : 'auto' };
  for (const k of ['render_scale', 'adaptive', 'show_fps']) if (k in s) out[k] = s[k];
  return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

const SUMMARY_EN = {
  noShadows: 'no shadows', shadows: 'shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
  bloom: 'bloom', reflections: 'reflections', lanterns: 'lanterns', noAa: 'no anti-aliasing',
};

/** Cost summary; `words` optionally localizes the fragments (keys as in SUMMARY_EN). */
export function describe(r, pixels, words) {
  const w = { ...SUMMARY_EN, ...(words || {}) };
  const parts = [
    r.shadows === 'off' ? w.noShadows : `${SHADOW_MAP[r.shadows]}² ${w.shadows}`,
    r.ao === 'off' ? null : r.ao === 'high' ? w.aoHigh : w.ao,
    r.bloom === 'on' ? w.bloom : null,
    r.reflections === 'on' ? w.reflections : null,
    `${LANTERN_COUNT[r.lanterns]} ${w.lanterns}`,
    r.antialias === 'off' ? w.noAa : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
