'use strict';

// Lantern Bingo — pure deterministic rules engine.
// No rendering, no DOM, no Date/Math.random usage. Shared by client and server.

export const RULES_VERSION = 1;
export const GRID = 5;
export const CELLS = GRID * GRID;
export const BALLS = 75;
export const CENTER = 12; // index of the free center cell

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// Classic 75-ball card: column c holds 5 unique numbers from [c*15+1 .. c*15+15].
// Center cell is free, stored as value 0 and always marked.
export function generateCard(rng) {
  const card = new Array(CELLS);
  for (let c = 0; c < GRID; c++) {
    const col = [];
    for (let n = c * 15 + 1; n <= c * 15 + 15; n++) col.push(n);
    shuffle(col, rng);
    for (let r = 0; r < GRID; r++) card[r * GRID + c] = col[r];
  }
  card[CENTER] = 0;
  return card;
}

export const PATTERNS = {
  'any-line':  { name: 'Any Line',   desc: 'Complete any row, column, or diagonal.' },
  'two-lines': { name: 'Two Lines',  desc: 'Complete any two different lines.' },
  'diagonal':  { name: 'Diagonal',   desc: 'Complete either main diagonal.' },
  'corners':   { name: 'Four Corners', desc: 'Mark all four corners of the card.' },
  'frame':     { name: 'Lantern Frame', desc: 'Mark every cell on the outer edge.' },
  'x-shape':   { name: 'Crossed Light', desc: 'Complete both diagonals (an X).' },
  'full-house':{ name: 'Full Lantern', desc: 'Mark every cell on the card.' },
};

const LINE_SETS = (() => {
  const lines = [];
  for (let r = 0; r < GRID; r++) lines.push([0,1,2,3,4].map(c => r * GRID + c));
  for (let c = 0; c < GRID; c++) lines.push([0,1,2,3,4].map(r => r * GRID + c));
  lines.push([0,1,2,3,4].map(i => i * GRID + i));
  lines.push([0,1,2,3,4].map(i => (GRID - 1 - i) * GRID + i));
  return lines;
})();
const DIAG_MAIN = [0,1,2,3,4].map(i => i * GRID + i);
const DIAG_ANTI = [0,1,2,3,4].map(i => (GRID - 1 - i) * GRID + i);
const CORNERS = [0, GRID - 1, (GRID - 1) * GRID, CELLS - 1];
const FRAME = [];
for (let i = 0; i < CELLS; i++) {
  const r = Math.floor(i / GRID), c = i % GRID;
  if (r === 0 || r === GRID - 1 || c === 0 || c === GRID - 1) FRAME.push(i);
}

function allMarked(marks, cells) { for (const i of cells) if (!marks[i]) return false; return true; }

export function countLines(marks) {
  let n = 0;
  for (const line of LINE_SETS) if (allMarked(marks, line)) n++;
  return n;
}

export function patternComplete(marks, pattern) {
  switch (pattern) {
    case 'any-line': return countLines(marks) >= 1;
    case 'two-lines': return countLines(marks) >= 2;
    case 'diagonal': return allMarked(marks, DIAG_MAIN) || allMarked(marks, DIAG_ANTI);
    case 'corners': return allMarked(marks, CORNERS);
    case 'frame': return allMarked(marks, FRAME);
    case 'x-shape': return allMarked(marks, DIAG_MAIN) && allMarked(marks, DIAG_ANTI);
    case 'full-house': return allMarked(marks, Array.from({ length: CELLS }, (_, i) => i));
    default: return false;
  }
}

// --- Game state ---------------------------------------------------------------

// createGame({seed, pattern, playerIds, botSkill}) -> state
export function createGame(opts) {
  const seed = (opts.seed >>> 0);
  const rng = mulberry32(seed);
  const deck = shuffle(Array.from({ length: BALLS }, (_, i) => i + 1), mulberry32(seed ^ 0x9e3779b9));
  const ids = opts.playerIds && opts.playerIds.length ? opts.playerIds.slice() : ['p0'];
  const players = ids.map((id, i) => ({
    id,
    card: generateCard(rng),
    marks: (() => { const m = new Array(CELLS).fill(false); m[CENTER] = true; return m; })(),
    invalidMarks: 0,
    invalidClaims: 0,
    marksMade: 0,
    claimTick: -1,
  }));
  return {
    version: RULES_VERSION,
    seed,
    pattern: opts.pattern && PATTERNS[opts.pattern] ? opts.pattern : 'any-line',
    parCalls: typeof opts.parCalls === 'number' ? opts.parCalls : 0,
    tick: 0,
    phase: 'active', // active -> ended
    deck,
    callIndex: -1,
    currentCall: 0,
    players,
    winner: null,
    terminalReason: null,
  };
}

export function currentCalledSet(state) {
  const s = new Set();
  for (let i = 0; i <= state.callIndex; i++) s.add(state.deck[i]);
  return s;
}

// Legal-action query — the single source of truth used by play, hints and tutorials.
export function legalActions(state, playerId) {
  if (state.phase !== 'active') return [];
  const p = state.players.find(pl => pl.id === playerId);
  if (!p) return [];
  const actions = [];
  if (state.callIndex < BALLS - 1) actions.push({ type: 'call' });
  const called = currentCalledSet(state);
  const markable = [];
  for (let i = 0; i < CELLS; i++) {
    if (!p.marks[i] && p.card[i] !== 0 && called.has(p.card[i])) markable.push(i);
  }
  if (markable.length) actions.push({ type: 'mark', cells: markable });
  actions.push({ type: 'claim' }); // a claim may be attempted at any active tick; validated on resolution
  return actions;
}

export function cellValue(state, playerId, cell) {
  const p = state.players.find(pl => pl.id === playerId);
  return p ? p.card[cell] : 0;
}

// Scoring — integers only; breakdown for the results screen.
export function scoreBreakdown(state, playerId) {
  const p = state.players.find(pl => pl.id === playerId);
  if (!p) return null;
  const won = state.winner === playerId;
  const lines = countLines(p.marks);
  const patternBase = won ? 1000 : 0;
  const lineBonus = lines * 50;
  const marksScore = p.marksMade * 10;
  const callsUsed = state.callIndex + 1;
  const speedBonus = won && state.parCalls > 0 ? Math.max(0, (state.parCalls - callsUsed)) * 15 : 0;
  const invalidPenalty = (p.invalidMarks + p.invalidClaims) * 25;
  const total = patternBase + lineBonus + marksScore + speedBonus - invalidPenalty;
  return { patternBase, lineBonus, marksScore, speedBonus, invalidPenalty, total, won, lines, callsUsed };
}

// Tiebreak order: primary objective, fewer invalid actions, lower elapsed tick, stable id.
export function compareResults(state, aId, bId) {
  const a = state.players.find(p => p.id === aId);
  const b = state.players.find(p => p.id === bId);
  const aWon = state.winner === aId ? 1 : 0, bWon = state.winner === bId ? 1 : 0;
  if (aWon !== bWon) return bWon - aWon;
  const aInv = a.invalidMarks + a.invalidClaims, bInv = b.invalidMarks + b.invalidClaims;
  if (aInv !== bInv) return aInv - bInv;
  const aT = a.claimTick < 0 ? Number.MAX_SAFE_INTEGER : a.claimTick;
  const bT = b.claimTick < 0 ? Number.MAX_SAFE_INTEGER : b.claimTick;
  if (aT !== bT) return aT - bT;
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

function cloneState(s) {
  return {
    version: s.version, seed: s.seed, pattern: s.pattern, parCalls: s.parCalls,
    tick: s.tick, phase: s.phase, deck: s.deck.slice(), callIndex: s.callIndex,
    currentCall: s.currentCall,
    players: s.players.map(p => ({
      id: p.id, card: p.card.slice(), marks: p.marks.slice(),
      invalidMarks: p.invalidMarks, invalidClaims: p.invalidClaims,
      marksMade: p.marksMade, claimTick: p.claimTick,
    })),
    winner: s.winner, terminalReason: s.terminalReason,
  };
}

// applyCommand(state, cmd) -> {state, events:[{type,...}], error?}
// Commands: {type:'call'} {type:'mark',player,cell} {type:'claim',player} {type:'forfeit',player}
export function applyCommand(state, cmd) {
  if (!cmd || typeof cmd.type !== 'string') return { state, events: [], error: 'malformed-command' };
  if (state.phase !== 'active' && cmd.type !== 'forfeit') {
    return { state, events: [], error: 'game-not-active' };
  }
  const events = [];
  const next = cloneState(state);
  next.tick = state.tick + 1;

  if (cmd.type === 'call') {
    if (state.callIndex >= BALLS - 1) return { state, events: [], error: 'deck-exhausted' };
    next.callIndex++;
    next.currentCall = next.deck[next.callIndex];
    events.push({ type: 'call', value: next.currentCall, index: next.callIndex });
    if (next.callIndex >= BALLS - 1 && !next.winner) {
      // deck exhausted without winner is handled on next command attempt; stays active until claims resolve
    }
    return { state: next, events };
  }

  const p = next.players.find(pl => pl.id === cmd.player);
  if (!p) return { state, events: [], error: 'unknown-player' };

  if (cmd.type === 'mark') {
    const cell = cmd.cell | 0;
    if (cell < 0 || cell >= CELLS) return { state, events: [], error: 'cell-out-of-bounds' };
    if (p.marks[cell]) return { state, events: [], error: 'already-marked' };
    const called = currentCalledSet(state);
    if (p.card[cell] === 0 || !called.has(p.card[cell])) {
      p.invalidMarks++;
      events.push({ type: 'invalid-mark', player: p.id, cell });
      return { state: next, events, error: 'number-not-called' };
    }
    p.marks[cell] = true;
    p.marksMade++;
    events.push({ type: 'mark', player: p.id, cell, value: p.card[cell] });
    const newLines = countLines(p.marks);
    if (newLines > 0) events.push({ type: 'lines', player: p.id, count: newLines });
    return { state: next, events };
  }

  if (cmd.type === 'claim') {
    if (patternComplete(p.marks, state.pattern)) {
      if (!next.winner) {
        next.winner = p.id;
        next.phase = 'ended';
        next.terminalReason = 'pattern-claimed';
        p.claimTick = next.tick;
        events.push({ type: 'win', player: p.id, pattern: state.pattern });
      } else {
        events.push({ type: 'claim-too-late', player: p.id });
      }
      return { state: next, events };
    }
    p.invalidClaims++;
    events.push({ type: 'invalid-claim', player: p.id });
    return { state: next, events, error: 'pattern-incomplete' };
  }

  if (cmd.type === 'forfeit') {
    if (!next.winner) {
      next.winner = null;
      next.phase = 'ended';
      next.terminalReason = 'forfeit:' + p.id;
      events.push({ type: 'forfeit', player: p.id });
    }
    return { state: next, events };
  }

  return { state, events: [], error: 'unknown-command' };
}

// --- Serialization / hashing ---------------------------------------------------

export function serialize(state) {
  return JSON.stringify({
    v: state.version, seed: state.seed, pattern: state.pattern, parCalls: state.parCalls,
    tick: state.tick, phase: state.phase, deck: state.deck, callIndex: state.callIndex,
    players: state.players.map(p => ({
      id: p.id, card: p.card,
      marks: p.marks.reduce((acc, m, i) => (m ? (acc.push(i), acc) : acc), []),
      im: p.invalidMarks, ic: p.invalidClaims, mm: p.marksMade, ct: p.claimTick,
    })),
    winner: state.winner, terminalReason: state.terminalReason,
  });
}

export function deserialize(text) {
  const o = JSON.parse(text);
  if (o.v !== RULES_VERSION) throw new Error('unsupported state version');
  const state = createGame({ seed: o.seed, pattern: o.pattern, parCalls: o.parCalls, playerIds: o.players.map(p => p.id) });
  state.deck = o.deck.slice();
  state.callIndex = o.callIndex;
  state.currentCall = o.callIndex >= 0 ? o.deck[o.callIndex] : 0;
  state.tick = o.tick;
  state.phase = o.phase;
  state.winner = o.winner;
  state.terminalReason = o.terminalReason;
  o.players.forEach((sp, i) => {
    const p = state.players[i];
    p.marks = new Array(CELLS).fill(false);
    for (const idx of sp.marks) p.marks[idx] = true;
    p.invalidMarks = sp.im; p.invalidClaims = sp.ic; p.marksMade = sp.mm; p.claimTick = sp.ct;
  });
  return state;
}

// FNV-1a hash over the canonical serialized state — used for replay verification.
export function hashState(state) {
  const s = serialize(state);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
