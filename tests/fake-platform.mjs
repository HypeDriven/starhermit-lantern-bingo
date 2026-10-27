// A stand-in for the StarHermit platform's script host and realtime rooms, for
// node tests: it runs server.js the way the platform does (a fresh context per
// invocation, every ctx and return value through JSON, the sender id attached
// by the host), binds a session to a room when the room starts, and gives each
// player native/platform.ts's roomsAdapter surface for js/hosted.js.
// (After hidden-council's tests/fake-platform.mjs.)
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8');
const SCRIPT = new vm.Script(SOURCE, { filename: 'server.js' });
export const json = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Calls one entry point of server.js in a fresh context, as the platform's sandbox does. */
export function invoke(entry, ctx) {
  const sandbox = {};
  vm.createContext(sandbox);
  SCRIPT.runInContext(sandbox);
  return json(sandbox.game[entry](json(ctx)));
}
/** The script's static declarations (read at publish time) and its boards. */
export function declarations() {
  const sandbox = {};
  vm.createContext(sandbox);
  SCRIPT.runInContext(sandbox);
  return json({ tickRateHz: sandbox.game.tickRateHz, BOARDS: sandbox.BOARDS });
}

/** One scripted session: its document, what the script returned, each player's inbox. */
export class ScriptSession {
  constructor({ players, room = null, now = 1_000_000, random = 0.3 }) {
    this.players = players;
    this.room = room;
    this.presence = room ? Object.fromEntries(players.map((p) => [p.id, { online: true, left: false }])) : null;
    this.now = now;
    this.random = random;
    this.state = null;
    this.result = null;
    this.scores = [];
    this.inbox = new Map();
    this.errors = new Map();
    this.listeners = new Set();
  }
  ctx(extra = {}) {
    const c = { now: this.now, random: this.random, sessionId: 'sess-1', players: this.players.map((p) => ({ elo: 1200, ...p })), sessionState: this.state, playerStates: {}, ...extra };
    if (this.room) { c.room = this.room; c.presence = this.presence; }
    return c;
  }
  apply(out, from = null) {
    if (!out || !out.ok) {
      if (from) { const l = this.errors.get(from) || []; l.push(out?.error || 'error'); this.errors.set(from, l); }
      for (const fn of this.listeners) fn({ error: out?.error || 'error', to: from ? [from] : [] });
      return out;
    }
    if (out.sessionState !== undefined) this.state = out.sessionState;
    if (out.scores) this.scores.push(out.scores);
    for (const b of out.broadcast || []) {
      const to = b.to === 'all' ? this.players.map((p) => p.id) : b.to;
      for (const id of to) { const l = this.inbox.get(id) || []; l.push(b.data); this.inbox.set(id, l); }
      for (const fn of this.listeners) fn({ data: b.data, to });
    }
    if (out.result && !this.result) this.result = out.result;
    return out;
  }
  create() { return this.apply(invoke('createSession', this.ctx())); }
  send(from, data) {
    if (this.result) return { ok: false, error: 'session finished' };
    return this.apply(invoke('onPlayerMessage', this.ctx({ message: { from, data } })), from);
  }
  tick(ms = 250) {
    this.now += ms;
    if (this.result) return { ok: true };
    return this.apply(invoke('onTick', this.ctx()));
  }
  last(userId, type = 'hall') {
    const l = (this.inbox.get(userId) || []).filter((d) => d.type === type);
    return l[l.length - 1] || null;
  }
}

/** Realtime rooms with server.js bound to a started room; `adapter(userId, name)` is roomsAdapter. */
export function fakePlatform() {
  const room = {
    id: 'room-1', participants: [], sockets: new Map(), games: new Map(), metadata: null, revision: 1,
    open: false, status: 'lobby', gameSessionId: null, session: null, result: null,
  };
  const view = () => json({
    id: room.id, status: room.status, gameSessionId: room.gameSessionId, revision: room.revision, metadata: room.metadata,
    participants: room.participants.map((p, i) => ({ id: p.id, userId: p.userId, username: p.username, displayName: p.username, isAi: false, isHost: i === 0, team: 0, slot: p.slot })),
  });
  const pushRoster = () => { for (const s of room.sockets.values()) { const r = view(); queueMicrotask(() => s.onRoster?.(r)); } };
  const res = (data) => ({ ok: true, status: 200, data: { roomId: room.id, revision: room.revision, metadata: json(room.metadata), joinCode: 'K7MP2X', gameSessionId: room.gameSessionId, ...data } });
  const start = () => {
    if (room.status === 'playing') return;
    room.status = 'playing';
    room.session = new ScriptSession({
      players: room.participants.map((p) => ({ id: p.userId, name: p.username })),
      room: { roomId: room.id, metadata: json(room.metadata), roster: room.participants.map((p) => ({ userId: p.userId, name: p.username, team: 0, slot: p.slot, ai: false })) },
    });
    room.session.listeners.add(({ data, to, error }) => {
      for (const [uid, h] of room.games) {
        if (!to.includes(uid)) continue;
        if (error) queueMicrotask(() => h.onError?.(error));
        else { const d = json(data); queueMicrotask(() => h.onMessage?.(d)); }
      }
    });
    const out = room.session.create();
    room.gameSessionId = out && out.ok ? 'sess-1' : null;
    pushRoster();
  };
  const watchResult = () => {
    if (room.session?.result && !room.result) { room.result = room.session.result; room.status = 'closed'; pushRoster(); }
  };
  const adapter = (userId, username) => ({
    userId,
    async createRoom(config) {
      room.metadata = json(config.metadata);
      room.participants.push({ id: `p-${userId}`, userId, username, slot: 0 });
      return res({});
    },
    async openRoom() { room.open = true; return res({}); },
    async updateRoom(roomId, changes, revision) {
      if (revision !== room.revision) return { ok: false, status: 409, error: 'conflict' };
      room.metadata = json(changes.metadata);
      room.revision += 1;
      return res({});
    },
    async quickJoin() {
      if (!room.open || room.status !== 'lobby' || room.participants.length >= 4) return { ok: false, status: 404, error: 'not-found' };
      room.participants.push({ id: `p-${userId}`, userId, username, slot: room.participants.length });
      pushRoster();
      return res({});
    },
    async startRoom() {
      if (room.participants[0]?.userId !== userId) return { ok: false, status: 403, error: 'forbidden' };
      start();
      return res({});
    },
    async leaveRoom() {
      if (room.status === 'lobby') room.participants = room.participants.filter((p) => p.userId !== userId);
      if (room.session?.presence?.[userId]) room.session.presence[userId].left = true;
      return res({});
    },
    connectRoom(roomId, h) {
      room.sockets.set(userId, h);
      queueMicrotask(() => h.onRoster?.(view()));
      return {
        sendEvent(kind, fields) {
          for (const [uid, s] of room.sockets) if (uid !== userId) { const f = json({ ...fields, game: kind }); queueMicrotask(() => s.onEvent?.(kind, f)); }
          return true;
        },
        close() { room.sockets.delete(userId); },
      };
    },
    connectGame(sessionId, h) {
      room.games.set(userId, h);
      queueMicrotask(() => h.onOpen?.());
      return {
        send(data) {
          const d = json(data);
          queueMicrotask(() => { room.session.send(userId, d); watchResult(); });
          return true;
        },
        close() { room.games.delete(userId); },
      };
    },
  });
  const tick = (ms) => { room.session?.tick(ms); watchResult(); };
  return { room, adapter, tick };
}

export const flush = () => new Promise((r) => setTimeout(r, 0));
