'use strict';
// Hosted halls: a StarHermit realtime room for the lobby, the game's server
// script (server.js) for the round.
//
// Hosted Play quick-joins an open hall of this game (one team, four seats) or,
// when there is none, creates one and opens it for quick-join. The room's
// roster is the lobby; the host starts the round (empty seats play as bot
// lanterns) and the platform binds a session to the room, refereed by
// server.js: every client opens that session's game socket, sends its marks
// and claims ({ type: 'act', cmd }) and receives the hall's view
// ({ type: 'hall', you, seats, stage, state, over }: the cards, marks and
// numbers called so far). The script decides and records the result; a room
// that starts without a bound session is unavailable (never played without
// the referee).
//
// `platform` is the adapter native/platform.ts provides (and the node tests
// fake): { userId, createRoom, openRoom, quickJoin, startRoom, leaveRoom,
// connectRoom(roomId, handlers), connectGame(sessionId, handlers) }.

import { CENTER } from './rules.js';

export const HALL_SEATS = 4;

export class HallClient {
  constructor(platform, hooks, info) {
    this.platform = platform;
    this.hooks = hooks || {};
    this.roomId = info.roomId;
    this.isHost = !!info.host;
    this.players = [];        // lobby: [{ name, you, host }]
    this.sessionId = null;
    this.phase = 'lobby';     // lobby | starting | playing | over | closed
    this.state = null;        // the script's view of the round
    this.stage = null;
    this.you = null;          // our seat's player id
    this.seats = [];
    this.over = null;
    this.nextCallIn = null;
    this._room = null;
    this._game = null;
    if (info.gameSessionId) this._pending = info.gameSessionId;
  }

  _emit(name, ...args) { const fn = this.hooks[name]; if (fn) fn(...args); }

  /** Joins an open hall, else creates one and opens it; { ok, client } or { ok: false, error }. */
  static async open(platform, hooks) {
    const joined = await platform.quickJoin();
    if (joined.ok) {
      const room = joined.data;
      const client = new HallClient(platform, hooks, { roomId: room.roomId, host: false, gameSessionId: room.gameSessionId });
      client.connect();
      return { ok: true, client };
    }
    if (joined.status !== 404) return { ok: false, error: joined.error || 'rooms-unavailable' };
    const made = await platform.createRoom({ teamCount: 1, seatsPerTeam: HALL_SEATS, metadata: { mode: 'hall' } });
    if (!made.ok) return { ok: false, error: made.error || 'rooms-unavailable' };
    const client = new HallClient(platform, hooks, { roomId: made.data.roomId, host: true });
    const opened = await platform.openRoom(made.data.roomId);
    if (!opened.ok) { platform.leaveRoom(made.data.roomId).catch(() => {}); return { ok: false, error: opened.error || 'rooms-unavailable' }; }
    client.connect();
    return { ok: true, client };
  }

  connect() {
    if (this._room) return;
    this._room = this.platform.connectRoom(this.roomId, {
      onRoster: (room) => this._onRoster(room),
      onAuthLost: () => this._emit('onAuthLost'),
      onUnavailable: (code) => { if (!this.sessionId) this._close(code); },
    });
    if (this._pending) this._bind(this._pending);
  }

  _onRoster(room) {
    if (room.gameSessionId && !this.sessionId) this._bind(room.gameSessionId);
    else if (room.status === 'playing' && !room.gameSessionId && !this.sessionId) { this._close('no-session'); return; }
    else if (room.status === 'closed' && !this.sessionId) { this._close('closed'); return; }
    const me = this.platform.userId;
    this.players = [...room.participants].filter((p) => !p.isAi).sort((a, b) => a.slot - b.slot)
      .map((p) => ({ name: p.displayName || p.username || 'Player', you: !!me && p.userId === me, host: !!p.isHost }));
    const host = room.participants.find((p) => p.isHost);
    if (host && me) this.isHost = host.userId === me;
    this._emit('onLobby', this);
  }

  /** Host: start the round; the platform binds server.js's session to the room. */
  async start() {
    if (!this.isHost) return { ok: false, error: 'not-host' };
    if (this.phase !== 'lobby') return { ok: true };
    this.phase = 'starting';
    const res = await this.platform.startRoom(this.roomId);
    if (!res.ok) { this.phase = 'lobby'; return { ok: false, error: res.error || 'could-not-start' }; }
    if (!res.data.gameSessionId) { this._close('no-session'); return { ok: false, error: 'no-session' }; }
    this._bind(res.data.gameSessionId);
    return { ok: true };
  }

  _bind(sessionId) {
    if (this._game) return;
    this.sessionId = sessionId;
    this.phase = 'playing';
    this._game = this.platform.connectGame(sessionId, {
      onOpen: () => this._game && this._game.send({ type: 'sync' }),
      onMessage: (data) => this._onGame(data),
      onError: (message) => this._emit('onReject', String(message || 'rejected'), null),
      onAuthLost: () => this._emit('onAuthLost'),
      onUnavailable: (code) => { if (!this.over) this._close(code); },
    });
  }

  _onGame(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'rejected') { this._emit('onReject', String(msg.reason || 'rejected'), typeof msg.cell === 'number' ? msg.cell : null); return; }
    if (msg.type !== 'hall' || !msg.state || !Array.isArray(msg.state.players)) return;
    const first = !this.state;
    const prev = this.state;
    this.state = msg.state;
    this.you = msg.you;
    this.seats = Array.isArray(msg.seats) ? msg.seats : [];
    this.stage = msg.stage || this.stage;
    this.nextCallIn = typeof msg.nextCallIn === 'number' ? msg.nextCallIn : null;
    if (first) this._emit('onStart', this);
    this._emit('onState', this.state, prev);
    if (msg.over && !this.over) {
      this.over = msg.over;
      this.phase = 'over';
      this._emit('onOver', this.over);
    }
  }

  /** Our mark (the centre is free and never sent). */
  mark(cell) {
    if (cell === CENTER) return { ok: false, reason: 'free' };
    return this._send({ type: 'mark', cell });
  }
  claim() { return this._send({ type: 'claim' }); }

  _send(cmd) {
    if (!this._game || !this.state || this.over) return { ok: false, reason: 'game-not-active' };
    if (!this._game.send({ type: 'act', cmd })) return { ok: false, reason: 'not-connected' };
    return { ok: true };
  }

  /** A seat's display name ('lantern-N' for the bots). */
  nameOf(playerId) {
    const s = this.seats.find((x) => x.playerId === playerId);
    return s ? s.name : playerId;
  }

  _close(code) {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this._shut();
    this._emit('onUnavailable', code);
  }

  _shut() {
    try { this._game?.close(); } catch { /* gone */ }
    try { this._room?.close(); } catch { /* gone */ }
    this._game = null;
    this._room = null;
  }

  /** Leaves the room (a seat in play just stops marking). */
  leave() {
    const wasOpen = this.phase !== 'closed';
    this.phase = 'closed';
    this._shut();
    if (wasOpen || this.roomId) this.platform.leaveRoom(this.roomId).catch(() => {});
  }
}
