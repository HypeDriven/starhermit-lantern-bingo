// server.js, the game's server script, under a fake platform host: score
// posting on practice sessions (range-checked to the high-score board) and the
// hosted hall referee (seats from the room's roster plus bot lanterns, the
// day's pattern with the script's own deck, views without the seed or the
// rest of the deck, the 4 s caller, commands bound to the sender's seat, the
// rules' penalties, leavers, deck exhaustion and the recorded result).
// Run: node --test tests/server.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ScriptSession, declarations, invoke } from './fake-platform.mjs';
import { legalActions, patternComplete, CENTER } from '../js/rules.js';
import { dailyFor } from '../js/content.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.UTC(2026, 9, 27, 12);

test('declarations: 4 Hz ticks, the high-score board as score-script.js had it; the RULES block is current', () => {
  const d = declarations();
  assert.equal(d.tickRateHz, 4);
  assert.deepEqual(d.BOARDS, { 'high-score': { name: 'High score', scoreType: 'integer', sortDirection: 'desc', minScore: 0, maxScore: 100000 } });
  execFileSync(process.execPath, ['tools/build-server.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' });
});

test('score posting: a valid total reaches the high-score board, bad ones do not', () => {
  for (const [score, ok] of [[1290, true], [0, true], [100000, true], [100001, false], [-1, false], [12.5, false], ['9', false]]) {
    const s = new ScriptSession({ players: [{ id: 'u1', name: 'Ada' }] });
    s.create();
    assert.ok(s.send('u1', { type: 'result', scores: { 'high-score': score } }).ok);
    assert.deepEqual(s.last('u1', 'result-ack').accepted, ok ? ['high-score'] : []);
    assert.deepEqual(s.scores, ok ? [{ 'high-score': { u1: score } }] : [{}]);
    assert.equal(s.result.kind, 'finished');
  }
  assert.equal(invoke('onPlayerMessage', { now: 1, random: 0, message: { from: 'u', data: { type: 'nope' } }, sessionState: { mode: 'score' } }).ok, false);
});

function hall({ humans = ['a', 'b'], random = 0.3, now = NOW } = {}) {
  const s = new ScriptSession({
    players: humans.map((id) => ({ id, name: id.toUpperCase() })),
    room: { roomId: 'r', metadata: { mode: 'hall' }, roster: humans.map((id, i) => ({ userId: id, name: id.toUpperCase(), team: 0, slot: i, ai: false })) },
    random, now,
  });
  s.create();
  return s;
}

test('hall: seats are the roster then bot lanterns (four), the day\'s pattern, a view without the seed or the deck to come', () => {
  const s = hall({ humans: ['a'] });
  assert.deepEqual(s.state.seats.map((x) => [x.playerId, x.name, x.ai]), [['p1', 'A', false], ['lantern-1', 'lantern-1', true], ['lantern-2', 'lantern-2', true], ['lantern-3', 'lantern-3', true]]);
  const daily = dailyFor('2026-10-27');
  assert.equal(s.state.stage.pattern, daily.pattern);
  assert.equal(s.state.stage.parCalls, daily.parCalls);
  assert.notEqual(s.state.state.seed, daily.seed, 'the deck is the script\'s own');
  const m = s.last('a');
  assert.equal(m.you, 'p1');
  assert.equal(m.state.seed, 0);
  assert.deepEqual(m.state.deck, []);
  assert.equal(m.state.players.length, 4);
  assert.equal(m.nextCallIn, 4000);
});

test('hall: a call every 4 s; the view carries the called numbers only', () => {
  const s = hall();
  for (let i = 0; i < 15; i++) s.tick(250);
  assert.equal(s.state.state.callIndex, -1);
  s.tick(250);
  assert.equal(s.state.state.callIndex, 0);
  const m = s.last('b');
  assert.equal(m.state.deck.length, 1);
  assert.equal(m.state.currentCall, s.state.state.deck[0]);
  for (let i = 0; i < 16; i++) s.tick(250);
  assert.equal(s.state.state.callIndex, 1);
});

test('hall: marks and claims are bound to the sender\'s seat; refusals go back to the sender; penalties count', () => {
  const s = hall();
  for (let i = 0; i < 16; i++) s.tick(250);
  const me = s.state.state.players[0];
  const callable = legalActions(s.state.state, 'p1').find((a) => a.type === 'mark');
  const uncalled = [...Array(25).keys()].find((c) => c !== CENTER && !(callable?.cells || []).includes(c));
  assert.ok(s.send('a', { type: 'act', cmd: { type: 'mark', cell: uncalled, player: 'p2' } }).ok);
  assert.equal(s.last('a', 'rejected').reason, 'number-not-called');
  assert.equal(s.state.state.players[0].invalidMarks, 1, 'the penalty lands on the sender\'s own seat');
  assert.equal(s.state.state.players[1].invalidMarks, 0);
  s.send('a', { type: 'act', cmd: { type: 'claim' } });
  assert.equal(s.last('a', 'rejected').reason, 'pattern-incomplete');
  assert.equal(s.state.state.players[0].invalidClaims, 1);
  s.send('a', { type: 'act', cmd: { type: 'mark', cell: 99 } });
  assert.equal(s.last('a', 'rejected').reason, 'cell-out-of-bounds');
  s.send('a', { type: 'act', cmd: { type: 'call' } });
  assert.equal(s.last('a', 'rejected').reason, 'unsupported-command');
  assert.equal(s.send('stranger', { type: 'act', cmd: { type: 'claim' } }).ok, false);
  if (callable) {
    s.send('a', { type: 'act', cmd: { type: 'mark', cell: callable.cells[0] } });
    assert.equal(s.state.state.players[0].marks[callable.cells[0]], true);
    assert.equal(s.last('b').state.players[0].marks[callable.cells[0]], true, 'everyone sees the mark');
  }
  void me;
});

test('hall: a player who marks every call and claims wins, and the script records the result', () => {
  for (const random of [0.11, 0.42, 0.77]) {
    const s = hall({ random });
    let guard = 0;
    while (!s.result && guard++ < 2000) {
      s.tick(250);
      const st = s.state.state;
      if (st.phase !== 'active') break;
      const m = legalActions(st, 'p1').find((a) => a.type === 'mark');
      if (m) for (const cell of m.cells) s.send('a', { type: 'act', cmd: { type: 'mark', cell } });
      if (patternComplete(s.state.state.players[0].marks, s.state.state.pattern)) s.send('a', { type: 'act', cmd: { type: 'claim' } });
    }
    assert.ok(s.result, 'the round ended');
    assert.equal(s.result.kind, 'finished');
    assert.equal(s.result.seats.length, 4);
    const winner = s.result.seats.find((x) => x.won);
    assert.equal(winner.playerId, s.result.winner);
    assert.equal(s.last('a').over.winner, s.result.winner);
    assert.equal(s.last('b').over.ranking[0], s.result.winner);
    assert.ok(winner.total >= 1000);
  }
});

test('hall: when every player leaves the round is abandoned; a leaver keeps the seat', () => {
  const s = hall();
  s.presence.a.left = true;
  s.tick(250);
  assert.equal(s.result, null);
  assert.equal(s.state.seats[0].left, true);
  assert.equal(s.send('a', { type: 'act', cmd: { type: 'claim' } }).ok, false);
  s.presence.b.left = true;
  s.tick(250);
  assert.equal(s.result.kind, 'abandoned');
});

test('hall: after the 75th call with no claim the round ends 8 s later', () => {
  const s = hall({ humans: ['a'] });
  // Bots never mark when they never notice: force a deck run-out by stripping the bots' skill.
  s.state.stage.botSkill = 0;
  let guard = 0;
  while (!s.result && guard++ < 5000) s.tick(250);
  assert.ok(s.result);
  assert.equal(s.result.reason, 'deck-exhausted');
  assert.equal(s.result.calls, 75);
  assert.equal(s.result.winner, null);
});
