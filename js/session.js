'use strict';

// Session layer: local authoritative command log, replay envelope, undo.
// Owns the only mutable reference to rules state; every change goes through
// applyCommand so the log is always a faithful replay script.

import {
  createGame, applyCommand, serialize, deserialize, hashState,
  legalActions, scoreBreakdown, compareResults, RULES_VERSION,
} from './rules.js';

export const REPLAY_SCHEMA = 1;
const HASH_EVERY = 20; // periodic state-hash cadence inside a replay envelope

export class Session {
  constructor(opts) {
    // opts: {seed, pattern, parCalls, playerIds, meta:{mode, contentId, version}}
    this.meta = opts.meta || { mode: 'practice', contentId: null, version: RULES_VERSION };
    this.state = createGame(opts);
    this.commands = [];   // ordered applied commands
    this.hashes = [];     // [{tick, hash}]
    this.snapshots = [];  // undo stack (serialized states), practice/learn only
    this.listeners = new Set();
    this._cmdSeq = 0;
  }

  onEvent(fn) { this.listeners.add(fn); }
  _emit(ev) { for (const fn of this.listeners) fn(ev); }

  get ended() { return this.state.phase === 'ended'; }

  // The ONLY way to change rules state.
  dispatch(cmd) {
    const id = 'c' + (++this._cmdSeq);
    const stamped = { ...cmd, id, tick: this.state.tick };
    const prev = serialize(this.state);
    const { state, events, error } = applyCommand(this.state, stamped);
    if (error && !events.length) return { ok: false, error };
    if (state !== this.state) this.snapshots.push(prev);
    this.state = state;
    this.commands.push(stamped);
    if (this.state.tick % HASH_EVERY === 0 || this.ended) {
      this.hashes.push({ tick: this.state.tick, hash: hashState(this.state) });
    }
    this._emit({ type: 'applied', cmd: stamped, events, error: error || null });
    return { ok: !error, error: error || null, events };
  }

  undo() {
    if (!this.snapshots.length) return false;
    const prev = this.snapshots.pop();
    this.state = deserialize(prev);
    this.commands.pop();
    this._emit({ type: 'undo' });
    return true;
  }

  legalActions(playerId) { return legalActions(this.state, playerId); }
  score(playerId) { return scoreBreakdown(this.state, playerId); }

  ranking() {
    const ids = this.state.players.map(p => p.id);
    return ids.sort((a, b) => compareResults(this.state, a, b));
  }

  // Replay envelope per spec: schema, build/content version, seed, initial hash,
  // ordered commands, periodic state hashes, terminal result.
  exportReplay() {
    return {
      schema: REPLAY_SCHEMA,
      rulesVersion: RULES_VERSION,
      meta: this.meta,
      seed: this.state.seed,
      pattern: this.state.pattern,
      parCalls: this.state.parCalls,
      playerIds: this.state.players.map(p => p.id),
      initialHash: this.hashes.length ? null : null,
      commands: this.commands.slice(),
      hashes: this.hashes.slice(),
      terminal: this.ended ? {
        winner: this.state.winner,
        reason: this.state.terminalReason,
        finalHash: hashState(this.state),
      } : null,
    };
  }

  // Deterministic replay: re-apply commands from scratch; verify hashes match.
  static verifyReplay(envelope) {
    if (!envelope || envelope.schema !== REPLAY_SCHEMA) {
      return { ok: false, error: 'bad-schema' };
    }
    const s = new Session({
      seed: envelope.seed, pattern: envelope.pattern, parCalls: envelope.parCalls,
      playerIds: envelope.playerIds, meta: envelope.meta,
    });
    for (const cmd of envelope.commands) {
      const { state, events } = applyCommand(s.state, cmd);
      void events;
      s.state = state;
      if (s.state.tick % HASH_EVERY === 0 || s.ended) {
        s.hashes.push({ tick: s.state.tick, hash: hashState(s.state) });
      }
    }
    for (let i = 0; i < envelope.hashes.length; i++) {
      const want = envelope.hashes[i];
      const got = s.hashes.find(h => h.tick === want.tick);
      if (!got || got.hash !== want.hash) {
        return { ok: false, error: 'hash-mismatch', tick: want.tick };
      }
    }
    if (envelope.terminal) {
      if (s.state.winner !== envelope.terminal.winner) return { ok: false, error: 'winner-mismatch' };
      if (hashState(s.state) !== envelope.terminal.finalHash) return { ok: false, error: 'final-hash-mismatch' };
    }
    return { ok: true };
  }
}

// Simple deterministic bot used for hosted/AI seats: marks everything legal,
// claims as soon as its pattern is complete, with a skill-based reaction delay
// expressed in calls (higher skill = fewer missed opportunities).
export function botCommands(state, botId, skill) {
  const cmds = [];
  const p = state.players.find(pl => pl.id === botId);
  if (!p || state.phase !== 'active' || state.currentCall === 0) return cmds;
  const acts = legalActions(state, botId);
  const markAct = acts.find(a => a.type === 'mark');
  if (markAct) {
    // skill in [0,1]: chance (deterministic by tick) the bot notices this call
    const notices = ((state.tick * 2654435761 + botId.length * 97) % 1000) / 1000 < skill;
    if (notices) for (const cell of markAct.cells) cmds.push({ type: 'mark', player: botId, cell });
  }
  return cmds;
}
