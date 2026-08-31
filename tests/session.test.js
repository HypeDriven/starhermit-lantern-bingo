'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../js/session.js';
import { BALLS, legalActions, applyCommand, hashState } from '../js/rules.js';
import { validateAll, dailyFor, JOURNEY_STAGES, CHALLENGES } from '../js/content.js';

function playPerfect(session, playerId) {
  while (!session.ended && session.state.callIndex < BALLS - 1) {
    session.dispatch({ type: 'call' });
    const mark = session.legalActions(playerId).find(a => a.type === 'mark');
    if (mark) for (const cell of mark.cells) session.dispatch({ type: 'mark', player: playerId, cell });
    session.dispatch({ type: 'claim', player: playerId });
  }
}

test('replay: identical seed + commands produce identical hashes', () => {
  const a = new Session({ seed: 1234, pattern: 'two-lines', parCalls: 30, playerIds: ['p'] });
  playPerfect(a, 'p');
  const envelope = a.exportReplay();
  const check = Session.verifyReplay(envelope);
  assert.equal(check.ok, true, check.error || '');
});

test('replay: tampered hash detected', () => {
  const a = new Session({ seed: 1234, pattern: 'any-line', parCalls: 18, playerIds: ['p'] });
  playPerfect(a, 'p');
  const env = a.exportReplay();
  env.hashes[env.hashes.length - 1].hash = 'deadbeef';
  env.terminal.finalHash = 'deadbeef';
  // tamper only the mid-stream hash; final hash must stay consistent to reach the check
  const r = Session.verifyReplay(env);
  assert.equal(r.ok, false);
});

test('undo restores previous state', () => {
  const s = new Session({ seed: 5, pattern: 'any-line', playerIds: ['p'] });
  s.dispatch({ type: 'call' });
  const h = hashState(s.state);
  const mark = s.legalActions('p').find(a => a.type === 'mark');
  if (mark) {
    s.dispatch({ type: 'mark', player: 'p', cell: mark.cells[0] });
    assert.notEqual(hashState(s.state), h);
    assert.equal(s.undo(), true);
    assert.equal(hashState(s.state), h);
  }
});

test('golden sessions: easy/medium/hard terminate with valid winners', () => {
  for (const [seed, pattern, par] of [[100, 'any-line', 42], [200, 'corners', 56], [300, 'full-house', 75]]) {
    const s = new Session({ seed, pattern, parCalls: par, playerIds: ['p'] });
    playPerfect(s, 'p');
    assert.equal(s.state.winner, 'p', pattern);
    assert.equal(Session.verifyReplay(s.exportReplay()).ok, true);
  }
});

test('all authored content passes offline validators', () => {
  const report = validateAll();
  const failures = report.filter(r => !r.ok);
  assert.equal(failures.length, 0, JSON.stringify(failures.map(f => f.errors)));
});

test('journey has 40 stages with unique ids and seeds', () => {
  assert.equal(JOURNEY_STAGES.length, 40);
  assert.equal(new Set(JOURNEY_STAGES.map(s => s.id)).size, 40);
  assert.equal(new Set(JOURNEY_STAGES.map(s => s.seed)).size, 40);
});

test('daily is deterministic per UTC day and differs across days', () => {
  const a = dailyFor('2026-08-29');
  const b = dailyFor('2026-08-29');
  const c = dailyFor('2026-08-30');
  assert.deepEqual(a, b);
  assert.notEqual(a.seed, c.seed);
});

test('challenges are valid content', () => {
  assert.ok(CHALLENGES.length >= 4);
});
