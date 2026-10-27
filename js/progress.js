'use strict';
// The save document and the game's options (pure; native/platform.ts uses it,
// tests/save.test.mjs covers it).
//
// - The save is the browser build's progress record ({ version: 1, progress:
//   { journeyDone, lessonsDone, bestScores, dailyHistory, streakDays,
//   achievements, gamesPlayed } }). Its settings moved out: the game's own
//   options are synced game settings, the rest the runtime's Options.
// - The browser build's cloud save (the JS SDK's saveJSON under game:<slug>)
//   held its whole localStorage document ({ version, settings, progress }) as
//   JSON text: parseForeign() reads its progress back for the merge.
// - Its account settings were mirrored one key per top-level field (theme,
//   callSpeed, autoHint, leftHanded, volumes, muted, graphics, reducedMotion,
//   highContrast, largeText) plus the language helper's ui.language:
//   checkSetting() keeps the four the game still has; the others are the
//   runtime's Options now.
import { mergeSaves } from './save-merge.js';
import { THEMES } from './content.js';

export const SAVE_VERSION = 1;

export function defaultProgress() {
  return { journeyDone: [], lessonsDone: [], bestScores: {}, dailyHistory: {}, streakDays: [], achievements: {}, gamesPlayed: 0 };
}
export function defaultSave() { return { version: SAVE_VERSION, progress: defaultProgress() }; }

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const numMap = (v) => {
  const out = {};
  if (isObj(v)) for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && isFinite(n)) out[k] = n;
  return out;
};

/** Any stored document (the engine save, or the old one) as a clean save. */
export function normalizeSave(doc) {
  const p = isObj(doc) && isObj(doc.progress) ? doc.progress : {};
  const ach = {};
  if (isObj(p.achievements)) for (const [k, v] of Object.entries(p.achievements)) if (typeof v === 'string') ach[k] = v;
  return {
    version: SAVE_VERSION,
    progress: {
      journeyDone: strList(p.journeyDone), lessonsDone: strList(p.lessonsDone),
      bestScores: numMap(p.bestScores), dailyHistory: numMap(p.dailyHistory),
      streakDays: strList(p.streakDays), achievements: ach,
      gamesPlayed: typeof p.gamesPlayed === 'number' && isFinite(p.gamesPlayed) ? Math.max(0, Math.floor(p.gamesPlayed)) : 0,
    },
  };
}

/** Two copies of the save merged (the browser build's saveconflict merge: the best of both). */
export function mergeDocs(a, b) {
  const merged = mergeSaves(normalizeSave(a), normalizeSave(b), { version: SAVE_VERSION, settings: {}, progress: defaultProgress() });
  return normalizeSave(merged);
}

/** The browser build's cloud document from the slot's text, or null when it is not ours. */
export function parseForeign(text) {
  let doc;
  try { doc = typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
  if (!isObj(doc) || doc.version !== 1 || !isObj(doc.progress)) return null;
  return normalizeSave(doc);
}

// --- the game's own options -----------------------------------------------------------
export const SETTING_DEFAULTS = { theme: 'ember', callSpeed: 5000, autoHint: true, leftHanded: false };
export const CALL_SPEEDS = [3000, 5000, 8000, 0];

/** A stored value for one of the game's options, checked; undefined when unusable. */
export function checkSetting(key, value) {
  switch (key) {
    case 'theme': return typeof value === 'string' && THEMES.some((t) => t.id === value) ? value : undefined;
    case 'callSpeed': return typeof value === 'number' && CALL_SPEEDS.includes(value) ? value : undefined;
    case 'autoHint':
    case 'leftHanded': return typeof value === 'boolean' ? value : undefined;
    default: return undefined;
  }
}

/** Old ISO-day key ('YYYY-MM-DD') of a millisecond time, UTC. */
export function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
