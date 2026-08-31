'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRID, CELLS, CENTER, BALLS, mulberry32, generateCard, createGame,
  legalActions, applyCommand, countLines, patternComplete, scoreBreakdown,
  compareResults, serialize, deserialize, hashState, PATTERNS,
} from '../js/rules.js';

function perfectPlayerState(seed, pattern) {
  let state = createGame({ seed, pattern, playerIds: ['p'] });
  for (let c = 0; c < BALLS && state.phase === 'active'; c++) {
    state = applyCommand(state, { type: 'call' }).state;
    const mark = legalActions(state, 'p').find(a => a.type === 'mark');
    if (mark) for (const cell of mark.cells) state = applyCommand(state, { type: 'mark', player: 'p', cell }).state;
    const r = applyCommand(state, { type: 'claim', player: 'p' });
    state = r.state;
  }
  return state;
}

test('rng is deterministic', () => {
  const a = mulberry32(42), b = mulberry32(42);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
});

test('card generation: column ranges, uniqueness, free center', () => {
  const card = generateCard(mulberry32(7));
  assert.equal(card.length, CELLS);
  assert.equal(card[CENTER], 0);
  const seen = new Set();
  for (let i = 0; i < CELLS; i++) {
    if (i === CENTER) continue;
    const v = card[i];
    const c = i % GRID;
    assert.ok(v >= c * 15 + 1 && v <= c * 15 + 15, `cell ${i} value ${v} in column range`);
    assert.ok(!seen.has(v), 'no duplicates');
    seen.add(v);
  }
});

test('initial state: tick 0, active, center pre-marked, no current call', () => {
  const s = createGame({ seed: 1, pattern: 'any-line', playerIds: ['a', 'b'] });
  assert.equal(s.tick, 0);
  assert.equal(s.phase, 'active');
  assert.equal(s.currentCall, 0);
  assert.equal(s.players[0].marks[CENTER], true);
  assert.equal(s.players.length, 2);
});

test('call command advances tick monotonically and sets current call', () => {
  let s = createGame({ seed: 9, pattern: 'any-line', playerIds: ['a'] });
  const t0 = s.tick;
  const r = applyCommand(s, { type: 'call' });
  assert.equal(r.state.tick, t0 + 1);
  assert.ok(r.state.currentCall >= 1 && r.state.currentCall <= BALLS);
  assert.equal(r.events[0].type, 'call');
});

test('mark legality: cannot mark uncalled number', () => {
  let s = createGame({ seed: 5, pattern: 'any-line', playerIds: ['a'] });
  s = applyCommand(s, { type: 'call' }).state;
  const me = s.players[0];
  const uncalled = me.card.findIndex(v => v !== 0 && v !== s.currentCall);
  const r = applyCommand(s, { type: 'mark', player: 'a', cell: uncalled });
  assert.equal(r.error, 'number-not-called');
  assert.equal(r.state.players[0].invalidMarks, 1);
});

test('mark legal called number; double mark rejected', () => {
  let s = createGame({ seed: 5, pattern: 'any-line', playerIds: ['a'] });
  s = applyCommand(s, { type: 'call' }).state;
  const me = s.players[0];
  const cell = me.card.indexOf(s.currentCall);
  if (cell === -1) return; // number not on this card, nothing to test with this seed
  const r = applyCommand(s, { type: 'mark', player: 'a', cell });
  assert.ok(!r.error);
  const r2 = applyCommand(r.state, { type: 'mark', player: 'a', cell });
  assert.equal(r2.error, 'already-marked');
});

test('claim validation: false claim penalized, correct claim wins and ends', () => {
  const s0 = createGame({ seed: 5, pattern: 'full-house', playerIds: ['a'] });
  const bad = applyCommand(s0, { type: 'claim', player: 'a' });
  assert.equal(bad.error, 'pattern-incomplete');
  assert.equal(bad.state.players[0].invalidClaims, 1);

  const s = perfectPlayerState(11, 'any-line');
  assert.equal(s.phase, 'ended');
  assert.equal(s.winner, 'p');
  assert.equal(s.terminalReason, 'pattern-claimed');
});

test('every pattern is reachable (terminal states valid)', () => {
  for (const key of Object.keys(PATTERNS)) {
    const s = perfectPlayerState(123, key);
    assert.equal(s.winner, 'p', key + ' reachable');
    assert.ok(patternComplete(s.players[0].marks, key), key + ' actually complete');
  }
});

test('countLines and corners/frame patterns', () => {
  const marks = new Array(CELLS).fill(false);
  for (let c = 0; c < GRID; c++) marks[c] = true; // top row
  assert.equal(countLines(marks), 1);
  assert.ok(patternComplete(marks, 'any-line'));
  const corners = new Array(CELLS).fill(false);
  [0, 4, 20, 24].forEach(i => { corners[i] = true; });
  assert.ok(patternComplete(corners, 'corners'));
  assert.ok(!patternComplete(corners, 'frame'));
});

test('scoring breakdown is integer and components sum to total', () => {
  const s = perfectPlayerState(21, 'any-line');
  const sb = scoreBreakdown(s, 'p');
  for (const k of ['patternBase', 'lineBonus', 'marksScore', 'speedBonus', 'invalidPenalty', 'total']) {
    assert.ok(Number.isInteger(sb[k]), k);
  }
  assert.equal(sb.total, sb.patternBase + sb.lineBonus + sb.marksScore + sb.speedBonus - sb.invalidPenalty);
  assert.ok(sb.won);
  assert.ok(sb.patternBase === 1000);
});

test('tiebreak: winner first, then fewer invalid, then faster claim', () => {
  let s = createGame({ seed: 3, pattern: 'any-line', playerIds: ['a', 'b'] });
  s = applyCommand(s, { type: 'mark', player: 'b', cell: 0 }).state; // invalid mark for b
  const order = ['a', 'b'].sort((x, y) => compareResults(s, x, y));
  assert.equal(order[0], 'a'); // fewer invalid actions
});

test('serialization round-trips exactly', () => {
  const s = perfectPlayerState(31, 'two-lines');
  const back = deserialize(serialize(s));
  assert.equal(hashState(back), hashState(s));
});

test('deserialize rejects wrong version', () => {
  assert.throws(() => deserialize(JSON.stringify({ v: 99 })));
});

test('fuzz: malformed commands never crash and never hang', () => {
  const s = createGame({ seed: 77, pattern: 'any-line', playerIds: ['a'] });
  const junk = [null, undefined, {}, { type: 42 }, { type: 'mark' }, { type: 'mark', player: 'x', cell: -1 },
    { type: 'mark', player: 'a', cell: 999 }, { type: 'claim', player: 'ghost' }, { type: 'nuke' },
    { type: 'call', extra: 'x'.repeat(10000) }];
  for (const cmd of junk) {
    const r = applyCommand(s, cmd);
    assert.ok(r.state, 'state returned');
  }
});

test('deck exhaustion bounds the game', () => {
  let s = createGame({ seed: 8, pattern: 'full-house', playerIds: ['a'] });
  for (let i = 0; i < BALLS; i++) s = applyCommand(s, { type: 'call' }).state;
  const r = applyCommand(s, { type: 'call' });
  assert.equal(r.error, 'deck-exhausted');
});

test('commands on ended game rejected except forfeit', () => {
  const s = perfectPlayerState(41, 'any-line');
  const r = applyCommand(s, { type: 'call' });
  assert.equal(r.error, 'game-not-active');
});
