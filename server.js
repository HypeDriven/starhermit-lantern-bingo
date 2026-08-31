'use strict';

// Lantern Bingo — authoritative host server (StarHermit `server=server.js`).
// Serves the static distribution, /api/v1/time, and realtime hosted rooms over
// a minimal RFC6455 WebSocket implementation (no external dependencies).
// The server owns rules state for hosted rounds; clients send commands, the
// server validates (identity, bounds, legality, duplicates) and broadcasts
// immutable snapshots. Client clocks and scores are never trusted.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Session } from './js/session.js';
import { serialize as serializeState, legalActions, patternComplete, hashState } from './js/rules.js';
import { dailyFor } from './js/content.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.opus': 'audio/ogg',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/v1/time') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ now: Date.now() }));
    return;
  }
  if (url.pathname === '/api/v1/daily') {
    const day = new Date().toISOString().slice(0, 10);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(dailyFor(day)));
    return;
  }
  // static files, confined to ROOT
  let p = path.normalize(decodeURIComponent(url.pathname));
  if (p === '/' || p === '\\') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || p.includes('..')) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not-found' })); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------------------------------------------------------- websocket
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
}

function wsSend(sock, obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  try { sock.write(Buffer.concat([header, payload])); } catch (_) {}
}

// Parse masked client text frames; calls onMessage(json) per complete frame.
function attachWsParser(sock, onMessage, onClose) {
  let buf = Buffer.alloc(0);
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
      if (len > 1 << 20) { sock.destroy(); return; } // payload size bound
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
      if (opcode === 8) { onClose(); sock.end(); return; }
      if (opcode === 9) { // ping -> pong
        const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
        try { sock.write(pong); } catch (_) {}
        continue;
      }
      if (opcode === 1) {
        try { onMessage(JSON.parse(payload.toString('utf8'))); } catch (_) { /* drop malformed */ }
      }
    }
  });
  sock.on('close', onClose);
  sock.on('error', onClose);
}

// ---------------------------------------------------------------- hosted room
const CALL_INTERVAL_MS = 4000;
const ROOM_SIZE = 4; // humans + bots

const room = {
  id: 'hall-1',
  session: null,
  stage: null,
  members: new Map(), // playerId -> {sock|null, seen:Set(cmdId), name}
  callTimer: null,
  nextGuest: 1,
};

function broadcast(obj) {
  for (const m of room.members.values()) if (m.sock) wsSend(m.sock, obj);
}

function snapshotMsg(extra = {}) {
  return { type: 'snapshot', state: serializeState(room.session.state), hash: hashState(room.session.state), ...extra };
}

function startRoom() {
  const day = new Date().toISOString().slice(0, 10);
  const stage = { ...dailyFor(day), id: 'hosted-' + day };
  room.stage = stage;
  // humans keep their seats; remaining seats are deterministic bots
  const humans = [...room.members.keys()];
  const ids = humans.slice(0, ROOM_SIZE);
  let botN = 1;
  while (ids.length < ROOM_SIZE) ids.push('lantern-' + botN++);
  room.session = new Session({
    seed: stage.seed, pattern: stage.pattern, parCalls: stage.parCalls,
    playerIds: ids,
    meta: { mode: 'hosted', contentId: stage.id, version: stage.version },
  });
  room.session.onEvent(({ events }) => {
    for (const e of events) if (e.type === 'win') endHostedRound(e.player);
  });
  clearInterval(room.callTimer);
  room.callTimer = setInterval(serverCall, CALL_INTERVAL_MS);
}

function ensureRoom() {
  if (room.session && !room.session.ended) return;
  startRoom();
}

function serverCall() {
  if (!room.session || room.session.ended) { clearInterval(room.callTimer); return; }
  room.session.dispatch({ type: 'call' });
  // deterministic bots: mark all legal cells with skill-based notice, then claim
  const state = room.session.state;
  for (const p of state.players) {
    if (!p.id.startsWith('lantern-') || room.session.ended) continue;
    const skill = room.stage.botSkill || 0.6;
    const notices = ((state.tick * 2654435761 + p.id.length * 97) % 1000) / 1000 < skill;
    if (notices) {
      const mark = legalActions(room.session.state, p.id).find(a => a.type === 'mark');
      if (mark) for (const cell of mark.cells) {
        if (room.session.ended) break;
        room.session.dispatch({ type: 'mark', player: p.id, cell });
      }
    }
    const me = room.session.state.players.find(pl => pl.id === p.id);
    if (me && !room.session.ended && patternComplete(me.marks, room.session.state.pattern)) {
      room.session.dispatch({ type: 'claim', player: p.id });
    }
  }
  broadcast(snapshotMsg());
  if (room.session.ended) clearInterval(room.callTimer);
}

function endHostedRound(winner) {
  broadcast(snapshotMsg({ type: 'snapshot', winner }));
  clearInterval(room.callTimer);
  // results reconciliation: reset room after a grace period
  setTimeout(() => { room.session = null; ensureRoom(); }, 15000);
}

function handleJoin(sock, msg) {
  // reconnect path: returning player reclaims their seat and gets a snapshot
  let playerId = msg.playerId && room.members.has(msg.playerId) ? msg.playerId : null;
  if (!playerId) {
    playerId = 'guest-' + room.nextGuest++;
    room.members.set(playerId, { sock: null, seen: new Set() });
  }
  const member = room.members.get(playerId);
  member.sock = sock;
  // seat the human: if the live round has no seat for them, restart the round
  // with humans seated (rounds are short; seats are assigned at start).
  if (!room.session || room.session.ended ||
      !room.session.state.players.some(p => p.id === playerId)) {
    startRoom();
  }
  const inSeats = room.session.state.players.some(p => p.id === playerId);
  wsSend(sock, {
    type: 'joined', playerId, roomId: room.id, stage: room.stage,
    state: serializeState(room.session.state),
    spectator: !inSeats,
    whileAway: room.session.state.callIndex >= 0
      ? `While you were away: ${room.session.state.callIndex + 1} numbers were called.` : null,
  });
}

function handleCmd(sock, playerId, msg) {
  const member = room.members.get(playerId);
  if (!member) return;
  const cmd = msg.cmd;
  if (!cmd || (cmd.type !== 'mark' && cmd.type !== 'claim')) {
    wsSend(sock, { type: 'rejected', reason: 'unsupported-command' }); return;
  }
  // identity is forced server-side; client-supplied player fields are ignored
  const stamped = { type: cmd.type, player: playerId };
  if (cmd.type === 'mark') {
    const cell = cmd.cell | 0;
    if (cell < 0 || cell >= 25) { wsSend(sock, { type: 'rejected', reason: 'cell-out-of-bounds' }); return; }
    stamped.cell = cell;
  }
  // idempotent duplicate rejection by command id
  if (cmd.id) {
    if (member.seen.has(cmd.id)) return;
    member.seen.add(cmd.id);
  }
  if (!room.session || room.session.ended) { wsSend(sock, { type: 'rejected', reason: 'game-not-active' }); return; }
  const r = room.session.dispatch(stamped);
  if (!r.ok) wsSend(sock, { type: 'rejected', reason: r.error });
  broadcast(snapshotMsg());
}

server.on('upgrade', (req, sock) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') { sock.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n');
  let playerId = null;
  // simple rate limit: max 30 messages per 10s per socket
  let msgCount = 0;
  const rateTimer = setInterval(() => { msgCount = 0; }, 10000);
  attachWsParser(sock, (msg) => {
    msgCount++;
    if (msgCount > 30) { wsSend(sock, { type: 'rejected', reason: 'rate-limited' }); return; }
    if (msg.type === 'join') {
      handleJoin(sock, msg);
      // recover playerId assigned by handleJoin for later frames
      for (const [id, m] of room.members) if (m.sock === sock) playerId = id;
    } else if (msg.type === 'cmd' && playerId) {
      handleCmd(sock, playerId, msg);
    }
  }, () => {
    clearInterval(rateTimer);
    if (playerId && room.members.has(playerId)) room.members.get(playerId).sock = null;
  });
});

ensureRoom();
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT to a free port.`);
    process.exit(1);
  }
  throw err;
});
server.listen(PORT, () => {
  console.log(`Lantern Bingo server listening on http://localhost:${PORT}`);
});
