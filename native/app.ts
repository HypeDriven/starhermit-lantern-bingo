// What the browser build's js/game.js did around the rules, without the DOM:
// the screen flow (title → setup → countdown → play ⇄ pause → results →
// retry / next stage / title; Journey and Learn lists, the Practice and
// Challenge pickers, Settings and Help, which return to the pause dialog
// when opened from it), the caller (auto calls at the chosen speed, or
// manual), the bot lanterns (each reacts to a call after a skill-scaled
// delay, marks what it noticed and claims a complete pattern), marks,
// claims, hints and undo, the Learn lessons' steps, results with the score
// breakdown, ranking, achievements and the next recommendation, progress and
// best scores, posting a finished solo round to the leaderboard through
// server.js, Copy Replay, and Hosted Play (js/hosted.js: a realtime room as
// the lobby, server.js as the caller and referee).
//
// Time is the round clock, advanced by the runtime's fixed steps (60 a
// second) while a round is neither paused nor hidden: the countdown beats,
// the auto calls, the bots' reactions and the short beat before results run
// on it, so play scripts replay exactly. (The browser build's setTimeouts
// kept running while paused and re-armed on resume; here a pause freezes
// them.)
import { clipboard, frame } from "starhermit:engine";
import { requestSignIn } from "starhermit:platform";
import * as ui from "starhermit:ui";
import { CELLS, CENTER, GRID, PATTERNS, countLines, hashState, legalActions, patternComplete, scoreBreakdown, compareResults } from "../js/rules.js";
import { Session } from "../js/session.js";
import { CHALLENGES, CONTENT_VERSION, JOURNEY_STAGES, LESSONS, dailyFor } from "../js/content.js";
import { HallClient } from "../js/hosted.js";
import * as audio from "./audio.ts";
import { N, T, shT } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";

// -- the shapes this client reads ------------------------------------------------------------
export interface Player { id: string; card: number[]; marks: boolean[]; invalidMarks: number; invalidClaims: number; marksMade: number; claimTick: number }
export interface State {
  seed: number; pattern: string; parCalls: number; tick: number; phase: string; deck: number[]; callIndex: number; currentCall: number;
  players: Player[]; winner: string | null; terminalReason: string | null;
}
export interface Score { patternBase: number; lineBonus: number; marksScore: number; speedBonus: number; invalidPenalty: number; total: number; won: boolean; lines: number; callsUsed: number }
export interface Stage {
  id: string; title?: string; seed: number; pattern: string; bots: number; botSkill: number; parCalls: number; theme?: string; ranked?: boolean;
  expectedMinutes?: number; version?: number; index?: number; mastery?: boolean; day?: string; todaysBest?: number | null; difficulty?: string;
  constraint?: string;
}
interface Lesson { id: string; title: string; pattern: string; seed: number; steps: { text: string; waitFor: string }[] }
interface RulesEvent { type: string; player?: string; cell?: number; value?: number; count?: number }
interface Applied { type: string; events?: RulesEvent[] }
/** A local Session, or the hosted hall's view in the same shape. */
export interface Sess {
  state: State; readonly ended: boolean;
  legalActions(id: string): { type: string; cells?: number[] }[];
  score(id: string): Score; ranking(): string[];
  dispatch?(cmd: Record<string, unknown>): { ok: boolean; error: string | null; events: RulesEvent[] };
  undo?(): boolean; exportReplay?(): unknown; onEvent?(fn: (ev: Applied) => void): void;
}
export type Mode = "learn" | "journey" | "daily" | "practice" | "challenge" | "hosted";
export type Screen = "title" | "setup" | "journey" | "learn" | "play" | "results" | "settings" | "help" | "hall";
export type Phase = "boot" | "title" | "preparing" | "countdown" | "active" | "paused" | "resolving" | "results";
export type Modal = null | "pause" | "practice" | "challenge" | "reset";
type Text = { key: string | (() => string); vars?: Record<string, string | number> } | null;

export const ACHIEVEMENTS: Record<string, { name: string; desc: string }> = {
  first_win: { name: N("First Light"), desc: N("Win your first round.") },
  line_master: { name: N("Line Keeper"), desc: N("Complete 50 lines across all rounds.") },
  streak_3: { name: N("Steady Flame"), desc: N("Win 3 rounds in a row.") },
  full_lantern: { name: N("Full Lantern"), desc: N("Win a Full Lantern (blackout) round.") },
  long_road: { name: N("Long Road"), desc: N("Complete every Journey stage.") },
};
const PHASE_TEXT: Record<Phase, string> = {
  boot: N("Loading…"), title: N("Main menu"), preparing: N("Preparing the round…"), countdown: N("Get ready…"),
  active: N("Round active"), paused: N("Paused"), resolving: N("Round over"), results: N("Results"),
};
export const PRACTICE_LABELS: Record<string, string> = { easy: N("Easy"), normal: N("Normal"), hard: N("Hard") };

export const app = {
  screen: "title" as Screen,
  phase: "boot" as Phase,
  openedFrame: 0,
  focusNext: null as string | null,
  modal: null as Modal,
  modalOpened: 0,
  status: null as Text,
  caption: "",
  hint: null as Text,
  mode: null as Mode | null,
  stage: null as Stage | null,
  session: null as Sess | null,
  lesson: null as { def: Lesson; step: number } | null,
  countdown: null as string | null,
  callAuto: 0,
  pendingSetup: null as { mode: Mode; stage: Stage } | null,
  results: null as null | { hosted: boolean; unlocked: { name: string }[]; winner: string | null; recommendation: string },
  lb: null as null | "posting" | platform.Posted,
  settingsReturnPause: false,
  helpReturnPause: false,
  hall: null as HallClient | null,
  hallError: null as string | null,
  toast: null as { text: string; until: number } | null,
  focusCell: CENTER,
};
const achievementCtx = { linesTotal: 0, winStreak: 0 };

// -- text, toast, announcements ------------------------------------------------------------------
export function textOf(t: Text): string {
  if (!t) return "";
  return typeof t.key === "function" ? t.key() : T(t.key, t.vars);
}
export function setStatus(key: string | (() => string), vars?: Record<string, string | number>): void { app.status = { key, vars }; }
export function setHint(key: string | null, vars?: Record<string, string | number>): void { app.hint = key ? { key, vars } : null; }
export function announce(key: string, vars?: Record<string, string | number>, assertive = true): void {
  const text = T(key, vars);
  if (text) ui.announce(text.slice(0, 500), { politeness: assertive ? "assertive" : "polite" });
}
export function toast(text: string, ms = 3200): void { app.toast = { text, until: frame().time + ms / 1000 }; }
function setPhase(p: Phase): void {
  app.phase = p;
  setStatus(PHASE_TEXT[p] || p);
}
audio.onCaption((text) => { app.caption = text; });
export function cue(c: audio.Cue): void { audio.cue(c); }

// -- the round clock -----------------------------------------------------------------------------
export const clock = { ms: 0 };
const timers: { at: number; fn: () => void }[] = [];
function after(ms: number, fn: () => void): void { timers.push({ at: clock.ms + ms, fn }); }
function clearTimers(): void { timers.length = 0; }
/** One fixed step: the clock runs unless a local round is paused (hosted rounds run on the server). */
export function step(dtMs: number): void {
  if (app.phase === "paused" && app.mode !== "hosted") return;
  clock.ms += dtMs;
  for (;;) {
    let i = -1;
    for (let k = 0; k < timers.length; k++) if (timers[k]!.at <= clock.ms && (i < 0 || timers[k]!.at < timers[i]!.at)) i = k;
    if (i < 0) break;
    const t = timers.splice(i, 1)[0]!;
    t.fn();
  }
}

// -- navigation ----------------------------------------------------------------------------------
export function show(screen: Screen, focus: string | null = null): void {
  app.screen = screen;
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  ui.setFocus(null);
  render.setActive(screen === "play");
}
export function openModal(m: Modal, focus: string | null = null): void {
  app.modal = m;
  app.modalOpened = frame().frame;
  app.focusNext = focus;
  ui.setFocus(null);
}
export function closeModal(): void { app.modal = null; app.modalOpened = frame().frame; ui.setFocus(null); }
export function fresh(): boolean { const f = frame().frame; return f !== app.openedFrame && f !== app.modalOpened; }

export function goTitle(): void {
  abandonIfPlaying();
  show("title", "btn-play");
  if (app.phase !== "title") setPhase("title");
}
export function nav(to: string): void {
  cue("ui");
  switch (to) {
    case "title": goTitle(); break;
    case "play-quick": openSetup("practice", practiceStage("normal")); break;
    case "journey": show("journey", "stage-0"); break;
    case "learn": show("learn", "lesson-0"); break;
    case "daily": openDaily(); break;
    case "practice": openModal("practice", "btn-practice-normal"); break;
    case "challenge": openModal("challenge", "btn-challenge-0"); break;
    case "hosted": startHosted(); break;
    case "settings": openSettings(false); break;
    case "help": app.helpReturnPause = false; show("help", "btn-help-back"); break;
  }
}
function abandonIfPlaying(): void {
  if (app.session && !app.session.ended && (app.phase === "active" || app.phase === "paused" || app.phase === "countdown")) abandonRound();
}

// -- setup -----------------------------------------------------------------------------------------
export const patternName = (id: string): string => T((PATTERNS as Record<string, { name: string }>)[id]!.name);
export const patternDesc = (id: string): string => T((PATTERNS as Record<string, { desc: string }>)[id]!.desc);
export function stageTitle(stage: Stage | null): string {
  if (!stage) return "";
  if (stage.id && stage.id.startsWith("journey-")) return stage.mastery ? T("Mastery {n}", { n: stage.index! }) : T("Stage {n}", { n: stage.index! });
  if (stage.day) {
    const base = T("Daily Lantern — {date}", { date: stage.day });
    return stage.todaysBest != null ? base + " " + T("(today's best: {score})", { score: stage.todaysBest }) : base;
  }
  if (stage.difficulty) return T("Practice ({difficulty})", { difficulty: T(PRACTICE_LABELS[stage.difficulty] ?? stage.difficulty) });
  return T(stage.title || stage.id);
}
export function openSetup(mode: Mode, stage: Stage): void {
  app.pendingSetup = { mode, stage };
  show("setup", "btn-start");
}
export function practiceStage(difficulty: string): Stage {
  const map: Record<string, { pattern: string; bots: number; botSkill: number; parCalls: number }> = {
    easy: { pattern: "any-line", bots: 1, botSkill: 0.4, parCalls: 42 },
    normal: { pattern: "two-lines", bots: 2, botSkill: 0.6, parCalls: 58 },
    hard: { pattern: "frame", bots: 3, botSkill: 0.8, parCalls: 70 },
  };
  const m = map[difficulty]!;
  return {
    id: "practice-" + difficulty + "-" + Math.floor(platform.nowMs()), title: "Practice (" + difficulty + ")", difficulty,
    seed: Math.floor(Math.random() * 2 ** 31) >>> 0, version: CONTENT_VERSION,
    pattern: m.pattern, bots: m.bots, botSkill: m.botSkill, parCalls: m.parCalls,
    ranked: false, expectedMinutes: 4, theme: platform.options.theme,
  };
}
export function openDaily(): void {
  // Seeded by the platform's UTC day: the same for everyone that day.
  const day = platform.todayIso();
  const stage = dailyFor(day) as Stage;
  const played = platform.progress().dailyHistory[day];
  openSetup("daily", { ...stage, todaysBest: played != null ? played : null });
}
export function journeyUnlockedUpTo(): number {
  const done = new Set(platform.progress().journeyDone);
  const first = (JOURNEY_STAGES as Stage[]).findIndex((s) => !done.has(s.id));
  return first === -1 ? JOURNEY_STAGES.length : first + 1;
}

// -- rounds ----------------------------------------------------------------------------------------
function playerIdsFor(stage: Stage): string[] {
  const ids = ["you"];
  for (let i = 0; i < (stage.bots || 0); i++) ids.push("lantern-" + (i + 1));
  return ids;
}
export function startRound(mode: Mode, stage: Stage): void {
  leaveHosted();
  clearTimers();
  app.mode = mode;
  app.stage = stage;
  app.settingsReturnPause = false;
  app.helpReturnPause = false;
  app.results = null;
  app.lb = null;
  app.modal = null;
  if (mode !== "learn") app.lesson = null;
  setPhase("preparing");
  const session = new Session({
    seed: stage.seed >>> 0, pattern: stage.pattern, parCalls: stage.parCalls,
    playerIds: playerIdsFor(stage), meta: { mode, contentId: stage.id, version: stage.version || CONTENT_VERSION },
  }) as unknown as Sess;
  app.session = session;
  session.onEvent!((ev) => onSessionEvent(ev));
  app.focusCell = CENTER;
  setHint(null);
  app.callAuto = 0;
  render.startRound(stage.theme || platform.options.theme);
  render.showCall(0);
  syncHall();
  show("play", null);
  countdown(() => {
    setPhase("active");
    setStatus(() => T("Round active — {pattern}", { pattern: patternName(stage.pattern) }));
    scheduleNextCall();
  });
}
function countdown(done: () => void): void {
  const session = app.session;
  setPhase("countdown");
  const seq = ["3", "2", "1", N("Go")];
  let i = 0;
  const beat = (): void => {
    if (app.session !== session) { app.countdown = null; return; }
    if (i >= seq.length) { app.countdown = null; done(); return; }
    app.countdown = seq[i]!;
    announce(seq[i]!);
    cue(i === seq.length - 1 ? "go" : "tick");
    i++;
    after(ui.preferences().reducedMotion ? 500 : 750, beat);
  };
  beat();
}
export function meId(): string { return app.mode === "hosted" && app.hall ? app.hall.you || "" : "you"; }
export function mePlayer(state: State): Player { return state.players.find((p) => p.id === meId()) || state.players[0]!; }
export function inRound(): boolean { return !!app.session && app.screen === "play"; }
export function canAct(): boolean { return inRound() && app.phase === "active" && !app.modal; }

function scheduleNextCall(): void {
  if (app.mode === "hosted") return;
  const speed = Number(platform.options.callSpeed);
  app.callAuto = speed > 0 ? speed : 0;
  if (speed <= 0 || app.phase !== "active") return;
  const session = app.session;
  const t = { at: clock.ms + speed, fn: (): void => { if (app.session === session && callTimer === t) doCall(); } };
  callTimer = t;
  timers.push(t);
}
let callTimer: { at: number; fn: () => void } | null = null;
/** The Call button and key (and the caller's timer). */
export function doCall(): void {
  const s = app.session;
  if (!s || s.ended || app.phase !== "active" || app.mode === "hosted") return;
  const r = s.dispatch!({ type: "call" });
  if (!r.ok) { setStatus(r.error === "deck-exhausted" ? N("No numbers left in the deck.") : errorText(r.error)); return; }
  cue("call");
  const v = s.state.currentCall;
  render.showCall(v);
  announce("Called {n}", { n: v });
  scheduleBots();
  scheduleNextCall();
  syncHall();
}
const lastMark = { cell: -1, tick: -1, at: -1e9 };
/** A card cell pressed (the grid button, Enter or Space on it, or its 3D tile). */
export function markCell(cell: number): void {
  if (!canAct() || !app.session) return;
  if (cell === CENTER) return; // the free cell is pre-marked; selecting it is never a penalty
  if (app.mode === "hosted") { hostedMark(cell); return; }
  const s = app.session;
  // A short dedupe (the browser build's pendingAck): the same cell on the same tick within 400 ms.
  if (lastMark.cell === cell && lastMark.tick === s.state.tick && clock.ms - lastMark.at < 400) return;
  Object.assign(lastMark, { cell, tick: s.state.tick, at: clock.ms });
  const r = s.dispatch!({ type: "mark", player: "you", cell });
  if (!r.ok) {
    cue("invalid");
    const [key, vars] = markError(r.error, s.state.players[0]!.card[cell]!);
    setHint(key, vars);
    announce(key, vars);
  } else {
    cue("mark");
    setHint(null);
  }
  syncHall();
}
export function claim(): void {
  if (!canAct() || !app.session) return;
  if (app.mode === "hosted") { app.hall?.claim(); return; }
  const s = app.session;
  if (s.ended) return;
  const r = s.dispatch!({ type: "claim", player: "you" });
  if (!r.ok) {
    cue("invalid");
    setHint(N("Pattern not complete yet — false claim −25."));
    announce("Pattern not complete yet — false claim −25.");
  }
  syncHall();
}
export function undo(): void {
  const s = app.session;
  if (!canAct() || !s || !undoShown() || !s.undo) return;
  if (s.undo()) { cue("ui"); syncHall(); }
}
export const undoShown = (): boolean => app.mode === "practice" || app.mode === "learn";
export function hint(): void {
  const s = app.session;
  if (!s || !inRound()) return;
  const acts = s.legalActions(meId());
  const mark = acts.find((a) => a.type === "mark");
  const me = mePlayer(s.state);
  const [key, vars]: [string, Record<string, string | number> | undefined] = mark ? [N("Callable now: {list}."), { list: mark.cells!.map((i) => me.card[i]).join(", ") }]
    : patternComplete(me.marks, s.state.pattern) ? [N("Pattern complete — press Claim!"), undefined]
      : [N("Nothing callable yet. Wait for the next call."), undefined];
  setHint(key, vars);
  announce(key, vars);
  cue("ui");
}
export function claimReady(): boolean {
  const s = app.session;
  if (!s) return false;
  const me = mePlayer(s.state);
  return s.state.phase === "active" && patternComplete(me.marks, s.state.pattern);
}
/** Markable cells of the local seat (the auto-hint pulse and the labels). */
export function markable(): Set<number> {
  const s = app.session;
  if (!s) return new Set();
  const m = s.legalActions(meId()).find((a) => a.type === "mark");
  return new Set(m ? m.cells : []);
}
export function resetCamera(): void { render.resetCamera(); }

// Rule refusal codes (rules.js / server.js) → player-facing text.
const ERROR_TEXT: Record<string, string> = {
  "already-marked": N("Already marked."), "pattern-incomplete": N("Pattern not complete yet — false claim −25."),
  "game-not-active": N("The round is not active."), "cell-out-of-bounds": N("That cell is not on the card."),
  spectating: N("Spectating — you will be seated for the next round."), "unsupported-command": N("That action is not available here."),
  "unknown-player": N("You are not seated in this round."), "malformed-command": N("That action is not available here."),
  "unknown-command": N("That action is not available here."), "deck-exhausted": N("No numbers left in the deck."),
};
export function errorText(code: string | null): string { return code ? ERROR_TEXT[code] || code : ""; }
function markError(code: string | null, number: number | string): [string, Record<string, string | number> | undefined] {
  if (code === "number-not-called") return [N("Number {n} has not been called yet."), { n: number }];
  return [errorText(code), undefined];
}

function scheduleBots(): void {
  // Bots react to the latest call; reaction time scales with skill but their
  // commands are logged like any other, keeping replays verifiable.
  const s = app.session;
  if (!s || app.mode === "hosted") return;
  const state = s.state;
  for (const p of state.players) {
    if (!p.id.startsWith("lantern-")) continue;
    const skill = app.stage!.botSkill || 0.6;
    const delay = 600 + (1 - skill) * 4000 + ((state.tick * 7919 + p.id.length * 131) % 700);
    after(delay, () => {
      if (app.session !== s || s.ended) return;
      const st = s.state;
      if (!st.players.find((pl) => pl.id === p.id)) return;
      const mark = s.legalActions(p.id).find((a) => a.type === "mark");
      const notices = ((st.tick * 2654435761 + p.id.length * 97) % 1000) / 1000 < skill;
      if (mark && notices) {
        for (const cell of mark.cells!) {
          if (s.ended) break;
          s.dispatch!({ type: "mark", player: p.id, cell });
        }
      }
      const me2 = s.state.players.find((pl) => pl.id === p.id)!;
      if (!s.ended && patternComplete(me2.marks, s.state.pattern)) s.dispatch!({ type: "claim", player: p.id });
      syncHall();
    });
  }
}
function onSessionEvent(ev: Applied): void {
  if (ev.type !== "applied") return;
  for (const e of ev.events || []) {
    if (e.type === "lines" && e.player === "you") cue("line");
    if (e.type === "invalid-claim" && e.player !== "you") setStatus("{name} made a false claim.", { name: e.player! });
    if (e.type === "win") endRound(e.player!);
  }
  if (app.lesson) lessonOnEvent(ev);
}
function endRound(winnerId: string): void {
  const s = app.session!;
  callTimer = null;
  clearTimers();
  setPhase("resolving");
  const won = winnerId === "you";
  cue(won ? "win" : "lose");
  const me = s.state.players[0]!;
  achievementCtx.linesTotal += countLines(me.marks);
  const unlocked: { name: string }[] = [];
  const push = (k: string): void => { const a = unlock(k); if (a) unlocked.push(a); };
  if (won) {
    push("first_win");
    achievementCtx.winStreak++;
    if (achievementCtx.winStreak >= 3) push("streak_3");
    if (app.stage!.pattern === "full-house") push("full_lantern");
  } else achievementCtx.winStreak = 0;
  if (achievementCtx.linesTotal >= 50) push("line_master");
  const prog = platform.progress();
  prog.gamesPlayed++;
  const score = s.score("you");
  const key = app.stage!.id;
  if (prog.bestScores[key] == null || score.total > prog.bestScores[key]!) prog.bestScores[key] = score.total;
  if (app.mode === "journey" && won && !prog.journeyDone.includes(app.stage!.id)) {
    prog.journeyDone.push(app.stage!.id);
    if (prog.journeyDone.length >= JOURNEY_STAGES.length) push("long_road");
  }
  if (app.mode === "daily" && app.stage!.day) prog.dailyHistory[app.stage!.day] = score.total;
  platform.saveDoc();
  after(won ? 900 : 1200, () => { if (app.session === s) showResults(unlocked); });
}
function unlock(key: string): { name: string } | null {
  const p = platform.progress();
  if (p.achievements[key]) return null;
  p.achievements[key] = new Date(platform.nowMs()).toISOString();
  platform.saveDoc();
  return ACHIEVEMENTS[key] ?? null;
}
function showResults(unlocked: { name: string }[]): void {
  setPhase("results");
  const won = app.session!.state.winner === "you";
  app.results = { hosted: false, unlocked, winner: app.session!.state.winner, recommendation: nextRecommendation() };
  if (unlocked.length) after(450, () => cue("achievement"));
  show("results", "btn-retry");
  announce(won ? N("You won the round") : N("Round over"));
  postToLeaderboard(app.mode === "learn" ? null : Math.max(0, app.session!.score("you").total));
}
/** Signed in only: a finished solo round (every mode but Learn) goes to the `high-score` board. */
function postToLeaderboard(total: number | null): void {
  app.lb = null;
  if (total == null || !platform.signedIn()) return;
  app.lb = "posting";
  const results = app.results;
  void platform.postScore(total).then((p) => { if (app.results === results) app.lb = p; });
}
export function leaderboardLine(): string | null {
  const lb = app.lb;
  if (!lb) return null;
  const sh = shT();
  if (lb === "posting") return sh.lbPosting;
  if (!lb.posted) return sh.lbNotPosted;
  return lb.rank ? sh.lbRank.replace("{rank}", String(lb.rank)) : sh.lbPosted;
}
function nextRecommendation(): string {
  const prog = platform.progress();
  if (app.mode === "learn") return N("Journey stage 1 puts your new skill to the test.");
  if (app.mode === "journey" && prog.journeyDone.length < JOURNEY_STAGES.length) return N("Continue the Journey — the next stage is unlocked.");
  if (prog.dailyHistory[platform.todayIso()] == null) return N("Try today's Daily Lantern — one shared seed for everyone.");
  return N("Practice a harder pattern, or take on a Challenge.");
}
export function reasonText(reason: string | null): string {
  if (!reason) return "—";
  if (reason === "pattern-claimed") return T("pattern claimed");
  if (reason === "deck-exhausted") return T("No numbers left in the deck.");
  if (reason === "abandoned") return T("Round ended.");
  if (reason.startsWith("forfeit:")) return T("{name} forfeited", { name: seatName(reason.slice(8)) });
  return reason;
}
export function retry(): void { cue("ui"); if (app.mode && app.stage && app.mode !== "hosted") startRound(app.mode, app.stage); }
export function resultsNext(): void {
  cue("ui");
  if (app.mode === "journey") {
    const idx = (JOURNEY_STAGES as Stage[]).findIndex((s) => s.id === app.stage!.id);
    const next = (JOURNEY_STAGES as Stage[])[idx + 1];
    if (next && app.session && app.session.state.winner === "you") { openSetup("journey", next); return; }
    show("journey", "stage-0");
    return;
  }
  if (app.mode === "hosted") leaveHosted();
  goTitle();
}
export function copyReplay(): void {
  cue("ui");
  const s = app.session;
  if (!s || !s.exportReplay) return;
  const replay = JSON.stringify(s.exportReplay(), null, 2);
  try { clipboard.writeText(replay); setStatus(N("Replay copied to clipboard.")); }
  catch { toast(T("Copy replay:") + " " + T("Seed {seed}", { seed: s.state.seed })); }
}
export function nextLabel(): string {
  return app.mode === "journey" && app.session?.state.winner === "you" && app.results && !app.results.hosted ? T("Next stage") : T("Continue");
}

// -- learn -------------------------------------------------------------------------------------------
export function startLesson(lesson: Lesson): void {
  cue("ui");
  app.lesson = { def: lesson, step: 0 };
  const stage: Stage = { id: lesson.id, title: lesson.title, seed: lesson.seed, pattern: lesson.pattern, bots: 0, botSkill: 0, parCalls: 0, ranked: false, expectedMinutes: 2, theme: "ember" };
  startRound("learn", stage);
  lessonPrompt();
}
function lessonPrompt(): void {
  const l = app.lesson;
  if (!l) return;
  const step = l.def.steps[l.step];
  if (!step) return;
  setHint(step.text);
  announce(step.text);
  setStatus(() => T("Lesson {step}/{count}: {title}", { step: l.step + 1, count: l.def.steps.length, title: T(l.def.title) }));
}
function lessonOnEvent(ev: Applied): void {
  const l = app.lesson;
  if (!l) return;
  const step = l.def.steps[l.step];
  if (!step) return;
  const hit = (ev.events || []).some((e) =>
    (step.waitFor === "call" && e.type === "call") ||
    (step.waitFor === "mark" && e.type === "mark" && e.player === "you") ||
    (step.waitFor === "claim" && e.type === "win" && e.player === "you") ||
    (step.waitFor === "auto-line" && e.type === "lines" && e.player === "you"));
  if (!hit) return;
  l.step++;
  if (l.step >= l.def.steps.length) {
    const prog = platform.progress();
    if (!prog.lessonsDone.includes(l.def.id)) { prog.lessonsDone.push(l.def.id); platform.saveDoc(); }
    if (!app.session!.ended) {
      setStatus(N("Lesson complete! Finish the round or leave when ready."));
      announce("Lesson complete");
    }
    app.lesson = null;
  } else lessonPrompt();
}

// -- pause -------------------------------------------------------------------------------------------
export function pauseGame(): void {
  if (app.phase !== "active" && app.phase !== "countdown") return;
  if (app.screen !== "play" || app.modal) return;
  pausedFrom = app.phase;
  setPhase("paused");
  openModal("pause", "btn-resume");
}
let pausedFrom: Phase = "active";
export function resumeGame(): void {
  closeModal();
  if (!app.session || app.session.ended) { setPhase("active"); return; }
  if (pausedFrom === "countdown" && app.countdown) { setPhase("countdown"); return; }
  setPhase("active");
  if (app.mode === "hosted") setStatus(() => T("Round active — {pattern}", { pattern: patternName(app.session!.state.pattern) }));
}
export function abandonRound(): void {
  clearTimers();
  callTimer = null;
  closeModal();
  app.settingsReturnPause = false;
  app.helpReturnPause = false;
  leaveHosted();
  app.session = null;
  app.lesson = null;
  app.countdown = null;
  setPhase("title");
  show("title", "btn-play");
}
/** A hidden window pauses a local round (the browser build's visibilitychange). */
export function onSuspend(): void {
  if ((app.phase === "active" || app.phase === "countdown") && app.mode !== "hosted" && app.screen === "play" && !app.modal) pauseGame();
}
export function openSettings(fromPause: boolean): void {
  app.settingsReturnPause = fromPause;
  if (fromPause) closeModal();
  show("settings", "set-theme");
}
export function openHelp(fromPause: boolean): void {
  app.helpReturnPause = fromPause;
  if (fromPause) closeModal();
  show("help", "btn-help-back");
}
/** Settings' Done / Help's Back: back to the pause dialog when opened from it. */
export function backFromSub(which: "settings" | "help"): void {
  cue("ui");
  const ret = which === "settings" ? app.settingsReturnPause : app.helpReturnPause;
  if (ret && app.session && !app.session.ended) {
    app.settingsReturnPause = false;
    app.helpReturnPause = false;
    show("play", null);
    setPhase("active");
    pauseGame();
    return;
  }
  goTitle();
}
export function resetProgress(): void {
  platform.resetProgress();
  closeModal();
  setStatus(N("Progress reset."));
}

// -- the hall (3D) -----------------------------------------------------------------------------------
/** The 3D hall's tiles from the round's state. */
export function syncHall(): void {
  const s = app.session;
  if (!s) return;
  const me = mePlayer(s.state);
  render.syncCells(me.marks, platform.options.autoHint ? markable() : new Set());
}

// -- hosted play ---------------------------------------------------------------------------------------
export function seatName(id: string): string {
  if (app.mode === "hosted" && app.hall) return id === meId() ? T("You") : app.hall.nameOf(id);
  return id === "you" ? T("You") : id;
}
function hostedFacade(hall: HallClient): Sess {
  return {
    get state() { return hall.state as unknown as State; },
    get ended() { return (hall.state as unknown as State).phase === "ended" || !!hall.over; },
    legalActions: (id: string) => legalActions(hall.state, id) as { type: string; cells?: number[] }[],
    score: (id: string) => scoreBreakdown(hall.state, id) as Score,
    ranking: () => (hall.state as unknown as State).players.map((p) => p.id).sort((a, b) => compareResults(hall.state, a, b)),
  };
}
export function startHosted(): void {
  leaveHosted();
  app.hallError = null;
  show("hall", "btn-hall-back");
  if (!platform.signedIn()) { app.hallError = "signin"; hostedFail(); return; }
  setStatus(N("Finding a hall…"));
  const hooks = {
    onLobby: (): void => undefined,
    onStart: (c: HallClient): void => { if (app.hall === c) enterHall(c); },
    onState: (state: State, prev: State | null): void => { if (app.hall && app.mode === "hosted") onHallState(state, prev); },
    onOver: (): void => { if (app.hall && app.mode === "hosted") hallOver(); },
    onReject: (reason: string, cell: number | null): void => {
      if (app.mode !== "hosted" || !app.session) return;
      const me = mePlayer(app.session.state);
      const [key, vars] = markError(reason, cell != null ? me.card[cell]! : "");
      setHint(key, vars);
      announce(key, vars);
      cue("invalid");
    },
    onUnavailable: (): void => { if (app.hall) { leaveHosted(); if (app.screen === "play" || app.screen === "hall") { abandonRound(); show("hall", "btn-hall-back"); } hostedFail(); } },
    onAuthLost: (): void => { leaveHosted(); abandonRound(); toast(shT().signedOut); },
  };
  void HallClient.open(platform.roomsAdapter, hooks).then((res: { ok: boolean; client?: HallClient; error?: string }) => {
    if (app.screen !== "hall") { res.client?.leave(); return; }
    if (!res.ok || !res.client) { hostedFail(); return; }
    app.hall = res.client;
    setStatus(N("Hosted hall — waiting for the round to start."));
  });
}
function hostedFail(): void {
  setStatus(N("Hosted play is unavailable right now. Try Practice instead."));
  announce("Hosted play unavailable");
}
export async function startHall(): Promise<void> {
  const h = app.hall;
  if (!h) return;
  cue("ui");
  const r = await h.start();
  if (!r.ok && app.hall === h) hostedFail();
}
function enterHall(c: HallClient): void {
  clearTimers();
  app.mode = "hosted";
  app.stage = { ...(c.stage as Stage), bots: 0, seed: 0 };
  app.session = hostedFacade(c);
  app.results = null;
  app.lb = null;
  app.lesson = null;
  app.focusCell = CENTER;
  setHint(null);
  render.startRound(app.stage.theme || platform.options.theme);
  const last = (c.state as unknown as State).currentCall;
  render.showCall(last || 0);
  show("play", null);
  setPhase("active");
  setStatus(() => T("Round active — {pattern}", { pattern: patternName(app.session!.state.pattern) }));
  syncHall();
}
function onHallState(state: State, prev: State | null): void {
  if (prev && state.currentCall !== prev.currentCall && state.currentCall) {
    cue("call");
    render.showCall(state.currentCall);
    announce("Called {n}", { n: state.currentCall });
  }
  if (prev) {
    const me = state.players.find((p) => p.id === meId());
    const was = prev.players.find((p) => p.id === meId());
    if (me && was) {
      if (me.marksMade > was.marksMade) { cue("mark"); setHint(null); }
      if (countLines(me.marks) > countLines(was.marks)) cue("line");
    }
    for (const p of state.players) {
      const q = prev.players.find((x) => x.id === p.id);
      if (q && p.id !== meId() && p.invalidClaims > q.invalidClaims) setStatus(() => T("{name} made a false claim.", { name: seatName(p.id) }));
    }
  }
  syncHall();
}
function hallOver(): void {
  setPhase("resolving");
  const h = app.hall;
  after(900, () => {
    if (app.hall !== h || app.mode !== "hosted" || !app.session) return;
    setPhase("results");
    const state = app.session.state;
    cue(state.winner === meId() ? "win" : "lose");
    app.results = { hosted: true, unlocked: [], winner: state.winner, recommendation: "" };
    app.lb = null;
    show("results", "btn-next");
  });
}
/** The authoritative result line under the hosted results heading. */
export function hostedReason(): string {
  const o = app.hall?.over as { reason?: string } | null | undefined;
  return reasonText(o?.reason ?? app.session?.state.terminalReason ?? null);
}
function hostedMark(cell: number): void {
  const h = app.hall;
  if (!h) return;
  h.mark(cell);
}
export function leaveHosted(): void {
  if (app.hall) { try { app.hall.leave(); } catch { /* gone */ } app.hall = null; }
  if (app.mode === "hosted") app.mode = null;
}

// -- account ----------------------------------------------------------------------------------------
export function copyInvite(): void {
  cue("ui");
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(shT().copied); }
  catch { toast(shT().copyFailed); }
}
export function signIn(): void { cue("ui"); void requestSignIn().catch(() => undefined); }
platform.onPlayer((signedIn) => { if (!signedIn) toast(shT().signedOut); });

/** The title line under the menu. */
export function titleProgress(): string {
  const p = platform.progress();
  return T("Journey {done}/{total} · Achievements {ach}/{achTotal} · Rounds played {played}", {
    done: p.journeyDone.length, total: JOURNEY_STAGES.length,
    ach: Object.keys(p.achievements).length, achTotal: Object.keys(ACHIEVEMENTS).length, played: p.gamesPlayed,
  });
}
export function accountLine(): string | null {
  if (!platform.signedIn()) return null;
  const st = platform.syncState();
  const status = T(st === "synced" ? N("cloud save synced") : st === "saving" ? N("saving…") : N("cloud save offline"));
  return `${shT().playingAs.replace("{name}", platform.displayName() || "…")} · ${status}`;
}
export { CELLS, GRID, CENTER, LESSONS, CHALLENGES, JOURNEY_STAGES, hashState, countLines };

export function boot(): void {
  setPhase("title");
  show("title", "btn-play");
}
