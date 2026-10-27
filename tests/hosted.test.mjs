// Hosted halls end to end over a fake platform running server.js: the first
// player finds no open hall and creates and opens one, a second quick-joins
// it; the host starts the round; both clients receive the script's view,
// send marks and claims, and get the script's result. No client is the
// authority. Run: node --test tests/hosted.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HallClient } from '../js/hosted.js';
import { legalActions, patternComplete } from '../js/rules.js';
import { fakePlatform, flush } from './fake-platform.mjs';

function recorder() {
  const ev = { starts: 0, states: 0, over: null, rejects: [], unavailable: [], lobbies: 0 };
  return {
    ev,
    hooks: {
      onLobby: () => { ev.lobbies++; },
      onStart: () => { ev.starts++; },
      onState: () => { ev.states++; },
      onOver: (o) => { ev.over = o; },
      onReject: (r, cell) => ev.rejects.push([r, cell]),
      onUnavailable: (c) => ev.unavailable.push(c),
    },
  };
}

test('a hosted hall from the lobby to the script\'s result', async () => {
  const fp = fakePlatform();
  const h = recorder(), g = recorder();
  const made = await HallClient.open(fp.adapter('ua', 'Ann'), h.hooks);
  assert.ok(made.ok);
  const host = made.client;
  assert.equal(host.isHost, true);
  const joined = await HallClient.open(fp.adapter('ub', 'Bo'), g.hooks);
  assert.ok(joined.ok);
  const guest = joined.client;
  await flush();
  assert.equal(guest.isHost, false);
  assert.deepEqual(host.players.map((p) => [p.name, p.you, p.host]), [['Ann', true, true], ['Bo', false, false]]);
  assert.deepEqual((await guest.start()), { ok: false, error: 'not-host' });
  assert.ok((await host.start()).ok);
  await flush(); await flush();
  assert.equal(h.ev.starts, 1);
  assert.equal(g.ev.starts, 1);
  assert.equal(host.you, 'p1');
  assert.equal(guest.you, 'p2');
  assert.deepEqual(guest.seats.map((s) => s.name), ['Ann', 'Bo', 'lantern-1', 'lantern-2']);
  assert.equal(guest.nameOf('p1'), 'Ann');
  assert.equal(host.state.seed, 0, 'no seed reaches a client');
  // A false claim is refused back to its sender and costs that seat.
  assert.ok(guest.claim().ok);
  await flush(); await flush();
  assert.deepEqual(g.ev.rejects.at(-1), ['pattern-incomplete', null]);
  assert.equal(host.state.players[1].invalidClaims, 1);
  assert.equal(guest.mark(12).ok, false, 'the free centre is never sent');
  // Both play every call; the script decides the winner.
  for (let i = 0; i < 2000 && !h.ev.over; i++) {
    fp.tick(250);
    await flush();
    for (const c of [host, guest]) {
      if (!c.state || c.over) continue;
      const m = legalActions(c.state, c.you).find((a) => a.type === 'mark');
      if (m) for (const cell of m.cells) c.mark(cell);
      await flush(); await flush();
      const me = c.state.players.find((p) => p.id === c.you);
      if (patternComplete(me.marks, c.state.pattern)) c.claim();
    }
    await flush(); await flush();
  }
  assert.ok(h.ev.over, 'the host heard the result');
  await flush();
  assert.ok(g.ev.over, 'the guest heard the result');
  assert.equal(h.ev.over.winner, fp.room.result.winner);
  assert.equal(fp.room.status, 'closed');
  assert.equal(host.phase, 'over');
  host.leave(); guest.leave();
});

test('a room that starts without a bound session is unavailable', async () => {
  const fp = fakePlatform();
  const h = recorder();
  const ad = fp.adapter('ua', 'Ann');
  ad.startRoom = async () => ({ ok: true, status: 200, data: { roomId: 'room-1', gameSessionId: null } });
  const made = await HallClient.open(ad, h.hooks);
  const r = await made.client.start();
  assert.deepEqual(r, { ok: false, error: 'no-session' });
  assert.deepEqual(h.ev.unavailable, ['no-session']);
});

test('signed out: no hall opens', async () => {
  const fail = { quickJoin: async () => ({ ok: false, status: 0, error: 'signed-out' }) };
  assert.deepEqual(await HallClient.open(fail, {}), { ok: false, error: 'signed-out' });
});
