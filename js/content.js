'use strict';

// Content module: versioned stages, daily challenge, themes, learn lessons,
// and an offline validator proving legality / reachability / bounded duration.

import { mulberry32, PATTERNS, createGame, applyCommand, legalActions, BALLS } from './rules.js';

export const CONTENT_VERSION = 1;

export const THEMES = [
  { id: 'ember',    name: 'Ember Court',   bg: 0x141026, lantern: 0xffb454, accent: 0xffd7a0, floor: 0x2b2135 },
  { id: 'jade',     name: 'Jade Garden',   bg: 0x0c1f1a, lantern: 0x7be0a3, accent: 0xd2ffe5, floor: 0x14352a },
  { id: 'river',    name: 'River Night',   bg: 0x0b1830, lantern: 0x6fb7ff, accent: 0xcfe6ff, floor: 0x12294a },
  { id: 'plum',     name: 'Plum Festival', bg: 0x241026, lantern: 0xff8fc7, accent: 0xffd9ec, floor: 0x3a1a3d },
  { id: 'paper',    name: 'Paper Dawn',    bg: 0x2a2118, lantern: 0xfff1c9, accent: 0xfff8e6, floor: 0x453a2a },
];

// Learn lessons: each introduces exactly one rule and requires the player to act.
export const LESSONS = [
  { id: 'learn-mark',  title: 'Marking a Call', pattern: 'any-line', seed: 101,
    steps: [
      { text: 'Numbers are called one at a time. A glowing ball shows the current call.', waitFor: 'call' },
      { text: 'If the called number is on your card, tap it to mark it. Mark the glowing cell now.', waitFor: 'mark' },
    ] },
  { id: 'learn-line',  title: 'Lines and Claims', pattern: 'any-line', seed: 202,
    steps: [
      { text: 'Five marked cells in a row, column, or diagonal complete a line.', waitFor: 'call' },
      { text: 'Keep marking called numbers until a line is complete.', waitFor: 'auto-line' },
      { text: 'A line is complete! Press CLAIM to win the round before anyone else.', waitFor: 'claim' },
    ] },
  { id: 'learn-pattern', title: 'Target Patterns', pattern: 'corners', seed: 303,
    steps: [
      { text: 'Some rounds need a special pattern. This one needs the FOUR CORNERS.', waitFor: 'call' },
      { text: 'Mark corner numbers as they are called, then claim. Corners glow faintly to guide you.', waitFor: 'claim' },
    ] },
];

const PATTERN_ORDER = ['any-line', 'diagonal', 'corners', 'two-lines', 'frame', 'x-shape', 'full-house'];

// 40 authored journey stages: one concept introduced at a time, combined with
// known ones, with a mastery stage every 8. Generated from fixed seeds so the
// data is immutable and inspectable.
export const JOURNEY_STAGES = (() => {
  const stages = [];
  for (let i = 0; i < 40; i++) {
    const n = i + 1;
    const mastery = n % 8 === 0;
    const block = Math.floor(i / 8);
    const pattern = mastery
      ? PATTERN_ORDER[Math.min(block + 1, PATTERN_ORDER.length - 1)]
      : PATTERN_ORDER[Math.min(block, PATTERN_ORDER.length - 1)];
    const difficulty = 1 + Math.floor(i / 5); // 1..8
    const bots = Math.min(4, 1 + Math.floor(i / 10));
    stages.push({
      id: 'journey-' + String(n).padStart(2, '0'),
      version: CONTENT_VERSION,
      index: n,
      title: mastery ? `Mastery ${n}` : `Stage ${n}`,
      seed: 5000 + n * 137,
      pattern,
      bots,
      botSkill: Math.min(0.95, 0.35 + difficulty * 0.07),
      parCalls: parForPattern(pattern),
      mastery,
      tutorial: n === 1,
      theme: THEMES[block % THEMES.length].id,
      ranked: true,
      expectedMinutes: 4 + Math.floor(difficulty / 2),
    });
  }
  return stages;
})();

export const CHALLENGES = [
  { id: 'ch-speed',   title: 'Speed Lantern', seed: 9101, pattern: 'any-line',  bots: 3, botSkill: 0.85, parCalls: 38, theme: 'river', constraint: 'Win in 38 calls or fewer.', maxCalls: 38, ranked: true, expectedMinutes: 3 },
  { id: 'ch-frame',   title: 'Iron Frame',    seed: 9202, pattern: 'frame',     bots: 2, botSkill: 0.75, parCalls: 68, theme: 'ember', constraint: 'Complete the outer frame.', ranked: true, expectedMinutes: 6 },
  { id: 'ch-perfect', title: 'Steady Hand',   seed: 9303, pattern: 'two-lines', bots: 2, botSkill: 0.7,  parCalls: 56, theme: 'jade',  constraint: 'Win with zero invalid actions.', noInvalid: true, ranked: true, expectedMinutes: 5 },
  { id: 'ch-full',    title: 'Full Glow',     seed: 9404, pattern: 'full-house', bots: 4, botSkill: 0.8, parCalls: 75, theme: 'plum',  constraint: 'Black out the entire card.', ranked: true, expectedMinutes: 9 },
];

function parForPattern(pattern) {
  // Pars calibrated against the offline validator's perfect-player simulation:
  // a random card typically needs ~40 calls for a line and up to 75 for blackout.
  switch (pattern) {
    case 'any-line': return 42;
    case 'diagonal': return 52;
    case 'corners': return 56;
    case 'two-lines': return 58;
    case 'frame': return 70;
    case 'x-shape': return 64;
    case 'full-house': return 75;
    default: return 50;
  }
}

// Daily: one shared seed + ruleset per UTC day.
export function dailyFor(dateISO) {
  // dateISO: 'YYYY-MM-DD'
  let h = 0;
  for (const ch of dateISO) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  const rng = mulberry32(h);
  const patterns = Object.keys(PATTERNS);
  const pattern = patterns[Math.floor(rng() * patterns.length)];
  return {
    id: 'daily-' + dateISO,
    version: CONTENT_VERSION,
    day: dateISO,
    title: 'Daily Lantern — ' + dateISO,
    seed: h,
    pattern,
    bots: 3,
    botSkill: 0.6,
    parCalls: parForPattern(pattern),
    theme: THEMES[Math.floor(rng() * THEMES.length)].id,
    mastery: false,
    ranked: true,
    expectedMinutes: 5,
  };
}

// Offline validator: prove legality, reachable goals, bounded duration, no soft locks.
// Returns {ok, errors[]}.
export function validateContent(stage) {
  const errors = [];
  if (!stage.id || typeof stage.seed !== 'number') errors.push(stage.id + ': missing id/seed');
  if (!PATTERNS[stage.pattern]) errors.push(stage.id + ': unknown pattern ' + stage.pattern);
  if (errors.length) return { ok: false, errors };

  // Simulate with a perfect player: call every ball, mark everything legal.
  // The goal must be reachable within BALLS calls (bounded duration, no soft lock).
  let state = createGame({ seed: stage.seed, pattern: stage.pattern, playerIds: ['v'] });
  let won = -1;
  for (let c = 0; c < BALLS && won < 0; c++) {
    let r = applyCommand(state, { type: 'call' });
    if (r.error) { errors.push(stage.id + ': call failed at ' + c); break; }
    state = r.state;
    const acts = legalActions(state, 'v');
    const mark = acts.find(a => a.type === 'mark');
    if (mark) for (const cell of mark.cells) state = applyCommand(state, { type: 'mark', player: 'v', cell }).state;
    r = applyCommand(state, { type: 'claim', player: 'v' });
    state = r.state;
    if (state.winner === 'v') won = c + 1;
  }
  if (won < 0) errors.push(stage.id + ': pattern unreachable within ' + BALLS + ' calls');
  if (stage.parCalls && won > 0 && won > stage.parCalls * 2) {
    errors.push(stage.id + ': par ' + stage.parCalls + ' is unrealistic (needs ~' + won + ')');
  }
  return { ok: errors.length === 0, errors, callsToWin: won };
}

export function validateAll() {
  const report = [];
  for (const s of [...JOURNEY_STAGES, ...CHALLENGES]) report.push(validateContent(s));
  return report;
}
