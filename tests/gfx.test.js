import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPreset, resolve, presetTier, choosePreset, describe, CATEGORIES, PRESETS } from '../js/gfx.js';
import { GFX_STRINGS, pickLocale } from '../js/gfx-strings.js';

test('detectPreset maps GPU strings to tiers', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset(''), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.equal(detectPreset('Mali-G78'), 'balanced');
  // mobile caps Auto at balanced
  assert.equal(detectPreset('Apple M2', { mobile: true }), 'balanced');
  assert.equal(detectPreset('SwiftShader', { mobile: true }), 'low');
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
