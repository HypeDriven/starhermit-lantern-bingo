'use strict';

// Hosted hall over StarHermit realtime rooms (host-routed).
// The hall's existing JSON messages (seated/snapshot/rejected/cmd) are carried
// as binary frames: a 16-byte sender participant id prefix + JSON payload,
// guest→host only, host→everyone. The host client runs the caller/rounds with
// the same Session + bots the local game uses; the platform routes frames.
// DOM-free: WebSocket/timers are injectable so node tests can drive it.

import { Session } from './session.js';
import {
  serialize as serializeState, legalActions, patternComplete, hashState,
} from './rules.js';
import { dailyFor } from './content.js';

export const MAX_BINARY_FRAME = 8192; // 8 KB/frame cap
const MAX_TEXT_FRAME = 4096;          // JSON control frames ≤4 KB
const GUEST_MSGS_PER_SEC = 30;        // guests: ready/chat/inputs cap
const CALL_INTERVAL_MS = 4000;
const ROOM_SIZE = 4;                  // humans + bot lanterns
const ROUND_RESTART_MS = 15000;

// ---------------------------------------------------------------- codec
const te = new TextEncoder();
const td = new TextDecoder();

function idBytes(id) {
  const b = te.encode(String(id));
  const out = new Uint8Array(16);
  out.set(b.subarray(0, 16));
  return out;
}
function bytesId(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return td.decode(bytes.subarray(0, end));
}
// Wire frame: the SERVER prefixes each binary frame with the 16-byte sender
// participant id — clients send bare JSON payloads and strip the prefix on
// receipt (guest→host only, host→everyone).
export function encodePayload(obj) {
  const payload = te.encode(JSON.stringify(obj));
  if (payload.length > MAX_BINARY_FRAME) throw new Error('frame too large');
  return payload;
}
// Test/server-side helper: stamp a sender id onto a payload.
export function encodeFrame(senderId, obj) {
  const payload = encodePayload(obj);
  const out = new Uint8Array(16 + payload.length);
  out.set(idBytes(senderId), 0);
  out.set(payload, 16);
  return out;
}
export function decodeFrame(bytes) {
  if (bytes.length < 17) return null; // prefix + at least 1 payload byte
  const from = bytesId(bytes.subarray(0, 16));
  let msg = null;
  try { msg = JSON.parse(td.decode(bytes.subarray(16))); } catch (_) { return null; }
  return { from, msg };
}

// ---------------------------------------------------------------- REST lobby
export class RoomsClient {
  // deps: {api} platform api helper (Bearer-injecting fetch wrapper),
  // {wsImpl} WebSocket constructor, {loc} window.location.
  constructor({ api, wsImpl, loc }) {
    this.api = api;
    this.wsImpl = wsImpl || globalThis.WebSocket;
    this.loc = loc || globalThis.location;
  }

  roomId(room) { return room && (room.id || room.roomId) || null; }

  // Quick-join an open hall; 404 → create one and open it.
  // Resolves {room, created} — the creator is the hall's host.
  async quickJoinOrCreate(slug) {
    try {
      const r = await this.api('/api/v1/realtime/rooms/quick-join', {
        method: 'POST',
        body: JSON.stringify({ gameSlug: slug, seats: 1 }),
      });
      if (r.ok) return { room: await r.json(), created: false };
    } catch (_) { /* fall through to create (offline rooms API → caller handles) */ }
    const r = await this.api('/api/v1/realtime/rooms', {
      method: 'POST',
      body: JSON.stringify({
        teamCount: 1, seatsPerTeam: ROOM_SIZE,
        metadata: { gameSlug: slug, title: 'Lantern Bingo hall' },
      }),
    });
    if (!r.ok) throw new Error('rooms create failed: ' + r.status);
    const room = await r.json();
    const id = this.roomId(room);
    const o = await this.api(`/api/v1/realtime/rooms/${encodeURIComponent(id)}/open`, { method: 'POST', body: '{}' });
    if (!o.ok) throw new Error('rooms open failed: ' + o.status);
    return { room, created: true };
  }

  async leave(id) {
    try { await this.api(`/api/v1/realtime/rooms/${encodeURIComponent(id)}/leave`, { method: 'POST', body: '{}' }); } catch (_) {}
  }

  async postResult(id, result) {
    try {
      await this.api(`/api/v1/realtime/rooms/${encodeURIComponent(id)}/result`, {
        method: 'POST', body: JSON.stringify({ result }),
      });
    } catch (_) { /* result posting is best-effort */ }
  }

  async mine() {
    try {
      const r = await this.api('/api/v1/realtime/rooms/mine');
      if (!r.ok) return [];
      const j = await r.json().catch(() => null);
      const rooms = Array.isArray(j) ? j : (j && (j.rooms || j.items)) || [];
      return rooms;
    } catch (_) { return []; }
  }

  connect(roomId, token) {
    return new Promise((resolve, reject) => {
      const proto = this.loc && this.loc.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = this.loc ? this.loc.host : '';
      const url = `${proto}//${host}/ws/v1/realtime?roomId=${encodeURIComponent(roomId)}&access_token=${encodeURIComponent(token)}`;
      let ws;
      try { ws = new this.wsImpl(url); } catch (e) { reject(e); return; }
      ws.binaryType = 'arraybuffer';
      const sock = new RoomsSocket(ws, false);
      const timeout = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('rooms socket timeout')); }, 8000);
      ws.onopen = () => { clearTimeout(timeout); resolve(sock); };
      ws.onerror = () => { clearTimeout(timeout); reject(new Error('rooms socket failed')); };
    });
  }
}

// ---------------------------------------------------------------- socket
export class RoomsSocket {
  constructor(ws, isHost) {
    this.ws = ws;
    this.isHost = isHost;
    this.selfId = null;   // resolved from roster flags or a host whoami echo
    this.hostId = null;   // resolved from room payloads / roster flags
    this.roster = [];     // latest participant list from any source
    this.onbinary = null; // ({from, msg})
    this.ontext = null;   // (msg)
    this.onclose = null;
    this.onroster = null; // (roster) — room/presence pushes
    this._sendTimes = [];
    ws.onmessage = (ev) => this._message(ev);
    ws.onclose = () => { if (this.onclose) this.onclose(); };
  }

  _message(ev) {
    if (typeof ev.data === 'string') {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      this._observe(msg);
      if (this.ontext) this.ontext(msg);
      return;
    }
    const bytes = new Uint8Array(ev.data);
    const frame = decodeFrame(bytes);
    if (!frame) return;
    this._observe(frame.msg, frame.from);
    if (this.onbinary) this.onbinary(frame);
  }

  // Defensively harvest identity/host hints from anything that carries them.
  _observe(msg, from) {
    if (!msg || typeof msg !== 'object') return;
    const rosters = [];
    if (Array.isArray(msg.participants)) rosters.push(msg.participants);
    if (Array.isArray(msg.roster)) rosters.push(msg.roster);
    for (const list of rosters) {
      this.roster = list;
      for (const p of list) {
        if (!p) continue;
        const pid = p.id || p.participantId || p.userId;
        if (!pid) continue;
        if (p.host || p.isHost) this.hostId = pid;
        if (p.self || p.isMe || p.isSelf || p.you) this.selfId = pid;
      }
      if (this.onroster) { try { this.onroster(list); } catch (_) {} }
    }
    if (msg.type === 'you-are' && msg.participantId) this.selfId = String(msg.participantId);
    if (msg.type === 'roster' && from && !this.hostId) this.hostId = from;
    if (msg.hostId) this.hostId = String(msg.hostId);
  }

  observeRoom(room) {
    if (!room) return;
    if (room.hostId || (room.host && (room.host.id || room.host.participantId))) {
      this.hostId = String(room.hostId || room.host.id || room.host.participantId);
    }
    if (room.me || room.self || room.you) this.selfId = String(room.me || room.self || room.you);
    if (Array.isArray(room.participants)) {
      this.roster = room.participants;
      for (const p of room.participants) {
        if (!p) continue;
        const pid = p.id || p.participantId || p.userId;
        if (!pid) continue;
        if (p.host || p.isHost) this.hostId = pid;
        if (p.self || p.isMe || p.isSelf || p.you) this.selfId = pid;
      }
    }
  }

  // Resolve our own participant id: roster/room flags first, then ask the host.
  async resolveSelf(timeoutMs = 5000) {
    if (this.selfId) return this.selfId;
    const asked = new Promise((resolve) => {
      const prev = this.onbinary;
      const to = setTimeout(() => { this.onbinary = prev; resolve(null); }, timeoutMs);
      this.onbinary = (frame) => {
        if (prev) prev(frame);
        if (frame.msg && frame.msg.type === 'you-are' && frame.msg.participantId) {
          clearTimeout(to);
          this.onbinary = prev;
          resolve(String(frame.msg.participantId));
        }
      };
    });
    try { this.sendBinary({ type: 'whoami' }); } catch (_) {}
    const id = await asked;
    return this.selfId || id;
  }

  sendBinary(obj) {
    if (!this.isHost) {
      const now = Date.now();
      this._sendTimes = this._sendTimes.filter((t) => now - t < 1000);
      if (this._sendTimes.length >= GUEST_MSGS_PER_SEC) return; // drop, never queue-flood
      this._sendTimes.push(now);
    }
    this.ws.send(encodePayload(obj)); // the server stamps the sender prefix
  }

  sendText(obj) {
    const text = JSON.stringify(obj);
    if (te.encode(text).length > MAX_TEXT_FRAME) return;
    this.ws.send(text);
  }

  close() { try { this.ws.close(); } catch (_) {} }
}

// ---------------------------------------------------------------- host
// The host client owns the round: it seats joiners, fills with bot lanterns,
// calls every 4 s, applies guest commands with forced identity, and broadcasts
// snapshots. Mirrors the repo's own server.js hall logic client-side.
export class HallHost {
  // opts: {send(obj) broadcast, selfId, nickname, onEvent(events), onRoundEnd(winner)}
  // deps: {setInterval, clearInterval, setTimeout, stageFor}
  constructor(opts, deps = {}) {
    this.send = opts.send;
    this.selfId = String(opts.selfId || 'host');
    this.nickname = opts.nickname || 'Player ' + this.selfId.slice(0, 8);
    this.onEvent = opts.onEvent || (() => {});
    this.onRoundEnd = opts.onRoundEnd || (() => {});
    this.onRoundStart = opts.onRoundStart || (() => {});
    this.setInterval = deps.setInterval || globalThis.setInterval;
    this.clearInterval = deps.clearInterval || globalThis.clearInterval;
    this.setTimeout = deps.setTimeout || globalThis.setTimeout;
    this.clearTimeout = deps.clearTimeout || globalThis.clearTimeout;
    this.stageFor = deps.stageFor || defaultStageFor;
    this.callIntervalMs = deps.callIntervalMs || CALL_INTERVAL_MS;
    this.roundRestartMs = deps.roundRestartMs || ROUND_RESTART_MS;
    this.members = new Map(); // participantId -> {name, playerId, seen:Set, present}
    this.session = null;
    this.stage = null;
    this.callTimer = null;
    this.restartTimer = null;
    this.rounds = 0;
    // the host's own seat
    this.members.set(this.selfId, { name: this.nickname, playerId: 'you', seen: new Set(), present: true });
    this.startRound();
  }

  seats() {
    const out = [];
    for (const [participantId, m] of this.members) {
      out.push({ participantId, playerId: m.playerId, name: m.name, seated: !!m.playerId });
    }
    return out;
  }

  me() { return this.members.get(this.selfId); }

  playerIdFor(participantId) {
    const m = this.members.get(participantId);
    return m && m.playerId;
  }

  startRound() {
    const day = new Date().toISOString().slice(0, 10);
    this.stage = { ...this.stageFor(day), id: 'hosted-' + day };
    // prune absent members, then seat everyone present
    for (const [id, m] of this.members) {
      if (!m.present) { this.members.delete(id); continue; }
      m.seen = new Set();
      m.playerId = null;
    }
    const ids = [];
    const me = this.me();
    me.playerId = 'you';
    ids.push('you');
    for (const [id, m] of this.members) {
      if (m.playerId || ids.length >= ROOM_SIZE) continue;
      m.playerId = 'ph-' + String(id).slice(0, 8);
      ids.push(m.playerId);
    }
    let botN = 1;
    while (ids.length < ROOM_SIZE) ids.push('lantern-' + botN++);
    this.session = new Session({
      seed: this.stage.seed >>> 0, pattern: this.stage.pattern,
      parCalls: this.stage.parCalls, playerIds: ids,
      meta: { mode: 'hosted', contentId: this.stage.id, version: this.stage.version },
    });
    this.rounds++;
    this.clearInterval(this.callTimer);
    this.callTimer = this.setInterval(() => this.hostCall(), this.callIntervalMs);
    this.broadcastSeated();
    this.onRoundStart(this.stage);
  }

  broadcastSeated() {
    this.send({
      type: 'seated', stage: this.stage,
      state: serializeState(this.session.state), seats: this.seats(),
    });
  }

  broadcastSnapshot() {
    this.send({
      type: 'snapshot', state: serializeState(this.session.state),
      hash: hashState(this.session.state),
    });
  }

  ensureMember(participantId, name) {
    let m = this.members.get(participantId);
    if (!m) {
      m = { name: name || 'Player ' + String(participantId).slice(0, 8), playerId: null, seen: new Set(), present: true };
      this.members.set(participantId, m);
    } else if (name) m.name = name;
    m.present = true;
    return m;
  }

  // Roster push: someone left the room. Keep their seat until the round ends.
  markAbsent(participantId) {
    const m = this.members.get(participantId);
    if (m) m.present = false;
  }

  handleGuestMessage(participantId, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'whoami') {
      this.send({ type: 'you-are', participantId });
      return;
    }
    if (msg.type === 'join-hall') {
      const m = this.ensureMember(participantId, msg.name);
      const live = this.session && !this.session.ended;
      const alreadySeated = !!m.playerId;
      // A joiner mid-round with a full hall spectates until the next round.
      if (!live || !this.humansSeated()) {
        this.startRound();
      } else if (!alreadySeated) {
        this.send({
          type: 'seated', stage: this.stage, state: serializeState(this.session.state),
          seats: this.seats(), you: participantId,
        });
      }
      this.broadcastSnapshot();
      return;
    }
    if (msg.type === 'cmd') {
      const m = this.ensureMember(participantId);
      if (!m.playerId) {
        this.send({ type: 'rejected', to: participantId, reason: 'spectating' });
        return;
      }
      this.handleCmd(participantId, m, msg.cmd);
    }
  }

  humansSeated() {
    if (!this.session) return false;
    return this.session.state.players.some(p =>
      p.id === 'you' || String(p.id).startsWith('ph-'));
  }

  handleCmd(participantId, member, cmd) {
    if (!cmd || (cmd.type !== 'mark' && cmd.type !== 'claim')) {
      this.send({ type: 'rejected', to: participantId, reason: 'unsupported-command' });
      return;
    }
    const stamped = { type: cmd.type, player: member.playerId };
    if (cmd.type === 'mark') {
      const cell = cmd.cell | 0;
      if (cell < 0 || cell >= 25) {
        this.send({ type: 'rejected', to: participantId, reason: 'cell-out-of-bounds' });
        return;
      }
      stamped.cell = cell;
    }
    if (cmd.id) {
      if (member.seen.has(cmd.id)) return; // idempotent duplicate
      member.seen.add(cmd.id);
    }
    if (!this.session || this.session.ended) {
      this.send({ type: 'rejected', to: participantId, reason: 'game-not-active' });
      return;
    }
    const r = this.dispatch(stamped);
    if (!r.ok) this.send({ type: 'rejected', to: participantId, reason: r.error });
  }

  // The ONLY state entry point: host's own commands and guests' alike.
  dispatch(cmd) {
    if (!this.session) return { ok: false, error: 'game-not-active' };
    const r = this.session.dispatch(cmd);
    if (r.events && r.events.length) this.onEvent(r.events, cmd);
    if (!r.error || r.events.length) this.broadcastSnapshot();
    if (this.session.ended) this.roundEnded();
    return r;
  }

  hostCall() {
    if (!this.session || this.session.ended) { this.clearInterval(this.callTimer); return; }
    const r = this.session.dispatch({ type: 'call' });
    if (r.events && r.events.length) this.onEvent(r.events, { type: 'call' });
    if (!r.ok) { this.clearInterval(this.callTimer); return; } // deck exhausted
    const state = this.session.state;
    const skill = this.stage.botSkill || 0.6;
    for (const p of state.players) {
      if (!p.id.startsWith('lantern-') || this.session.ended) continue;
      const notices = ((state.tick * 2654435761 + p.id.length * 97) % 1000) / 1000 < skill;
      if (notices) {
        const mark = legalActions(this.session.state, p.id).find(a => a.type === 'mark');
        if (mark) for (const cell of mark.cells) {
          if (this.session.ended) break;
          this.session.dispatch({ type: 'mark', player: p.id, cell });
        }
      }
      const me = this.session.state.players.find(pl => pl.id === p.id);
      if (me && !this.session.ended && patternComplete(me.marks, this.session.state.pattern)) {
        this.session.dispatch({ type: 'claim', player: p.id });
      }
    }
    this.broadcastSnapshot();
    if (this.session.ended) this.roundEnded();
  }

  roundEnded() {
    this.clearInterval(this.callTimer);
    this.callTimer = null;
    const winner = this.session ? this.session.state.winner : null;
    this.onRoundEnd(winner);
    this.restartTimer = this.setTimeout(() => {
      this.restartTimer = null;
      if (!this.session || this.session.ended) this.startRound();
    }, this.roundRestartMs);
  }

  stop() {
    this.clearInterval(this.callTimer);
    this.callTimer = null;
    if (this.restartTimer) { this.clearTimeout(this.restartTimer); this.restartTimer = null; }
  }
}

function defaultStageFor(day) { return dailyFor(day); }

export const _internals = { idBytes, bytesId };
