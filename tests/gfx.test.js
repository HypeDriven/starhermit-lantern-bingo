import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPreset, detectLevel, presetForLevel, LEVELS, BUDGETS, budget, resolve, presetTier, choosePreset, describe, CATEGORIES, PRESETS } from '../js/gfx.js';

// js/gpu-level.js is a classic script in the page; imported here it sets globalThis.StarHermitGpu.
await import('../js/gpu-level.js');
import { GFX_STRINGS, pickLocale } from '../js/gfx-strings.js';

test('hardware level picks the Auto preset (StarHermit gpu-level.js)', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('', { webgl: false }), 'low', 'no WebGL');
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)'), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)'), 'ultra');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)'), 'ultra');
  assert.equal(detectLevel('NVIDIA GeForce RTX 5090'), 20);
  assert.equal(detectLevel('SwiftShader'), 0);
  for (const [p, lv] of Object.entries(LEVELS)) assert.equal(presetForLevel(lv), p);
  assert.equal(presetForLevel(9), 'balanced');
  assert.equal(presetForLevel(16), 'high');
  // phones and tablets cap Auto at Balanced
  assert.ok(['low', 'balanced'].includes(detectPreset('Adreno (TM) 740', { mobile: true })), 'mobile Adreno 740 is Balanced at most');
  assert.equal(detectPreset('NVIDIA GeForce RTX 5090', { mobile: true }), 'balanced');
  assert.equal(detectPreset('SwiftShader', { mobile: true }), 'low');
});

test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
  const keys = ['material', 'floor', 'segments', 'motes', 'title', 'bloomRes', 'aoRes'];
  for (const p of PRESETS) for (const k of keys) assert.ok(k in BUDGETS[p], `${p}.${k}`);
  for (let i = 1; i < PRESETS.length; i++) {
    const a = BUDGETS[PRESETS[i - 1]], b = BUDGETS[PRESETS[i]];
    for (const k of keys.slice(1)) assert.ok(b[k] >= a[k], `${PRESETS[i]}.${k}`);
  }
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
  assert.deepEqual(budget('high', 10), BUDGETS.high, 'floor level = table');
  assert.ok(budget('high', 14).motes > BUDGETS.high.motes, 'motes grow above the floor');
  assert.ok(budget('ultra', 20).motes <= BUDGETS.ultra.motes * 2, 'at most 2x');
  assert.ok(budget('ultra', 2).motes < BUDGETS.ultra.motes, 'fewer below the floor');
  assert.deepEqual(resolve({ preset: 'low' }, 'low', 0).budget, BUDGETS.low);
  assert.equal(resolve({}, 'ultra', 20).level, 20);
});

test('resolve: preset, auto, overrides and scale clamp', () => {
  const auto = resolve({ preset: 'auto' }, 'high');
  assert.equal(auto.preset, 'high');
  assert.equal(auto.auto, true);
  assert.equal(auto.bloom, presetTier('high', 'bloom'));
  const low = resolve({ preset: 'low' }, 'high');
  assert.equal(low.preset, 'low');
  assert.equal(low.post, false, 'Low needs no post-processing');
  assert.equal(low.shadows, 'off');
  const over = resolve({ preset: 'high', bloom: 'off', shadows: 'bogus' }, 'low');
  assert.equal(over.bloom, 'off');
  assert.equal(over.shadows, presetTier('high', 'shadows'), 'unknown tier falls back to preset');
  assert.equal(resolve({ render_scale: 5 }, 'low').renderScale, 2);
  assert.equal(resolve({ render_scale: 0.1 }, 'low').renderScale, 0.5);
  assert.equal(resolve({ preset: 'ultra', render_scale: 1 }, 'low').scale, 1.25);
  assert.equal(resolve({}, 'low').adaptive, true);
  assert.equal(resolve({}, 'low').showFps, false);
  for (const p of PRESETS) for (const c of Object.keys(CATEGORIES)) assert.ok(CATEGORIES[c].includes(presetTier(p, c)), `${p}.${c}`);
});

test('choosing a preset clears overrides but keeps scale / adaptive / fps', () => {
  const saved = choosePreset({ preset: 'high', bloom: 'off', ao: 'high', render_scale: 1.5, adaptive: false, show_fps: true }, 'low');
  assert.deepEqual(saved, { preset: 'low', render_scale: 1.5, adaptive: false, show_fps: true });
  assert.equal(choosePreset({}, 'auto').preset, 'auto');
});

test('describe summarises cost and pixels', () => {
  const s = describe(resolve({ preset: 'high' }, 'low'), [1280, 960]);
  assert.match(s, /1024² shadows/);
  assert.match(s, /bloom/);
  assert.match(s, /1280×960 px/);
  assert.match(describe(resolve({ preset: 'low' }, 'low')), /no shadows/);
});

test('graphics strings exist for every locale and key', () => {
  const keys = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
  const ref = keys(GFX_STRINGS['en-US']).sort();
  for (const loc of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) {
    assert.ok(GFX_STRINGS[loc], loc);
    assert.deepEqual(keys(GFX_STRINGS[loc]).sort(), ref, loc);
  }
  assert.equal(pickLocale(['fr-CA']), 'fr-CA');
  assert.equal(pickLocale(['es-MX']), 'es-419');
  assert.equal(pickLocale(['en-AU']), 'en-GB');
  assert.equal(pickLocale(['ja-JP']), 'en-US');
});
