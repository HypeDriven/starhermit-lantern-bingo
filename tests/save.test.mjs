// The save document and the game's options (js/progress.js): the browser
// build's cloud document (the JS SDK's saveJSON of its whole localStorage
// document under game:<slug>) is read back as foreign and merged; two
// devices' copies merge as the browser build's saveconflict merge did; the
// old account settings keep the four options the game still has.
// Run: node --test tests/save.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTING_DEFAULTS, checkSetting, defaultSave, mergeDocs, normalizeSave, parseForeign } from '../js/progress.js';

const OLD_DOC = {
  version: 1,
  settings: { volumes: { music: 0.5, effects: 0.8, ambience: 0.4, voice: 0.7 }, muted: false, theme: 'jade', graphics: { preset: 'auto' }, reducedMotion: false, highContrast: false, largeText: false, leftHanded: true, callSpeed: 8000, autoHint: false },
  progress: { journeyDone: ['journey-01', 'journey-02'], lessonsDone: ['learn-mark'], bestScores: { 'journey-01': 1290, 'daily-2026-10-01': 410 }, dailyHistory: { '2026-10-01': 410 }, streakDays: [], achievements: { first_win: '2026-10-01T10:00:00.000Z' }, gamesPlayed: 7 },
};

test('the browser build\'s cloud document reads back as the save (its settings left to the options)', () => {
  const s = parseForeign(JSON.stringify(OLD_DOC));
  assert.deepEqual(s, { version: 1, progress: OLD_DOC.progress });
  assert.equal(parseForeign('not json'), null);
  assert.equal(parseForeign(JSON.stringify({ hello: 1 })), null);
  assert.equal(parseForeign(null), null);
});

test('normalizeSave cleans what it does not know', () => {
  assert.deepEqual(normalizeSave(null), defaultSave());
  const s = normalizeSave({ progress: { journeyDone: ['a', 3], bestScores: { x: 5, y: 'no' }, gamesPlayed: -2.5, achievements: { a: 'iso', b: 1 } } });
  assert.deepEqual(s.progress.journeyDone, ['a']);
  assert.deepEqual(s.progress.bestScores, { x: 5 });
  assert.equal(s.progress.gamesPlayed, 0);
  assert.deepEqual(s.progress.achievements, { a: 'iso' });
});

test('two copies merge to the best of both (stages, lessons, best scores, days, earliest unlocks, more rounds)', () => {
  const a = { version: 1, progress: { ...defaultSave().progress, journeyDone: ['journey-01'], bestScores: { s: 100 }, achievements: { first_win: '2026-10-02T00:00:00.000Z' }, gamesPlayed: 3 } };
  const b = { version: 1, progress: { ...defaultSave().progress, journeyDone: ['journey-02'], lessonsDone: ['learn-line'], bestScores: { s: 250, t: 9 }, dailyHistory: { d: 5 }, achievements: { first_win: '2026-10-01T00:00:00.000Z', long_road: '2026-10-05T00:00:00.000Z' }, gamesPlayed: 2 } };
  const m = mergeDocs(a, b);
  assert.deepEqual(m.progress.journeyDone.sort(), ['journey-01', 'journey-02']);
  assert.deepEqual(m.progress.lessonsDone, ['learn-line']);
  assert.deepEqual(m.progress.bestScores, { s: 250, t: 9 });
  assert.deepEqual(m.progress.dailyHistory, { d: 5 });
  assert.equal(m.progress.achievements.first_win, '2026-10-01T00:00:00.000Z');
  assert.ok(m.progress.achievements.long_road);
  assert.equal(m.progress.gamesPlayed, 3);
  assert.deepEqual(Object.keys(m), ['version', 'progress']);
  assert.deepEqual(mergeDocs(null, OLD_DOC).progress, OLD_DOC.progress);
});

test('the old account settings keep theme, call speed, hints and the left-handed tray', () => {
  assert.equal(checkSetting('theme', 'jade'), 'jade');
  assert.equal(checkSetting('theme', 'neon'), undefined);
  assert.equal(checkSetting('callSpeed', 8000), 8000);
  assert.equal(checkSetting('callSpeed', 1234), undefined);
  assert.equal(checkSetting('autoHint', false), false);
  assert.equal(checkSetting('leftHanded', 'yes'), undefined);
  assert.equal(checkSetting('volumes', { music: 1 }), undefined, 'volumes are the runtime\'s Options now');
  assert.deepEqual(SETTING_DEFAULTS, { theme: 'ember', callSpeed: 5000, autoHint: true, leftHanded: false });
});
