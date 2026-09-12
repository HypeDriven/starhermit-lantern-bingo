'use strict';
// Realtime-rooms hall smoke test: a mock StarHermit platform (REST lobby +
// RFC6455 /ws/v1/realtime relay implementing guest→host / host→everyone
// routing, 16-byte sender prefixes, personalized roster pushes) with two real
// client stacks: a host running HallHost and a guest speaking the hall
// protocol over RoomsSocket. Validates the full hosted flow end-to-end.
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import { RoomsClient, HallHost } from '../js/hallnet.js';

const PORT = Number(process.env.HALL_PORT || 0);
const results = [];
const check = (name, ok, extra = '') => {
  results.push([name, ok]);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''));
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- mock platform
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const rooms = new Map(); // id -> {id, open, hostId, seq, participants:Map(pid->{sock,token}), results:[], tokens:Map(pid->token)}
const debugResults = [];
let roomSeq = 1;

function wsSendText(sock, obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  try { sock.write(Buffer.concat([header, payload])); } catch (_) {}
}
function wsSendBinary(sock, payload) {
  let header;
  if (payload.length < 126) header = Buffer.from([0x82, payload.length]);
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x82; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x82; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  try { sock.write(Buffer.concat([header, payload])); } catch (_) {}
}

function rosterPayload(room, selfId) {
  return {
    type: 'roster', hostId: room.hostId,
    participants: [...room.participants.keys()].map(pid => ({ id: pid, isHost: pid === room.hostId, isSelf: pid === selfId })),
  };
}
function broadcastRoster(room) {
  for (const [pid, m] of room.participants) wsSendText(m.sock, rosterPayload(room, pid));
}

function closeRoom(room, reason) {
  for (const [, m] of room.participants) {
    try { wsSendText(m.sock, { type: 'room-closed', reason }); m.sock.end(); } catch (_) {}
  }
  room.participants.clear();
  room.open = false;
  rooms.delete(room.id);
}

function id16(pid) {
  const b = Buffer.alloc(16);
  Buffer.from(String(pid)).copy(b, 0, 0, 16);
  return b;
}

function attachWs(sock, room, token) {
  let buf = Buffer.alloc(0);
  let pid = null;
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) { sock.destroy(); return; }
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (masked) {
        const mask = buf.subarray(maskOff, maskOff + 4);
        const un = Buffer.alloc(len);
        for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i & 3];
        payload = un;
      }
      buf = buf.subarray(off + len);
      if (opcode === 8) { sock.end(); return; }
      if (opcode === 9) { try { sock.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); } catch (_) {} continue; }
      if (opcode === 1) {
        // text control frames go to everyone
        for (const [other, m] of room.participants) if (other !== pid) wsSendText(m.sock, JSON.parse(payload.toString('utf8')));
      } else if (opcode === 2) {
        // binary: the relay stamps the 16-byte sender prefix from the
        // connection; guest→host only, host→everyone else
        const stamped = Buffer.concat([id16(pid), payload]);
        if (pid === room.hostId) {
          for (const [other, m] of room.participants) if (other !== pid) wsSendBinary(m.sock, stamped);
        } else {
          const host = room.participants.get(room.hostId);
          if (host) wsSendBinary(host.sock, stamped);
        }
      }
    }
  });
  sock.on('close', () => {
    if (!pid || !room.participants.has(pid)) return;
    room.participants.delete(pid);
    if (pid === room.hostId) { closeRoom(room, 'host-left'); return; }
    if (room.participants.size === 0) { rooms.delete(room.id); return; }
    broadcastRoster(room);
  });
  sock.on('error', () => {});
  return (assignedPid) => { pid = assignedPid; };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return; }
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = body ? JSON.parse(body) : {};
    if (url.pathname === '/api/v1/realtime/rooms/quick-join') {
      for (const room of rooms.values()) {
        if (room.open) {
          return json(200, {
            id: room.id, hostId: room.hostId,
            participants: [...room.participants.keys()].map(pid => ({ id: pid, isHost: pid === room.hostId })),
          });
        }
      }
      return json(404, { error: 'no-open-rooms' });
    }
    if (url.pathname === '/api/v1/realtime/rooms' && req.method === 'POST') {
      const id = 'room-' + roomSeq++;
      const room = { id, open: false, hostId: null, seq: 0, participants: new Map(), results: [], creatorToken: token };
      rooms.set(id, room);
      return json(200, { id, open: false, participants: [] });
    }
    const m = url.pathname.match(/^\/api\/v1\/realtime\/rooms\/([^/]+)\/(open|leave|result)$/);
    if (m) {
      const room = rooms.get(m[1]);
      if (!room) return json(404, { error: 'no-room' });
      if (m[2] === 'open') { room.open = true; return json(200, { ok: true, id: room.id, hostId: room.hostId, participants: [...room.participants.keys()].map(pid => ({ id: pid })) }); }
      if (m[2] === 'leave') {
        for (const [pid, p] of room.participants) if (p.token === token) room.participants.delete(pid);
        if ([...room.participants.keys()][0] === room.hostId || !room.participants.has(room.hostId)) { closeRoom(room, 'host-left'); return json(200, { ok: true }); }
        broadcastRoster(room);
        return json(200, { ok: true });
      }
      if (m[2] === 'result') { debugResults.push({ room: room.id, body: j }); room.results.push(j); return json(200, { ok: true }); }
    }
    if (url.pathname === '/api/v1/realtime/rooms/mine') {
      const mine = [];
      for (const room of rooms.values()) {
        for (const p of room.participants.values()) if (p.token === token) mine.push({ id: room.id, hostId: room.hostId });
      }
      return json(200, { rooms: mine });
    }
    json(404, { error: 'not-found' });
  });
});

server.on('upgrade', (req, sock) => {
  const url = new URL(req.url, 'http://x');
  if (process.env.HALL_DEBUG) console.log('[mock] upgrade', url.pathname, url.search);
  if (url.pathname !== '/ws/v1/realtime') { sock.destroy(); return; }
  const room = rooms.get(url.searchParams.get('roomId'));
  const token = url.searchParams.get('access_token');
  if (!room || !token) { sock.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64') + '\r\n\r\n');
  // participant ids are stable per user (keyed by token), as a real platform
  // would key them by account; the first participant is the room host
  const pid = 'u:' + token;
  if (!room.hostId) room.hostId = pid;
  if (process.env.HALL_DEBUG) console.log('[mock] participant', pid, 'joined', room.id, 'host=', room.hostId);
  const setPid = attachWs(sock, room, token);
  room.participants.set(pid, { sock, token });
  setPid(pid);
  wsSendText(sock, rosterPayload(room, pid));
  broadcastRoster(room);
});

await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------- client stacks
const loc = { protocol: 'http:', host: `127.0.0.1:${server.address().port}` };
const mkApi = (token) => async (path, opts = {}) => {
  const r = await fetch(base + path, {
    ...opts,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...(opts.headers || {}) },
  });
  return r;
};

const STAGE = {
  id: 'hosted-smoke', title: 'Smoke Hall', seed: 4242, pattern: 'any-line',
  parCalls: 60, bots: 0, botSkill: 0.6, version: 1, theme: 'ember',
};

function guestCollect(socket) {
  const got = { seated: [], snapshots: [], rejected: [], youAre: [] };
  socket.onbinary = ({ from, msg }) => {
    if (msg.type === 'seated') got.seated.push(msg);
    else if (msg.type === 'snapshot') got.snapshots.push(msg);
    else if (msg.type === 'rejected') got.rejected.push(msg);
    else if (msg.type === 'you-are') got.youAre.push(msg);
    void from;
  };
  return got;
}
async function waitFor(fn, ms = 8000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what);
    await wait(25);
  }
}

// ---- 1. host creates + opens a hall, becomes the caller
const roomsA = new RoomsClient({ api: mkApi('token-host'), loc });
const { room, created } = await roomsA.quickJoinOrCreate('lantern-bingo');
check('quick-join 404 → create+open path', created && !!roomsA.roomId(room));
const socketA = await roomsA.connect(roomsA.roomId(room), 'token-host');
socketA.observeRoom(room);
const selfA = await socketA.resolveSelf();
check('host resolves own participant id', !!selfA, selfA);
await waitFor(() => socketA.hostId, 2000, 'host id from roster');
check('roster push names the host', socketA.hostId === selfA);
// route guest→host frames into the hall, as enterHallAsHost does in game.js
let hallHost = null;
socketA.isHost = true;
socketA.onbinary = ({ from, msg }) => {
  if (msg && msg.type === 'you-are') return;
  if (hallHost) hallHost.handleGuestMessage(from, msg);
};

let hostEnded = null;
hallHost = new HallHost({
  send: (obj) => { try { socketA.sendBinary(obj); } catch (_) {} },
  selfId: selfA,
  nickname: 'Smoke Host',
  onEvent: () => {},
  onRoundEnd: (w) => {
    hostEnded = w;
    // as hostHallEnded does in game.js: post the room result (best-effort)
    roomsA.postResult(roomsA.roomId(room), { winner: w, stage: hallHost.stage.id, rounds: hallHost.rounds });
  },
}, { callIntervalMs: 60, roundRestartMs: 400, stageFor: () => STAGE });
hallHost.stage.botSkill = -1; // deterministic: bots never play in this test

// ---- 2. guest quick-joins the open hall and spectates the live round
const roomsB = new RoomsClient({ api: mkApi('token-guest'), loc });
const joinB = await roomsB.quickJoinOrCreate('lantern-bingo');
check('guest quick-joins the open hall', !joinB.created && joinB.room.id === room.id);
check('quick-join carries the host id', joinB.room.hostId === selfA);
const socketB = await roomsB.connect(roomsB.roomId(joinB.room), 'token-guest');
socketB.observeRoom(joinB.room);
const selfB = await socketB.resolveSelf();
check('guest resolves own participant id (distinct from host)', !!selfB && selfB !== selfA, selfB);
const gotB = guestCollect(socketB);
socketB.sendBinary({ type: 'join-hall', name: 'Smoke Guest' });

const seat1 = await waitFor(() => gotB.seated[0], 4000, 'guest seat notice');
check('guest seated notice arrives addressed to them', seat1.you === selfB);
const seat1mine = (seat1.seats || []).find(s => s.participantId === selfB);
check('mid-round joiner is a spectator', seat1mine && seat1mine.seated === false);
check('seat names carry nicknames', (seat1.seats || []).some(s => s.name === 'Smoke Host'));

// ---- 3. round restarts: the waiting guest gets a real seat
hallHost.dispatch({ type: 'forfeit', player: 'you' });
await waitFor(() => gotB.seated.length >= 2, 4000, 'new-round broadcast');
const seat2 = gotB.seated[1];
const seat2mine = (seat2.seats || []).find(s => s.participantId === selfB);
check('new round seats the waiting guest', seat2mine && typeof seat2mine.playerId === 'string' && seat2mine.seated);
const guestPlayerId = seat2mine.playerId;
check('host-side seat matches guest player id', hallHost.playerIdFor(selfB) === guestPlayerId);

// ---- 4. host calls authoritatively; guest marks a called number
const snapWithCall = await waitFor(
  () => gotB.snapshots.find(s => JSON.parse(s.state).callIndex >= 0),
  8000, 'a called number');
const st1 = JSON.parse(snapWithCall.state);
const me1 = st1.players.find(p => p.id === guestPlayerId);
const called = st1.deck.slice(0, st1.callIndex + 1);
const markable = me1.card.findIndex(v => called.includes(v) && v !== 0 && !me1.marks.includes(me1.card.indexOf(v)));
check('called number exists on the guest card (markable)', markable >= 0, 'cell ' + markable);
socketB.sendBinary({ type: 'cmd', cmd: { type: 'mark', cell: markable, id: 'mk1' } });
const marked = await waitFor(() => {
  const s = gotB.snapshots.map(x => JSON.parse(x.state)).reverse()
    .find(x => ((x.players.find(p => p.id === guestPlayerId) || {}).marks || []).includes(markable));
  return s || null;
}, 4000, 'guest mark in snapshots');
check('legal guest mark applied authoritatively', !!marked);

// duplicate command id is ignored (no error frame, no state change)
const rejBefore = gotB.rejected.length;
socketB.sendBinary({ type: 'cmd', cmd: { type: 'mark', cell: markable, id: 'mk1' } });
await wait(150);
check('duplicate command id ignored', gotB.rejected.length === rejBefore);

// ---- 5. validation: out-of-bounds rejected, identity forced, false claim rejected
socketB.sendBinary({ type: 'cmd', cmd: { type: 'mark', cell: 99, id: 'bad1' } });
await waitFor(() => gotB.rejected.find(r => r.to === selfB), 3000, 'bounds rejection');
check('out-of-bounds mark rejected to the guest', gotB.rejected.some(r => r.to === selfB));
socketB.sendBinary({ type: 'cmd', cmd: { type: 'mark', cell: 0, player: 'you', id: 'bad2' } });
await waitFor(() => {
  const latest = JSON.parse(gotB.snapshots[gotB.snapshots.length - 1].state);
  const g = latest.players.find(p => p.id === guestPlayerId);
  const you = latest.players.find(p => p.id === 'you');
  return g && (g.marks.includes(0) || g.im > 0) && !(you.marks.includes(0) && you.mm > 0) ? latest : null;
}, 3000, 'identity-forced mark');
check('guest cannot mark as the host seat', true);
socketB.sendBinary({ type: 'cmd', cmd: { type: 'claim', id: 'c1' } });
await waitFor(() => gotB.rejected.find(r => r.to === selfB && r.reason), 3000, 'false claim rejection');
check('false claim rejected to the guest', gotB.rejected.filter(r => r.to === selfB).length >= 2);

// ---- 6. round end: result posted, guest sees the ended snapshot
const snapsBeforeEnd = gotB.snapshots.length;
hallHost.dispatch({ type: 'forfeit', player: 'you' });
await waitFor(() => gotB.snapshots.length > snapsBeforeEnd && JSON.parse(gotB.snapshots[gotB.snapshots.length - 1].state).phase === 'ended', 3000, 'ended snapshot');
check('guest sees the ended round', true);
await waitFor(() => debugResults.length >= 1, 3000, 'result posted');
check('host posted the room result', debugResults.length >= 1 && debugResults[0].room === room.id);

// ---- 7. reconnect: guest reclaims the same seat via join-hall
socketB.close();
await wait(150);
const socketB2 = await roomsB.connect(roomsB.roomId(joinB.room), 'token-guest');
const gotB2 = guestCollect(socketB2);
const selfB2 = await socketB2.resolveSelf();
check('reconnect keeps the same participant id', selfB2 === selfB, selfB2);
socketB2.sendBinary({ type: 'join-hall', name: 'Smoke Guest' });
const seat3 = await waitFor(() => gotB2.seated[0], 4000, 'reconnect seat');
const seat3mine = (seat3.seats || []).find(s => s.participantId === selfB);
check('reconnect reclaims the seat (or is queued for the live round)', !!seat3mine);

// ---- 8. host leaving closes the hall honestly for the guest
let guestClosed = false;
socketB2.onclose = () => { guestClosed = true; };
let roomClosedText = false;
socketB2.ontext = (msg) => { if (msg && msg.type === 'room-closed') roomClosedText = true; };
socketA.close();
await waitFor(() => guestClosed || roomClosedText || rooms.size === 0, 4000, 'room closes when host leaves');
check('host departure closes the hall for the guest', guestClosed || roomClosedText || rooms.size === 0);

hallHost.stop();
const failed = results.filter(r => !r[1]).length;
console.log(failed ? `${failed} FAILURES` : 'ALL HALL ROOMS SMOKE TESTS PASSED');
process.exit(failed ? 1 : 0);
