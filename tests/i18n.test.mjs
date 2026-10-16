// Every player-facing string exists in all nine locales (node --test).
// Keys are the US-English source strings (see tests/i18n-keys.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DICTS, LOCALES, T, setLocale } from '../js/i18n.js';
import { GFX_STRINGS } from '../js/gfx-strings.js';
import { shStrings } from '../js/sh-strings.js';
import { ALL } from './i18n-keys.mjs';

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('the key set is non-trivial', () => {
  assert.ok(ALL.size > 200, `only ${ALL.size} keys found`);
});

for (const locale of LOCALES.filter((l) => l !== 'en-US' && l !== 'en-GB')) {
  test(`${locale}: every key is translated with the same placeholders`, () => {
    const dict = DICTS[locale];
    const missing = [...ALL].filter((k) => !Object.prototype.hasOwnProperty.call(dict, k));
    assert.deepEqual(missing, [], `${missing.length} missing in ${locale}`);
    const bad = [...ALL].filter((k) => placeholders(dict[k]) !== placeholders(k));
    assert.deepEqual(bad, [], `placeholder mismatch in ${locale}`);
  });
}

test('no locale carries keys that no longer exist', () => {
  for (const locale of LOCALES) {
    const stray = Object.keys(DICTS[locale]).filter((k) => !ALL.has(k));
    assert.deepEqual(stray, [], locale);
  }
});

test('Graphics and StarHermit strings exist in all nine locales, including the terms prompt', () => {
  for (const locale of LOCALES) {
    assert.ok(GFX_STRINGS[locale]?.graphics, locale);
    const sh = shStrings([locale]);
    for (const k of ['signIn', 'expiredTitle', 'expiredBody', 'termsTitle', 'termsBody', 'relaunch', 'notNow']) assert.ok(sh[k], locale + ' ' + k);
  }
});

test('rich-text keys keep their inline markup in every locale', () => {
  const tags = (s) => (String(s).match(/<[^>]+>/g) || []).join('');
  for (const locale of LOCALES.filter((l) => l !== 'en-US')) {
    for (const k of [...ALL].filter((x) => x.includes('<'))) assert.equal(tags(DICTS[locale][k] ?? k), tags(k), locale + ': ' + k.slice(0, 40));
  }
});

test('T falls back to the key and fills placeholders; regional variants inherit', () => {
  setLocale('de-DE');
  assert.equal(T('Not a real key {x}', { x: 1 }), 'Not a real key 1');
  assert.equal(T('Stage {n}', { n: 2 }), 'Etappe 2');
  setLocale('fr-CA');
  assert.equal(T('Scoring'), 'Pointage');
  assert.equal(T('Hall'), 'Salle'); // inherited from fr-FR
  setLocale('es-ES');
  assert.equal(T('Settings'), 'Ajustes');
  assert.equal(T('Hall'), 'Sala');
  setLocale('en-US');
  assert.equal(T('Hall'), 'Hall');
});
