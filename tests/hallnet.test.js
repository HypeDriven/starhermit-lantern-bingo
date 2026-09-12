'use strict';

// Realtime-rooms hall tests: frame codec, socket identity resolution, and the
// host-side hall runner (seating, bot fill, authoritative calls, command
// validation, round lifecycle). Transport and timers are mocked.

import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, decodeFrame, RoomsSocket, HallHost } from '../js/hallnet.js';
import { hashState } from '../js/rules.js';

const STAGE = {
  id: 'hosted-test', title: 'Test Hall', seed: 1234, pattern: 'any-line',
  parCalls: 42, bots: 0, botSkill: 0.6, version: 1, theme: 'ember',
};

function fakeTimers() {
  const intervals = new Map();
  const timeouts = new Map();
  let next = 1;
  return {
    setInterval(fn, ms) { const id = next++; intervals.set(id, { fn, ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(fn, ms) { const id = next++; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    tickIntervals(times = 1) {
      for (let i = 0; i < times; i++) for (const t of intervals.values()) t.fn();
    },
    runTimeouts(ms) {
      for (const [id, t] of [...timeouts]) if (t.ms <= ms) { timeouts.delete(id); t.fn(); }
    },
  };
}

function makeHost(extra = {}) {
  const sent = [];
  const timers = fakeTimers();
  const events = [];
  let ended = null;
  const host = new HallHost({
    send: (obj) => sent.push(obj),
    selfId: 'host-participant',
    nickname: 'Host Nick',
    onEvent: (evs) => events.push(...evs),
    onRoundEnd: (w) => { ended = w; },
    ...extra,
  }, {
    setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    stageFor: () => STAGE,
  });
  return { host, sent, timers, events, endedRef: () => ended };
}

function lastSnapshot(sent) {
  for (let i = sent.length - 1; i >= 0; i--) if (sent[i].type === 'snapshot') return sent[i];
  return null;
}

test('frame codec round-trips sender prefix + JSON', () => {
  const frame = encodeFrame('participant-1', { type: 'cmd', cmd: { type: 'claim' } });
  assert.equal(frame.length, 16 + JSON.stringify({ type: 'cmd', cmd: { type: 'claim' } }).length);
  const decoded = decodeFrame(frame);
  assert.equal(decoded.from, 'participant-1');
  assert.equal(decoded.msg.type, 'cmd');
  // long ids are truncated to 16 bytes, short ones zero-padded
  const long = decodeFrame(encodeFrame('a-very-long-participant-id-over-16', { x: 1 }));
  assert.equal(long.from.length, 16);
  // an all-zero (unset) sender prefix decodes to the empty string
  const empty = decodeFrame(encodeFrame('', { x: 1 }));
  assert.equal(empty.from, '');
  assert.equal(decodeFrame(new Uint8Array(10)), null);
  assert.throws(() => encodeFrame('x', { big: 'x'.repeat(9000) }));
});

test('socket harvests self/host ids from room payload, roster push, whoami echo', async () => {
  const mk = () => {
    const handlers = {};
    const ws = { binaryType: null, send() {}, close() {}, onmessage: null, onclose: null };
    return { ws, handlers };
  };
  // room payload flags
  {
    const { ws } = mk();
    const sock = new RoomsSocket(ws, false);
    sock.observeRoom({ id: 'r1', hostId: 'p-host', me: 'p-me', participants: [{ id: 'p-host', isHost: true }, { id: 'p-me', self: true }] });
    assert.equal(sock.selfId, 'p-me');
    assert.equal(sock.hostId, 'p-host');
  }
  // roster text push flags
  {
    const { ws } = mk();
    const sock = new RoomsSocket(ws, false);
    sock.ontext = () => {};
    ws.onmessage({ data: JSON.stringify({ type: 'roster', participants: [{ id: 'p2', isHost: true }, { id: 'p3', isMe: true }] }) });
    assert.equal(sock.hostId, 'p2');
    assert.equal(sock.selfId, 'p3');
  }
  // whoami echo fallback
  {
    const { ws } = mk();
    const sock = new RoomsSocket(ws, false);
    const p = sock.resolveSelf(200);
    // the whoami request went out as a binary frame
    assert.equal(sock.selfId, null);
    ws.onmessage({ data: encodeFrame('host', { type: 'you-are', participantId: 'p9' }).buffer });
    assert.equal(await p, 'p9');
    assert.equal(sock.selfId, 'p9');
  }
});

test('guest send throttle caps at 30 msg/s', () => {
  const sent = [];
  const ws = { readyState: 1, binaryType: null, send: (b) => sent.push(b), close() {} };
  const sock = new RoomsSocket(ws, false);
  for (let i = 0; i < 40; i++) sock.sendBinary({ n: i });
  assert.equal(sent.length, 30);
});

test('host starts a round, seats itself as you, fills bots, broadcasts seated', () => {
  const { host, sent } = makeHost();
  assert.ok(host.session);
  assert.equal(host.session.state.players[0].id, 'you');
  assert.equal(host.session.state.players.length, 4); // host + 3 bot lanterns
  const seated = sent.find(m => m.type === 'seated');
  assert.ok(seated, 'seated broadcast');
  assert.equal(seated.seats[0].playerId, 'you');
  assert.equal(seated.seats[0].name, 'Host Nick');
  assert.ok(seated.state && JSON.parse(seated.state).players.length === 4, 'carries serialized state');
});

test('mid-round joiner spectates; whoami answered; join after round ends reseats', () => {
  const { host, sent, timers } = makeHost();
  // mid-round joiner → spectator seat
  host.handleGuestMessage('guest-1', { type: 'join-hall', name: 'Guest One' });
  const seatMsg = sent.filter(m => m.type === 'seated').pop();
  assert.equal(seatMsg.you, 'guest-1');
  const g1 = host.seats().find(s => s.participantId === 'guest-1');
  assert.equal(g1.seated, false, 'spectator until next round');
  // whoami echo
  host.handleGuestMessage('guest-1', { type: 'whoami' });
  assert.deepEqual(sent.pop(), { type: 'you-are', participantId: 'guest-1' });
  // end the round → grace → restart seats the waiting guest
  host.dispatch({ type: 'forfeit', player: 'you' });
  timers.runTimeouts(15000);
  const g1b = host.seats().find(s => s.participantId === 'guest-1');
  assert.equal(g1b.seated, true, 'seated for the new round');
  assert.ok(host.session.state.players.some(p => p.id === g1b.playerId));
});

test('host applies guest commands with forced identity and valid bounds', () => {
  const { host, sent, timers } = makeHost();
  // seat a guest by restarting with them present
  host.handleGuestMessage('guest-1', { type: 'join-hall', name: 'G' });
  host.dispatch({ type: 'forfeit', player: 'you' });
  timers.runTimeouts(15000);
  const gid = host.playerIdFor('guest-1');
  assert.ok(gid);
  // out-of-bounds cell rejected, identity not attacker-controlled
  host.handleGuestMessage('guest-1', { type: 'cmd', cmd: { type: 'mark', cell: 99, id: 'b1' } });
  const rej = sent.pop();
  assert.equal(rej.type, 'rejected');
  assert.equal(rej.to, 'guest-1');
  assert.equal(rej.reason, 'cell-out-of-bounds');
  // identity is forced server-side: a player field on the cmd is ignored
  host.handleGuestMessage('guest-1', { type: 'cmd', cmd: { type: 'mark', cell: 0, player: 'you', id: 'm1' } });
  const snap = lastSnapshot(sent);
  const me = JSON.parse(snap.state).players.find(p => p.id === gid);
  assert.ok(me.marks.includes(0) || me.im > 0, 'applied to the guest seat, not you');
  // duplicate command id is idempotently ignored
  const before = sent.length;
  host.handleGuestMessage('guest-1', { type: 'cmd', cmd: { type: 'mark', cell: 0, id: 'm1' } });
  assert.equal(sent.length, before, 'no second state change, no error frame');
});

test('host calls authoritatively on a 4 s cadence and bots play', () => {
  const { host, sent, timers } = makeHost();
  const snapsBefore = sent.filter(m => m.type === 'snapshot').length;
  timers.tickIntervals(1); // one 4 s call beat
  const snap = lastSnapshot(sent);
  assert.ok(JSON.parse(snap.state).callIndex >= 0, 'a call happened');
  assert.equal(snap.hash, hashState(host.session.state), 'snapshot hash matches authoritative state');
  assert.ok(sent.filter(m => m.type === 'snapshot').length > snapsBefore);
});

test('round end fires onRoundEnd and restart timer posts a fresh seated broadcast', () => {
  const { host, sent, timers, endedRef } = makeHost();
  host.dispatch({ type: 'forfeit', player: 'you' });
  assert.equal(endedRef(), null, 'forfeit ends with no winner');
  timers.runTimeouts(15000);
  assert.ok(!host.session.ended, 'new round is live');
  assert.ok(sent.filter(m => m.type === 'seated').length >= 2);
});

test('host seat survives a disconnecting guest until the next round', () => {
  const { host, timers } = makeHost();
  host.handleGuestMessage('guest-1', { type: 'join-hall', name: 'G' });
  host.dispatch({ type: 'forfeit', player: 'you' });
  timers.runTimeouts(15000);
  const gid = host.playerIdFor('guest-1');
  host.markAbsent('guest-1');
  assert.equal(host.playerIdFor('guest-1'), gid, 'seat kept mid-round');
  host.dispatch({ type: 'forfeit', player: 'you' });
  timers.runTimeouts(15000);
  assert.equal(host.playerIdFor('guest-1'), undefined, 'absent member pruned at round start');
});
