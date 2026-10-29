# Lantern Bingo — Running Game Design Document

**Status:** running spec. Present tense; describes the game as it ships today. Anything the design
wants but the code does not do yet is confined to §17.

---

## 1. Overview

**Pitch.** A festival lantern hall calls numbers into the dark; you dab your card, watch the target
pattern close, and slam CLAIM before the other lanterns do.

| | |
|---|---|
| Genre | Shared-call number game (75-ball bingo family) with seeded solo/bot rounds and server-refereed hosted halls |
| Players | 1 human vs 0–4 deterministic bot "lanterns" offline; up to 4 players (empty seats bot lanterns) in a hosted hall |
| Session | 3–9 minutes per round (`expectedMinutes` on every content item); a Journey sitting is 2–4 rounds |
| Platforms | A StarHermit engine script game (engine 1.24.0, host API 1.21): natively in the StarHermit client and in desktop and mobile browsers through the engine's web runtime (`index.html` is the engine's loader) |
| Rendering | `starhermit:ui` card, menus and HUD over a `starhermit:scene` lantern hall that shows under the card on tall desktop windows. The card is the game; the hall is scenery. |
| Persistence | The game's save (`starhermit:storage` `saves`) on the device and, signed in, in the account's cloud slot; the game's options as synced settings |

### File map

| Path | Owns |
|---|---|
| `starhermit.txt` | Manifest: `engine.version=1.24.0`, `engine.minor=19`, entry `native/main.ts`, capabilities platform/storage/clipboard, `server=server.js`, the `control.*` keys and `engine.gamepad.*` defaults. |
| `native/main.ts` | Entry: lifecycle (start, suspend/resume, quit), actions from keys and pads, clicks and taps on the 3D tiles, the fixed-step clock, the per-frame look. |
| `native/app.ts` | The controller (what the browser build's `js/game.js` did without the DOM): screen flow, the caller, the bots, marks/claims/hint/undo, lessons, results, achievements, progress, leaderboard posting, Copy Replay, Hosted Play. |
| `native/screens.ts` | Every screen, the HUD, dialogs and the toast as immediate-mode `starhermit:ui`; the card cells and call chip drawn with `starhermit:draw`; the title's drifting sky lanterns. |
| `native/render.ts` | The 3D hall (`starhermit:scene`): ball and pole, tiles, lanterns, floor, board, motes, lights, post effects, tile picking. |
| `native/quality.ts` | The four looks and per-tier budgets keyed by the runtime's graphics tier. |
| `native/audio.ts` | Clip one-shots per event (seeded variant), captions, the rendered ambience loop. |
| `native/platform.ts` | Save and foreign-save migration, the game's options and legacy-settings migration, player/invite/clock, score posting, the rooms adapter for hosted halls. |
| `native/i18n.ts`, `native/style.ts` | The runtime's language → the shipped locale; the converted style sheet, theme and high-contrast tokens. |
| `js/rules.js`, `js/session.js`, `js/content.js` | Pure rules, the session (log, undo, replay envelope, `verifyReplay`), content (themes, lessons, 40 Journey stages, challenges, `dailyFor`, validator). Unchanged from the browser build. |
| `js/hosted.js` | `HallClient`: the hosted hall's lobby (a realtime room) and its bound session's game socket. |
| `js/progress.js`, `js/save-merge.js` | The save document, its normalization and merge, reading the old cloud save, the game's options' checks. |
| `js/i18n.js`, `js/locales/`, `js/sh-strings.js` | `T`/`N` and the nine locales keyed by the US-English text; the account strings. |
| `server.js` | The server script: hosted-hall referee and solo score posting (§12). Its RULES block is written from `js/rules.js` + `js/content.js` by `tools/build-server.mjs`. |
| `assets/ui-style.json` | `tools/ui-style.css` converted with `starhermit css` (`npm run css`). |
| `assets/`, `sfx/`, `cover.jpg`, `icon.png` | Key art, 18 Opus one-shots + `manifest.json`, cover and icon. |
| `index.html`, `starhermit-files.json` | The engine's web loader and file index (`npm run package`; never edited by hand). |
| `tests/`, `tools/` | §14. Left out of the package (`.starhermitignore`). |

---

## 2. Design pillars

**1. The call belongs to everyone; the card belongs to you.**
One number is drawn for the whole hall, and every seat races the same information. *Rules in:* a
single shared deck (`state.deck`, one shuffle per round), bots that see exactly what you see, a
roster rail showing each lantern's line count live. *Rules out:* per-player draws, hidden
information, catch-up handicaps, anything that makes a call mean something different to you.

**2. The dab is the verb.**
Marking is the only thing you do constantly, so it gets the best feedback in the game: an ink-stamp
sample, an amber cell flip, a 3D tile lighting, and the cell's screen-reader name turning to "…, marked". *Rules in:* one tap =
one mark, no drag-select, no auto-dab. *Rules out:* a "mark all" button — the game is about
noticing, and automating the noticing removes the game.

**3. Wrong is cheap but not free.**
A false claim or a mark on an uncalled number costs 25 points and nothing else — no round loss, no
lockout. *Rules in:* `Claim` is disabled until `patternComplete` is true, so the penalty is
essentially opt-in; invalid actions are counted and shown in the running score. *Rules out:* strike
systems, timed lockouts, punishing the exploratory player.

**4. Every round is a receipt.**
Seed, command log and periodic state hashes are recorded for every round and exported by
**Copy Replay**; the results screen prints the seed and the final hash. *Rules in:* `mulberry32`
everywhere, integer scores, `Session.verifyReplay`. *Rules out:* wall-clock in rules, unseeded
`Math.random` in a round (it only picks a *fresh* practice seed), server-trusted client scores.

**5. The 3D hall is scenery, not the game.**
The lantern hall is atmosphere; the UI card is the game. *Rules in:* the hall shows only where there is room
(tall desktop windows), a Low look down to 12 lanterns with no post effects. *Rules out:* any rule, hint or
affordance that exists only in the 3D scene.

---

## 3. Player experience

**Target player.** Someone who knows bingo socially and wants the tension without a hall, plus the
puzzle player who is here for pattern variety and a daily seed to compare.

**First 60 seconds.** The title screen leads with **Play**, which is a quick unranked Practice round
— two lanterns, Two Lines, undo enabled — so nobody reads a menu to start. The Setup screen states
the pattern, its description, opponent count, par and seed before the round starts. A 3–2–1–Go
countdown gives the eye time to find the card. From the first call, every markable cell pulses with
an amber outline (`autoHint`, on by default), so the rule "tap what was called" is taught by the
board rather than by text. `Hint` reads out the callable numbers, and **Learn** offers three
lessons that each gate on the player actually performing the action (`waitFor: 'call' | 'mark' |
'auto-line' | 'claim'`).

**Session shape.** Setup → countdown → 30–70 calls of dab-and-watch → the Claim button lighting up →
results with a component breakdown, ranking, achievements and a "Next" recommendation → Continue,
which advances the Journey or returns to the title.

**The beat the game is built around.** Three cells left, two lanterns already at four lines, and the
next ball is either yours or theirs. The `Claim` button going from disabled to enabled is the payoff
moment, and everything — the call ball pop, the rising line chime, the roster counts — exists to
sharpen it.

---

## 4. Core loop and rules contract

Everything in this section is implemented in `js/rules.js` unless noted; `js/session.js` is the only
caller allowed to advance state.

### Board and entities

- **Card** (`generateCard`): 25 cells, row-major. Column `c` draws 5 distinct values from
  `[c*15+1 … c*15+15]`, so column ranges are 1–15, 16–30, 31–45, 46–60, 61–75. Cell 12 (`CENTER`)
  is the free space, stored as `0` and pre-marked at `createGame`.
- **Deck**: `shuffle([1…75], mulberry32(seed ^ 0x9e3779b9))`. Cards use `mulberry32(seed)`, so the
  two streams are independent and one seed reproduces the whole round.
- **Player record**: `{id, card, marks[25], invalidMarks, invalidClaims, marksMade, claimTick}`.
- **Patterns** (`PATTERNS`): `any-line`, `two-lines`, `diagonal` (either main diagonal), `corners`,
  `frame` (all 16 edge cells), `x-shape` (both diagonals), `full-house`.

### Legal actions

`legalActions(state, playerId)` is the single source of truth shared by play, the `Hint` button, the
bots and the offline content validator:

| Action | Legal when |
|---|---|
| `call` | `phase === 'active'` and `callIndex < 74` |
| `mark` | cell unmarked, not the free centre, and its value is in `currentCalledSet` |
| `claim` | always offered while active; validated on resolution |

### Resolution order

`applyCommand(state, cmd)` clones state, increments `tick`, then:

1. `call` — advance `callIndex`, set `currentCall`, emit `{type:'call'}`.
2. `mark` — bounds check → already-marked check → called check. A failed called-check increments
   `invalidMarks` and emits `invalid-mark` (the tick still advances; the penalty is recorded).
   Success sets the mark, increments `marksMade`, emits `mark` and, if any line is now complete,
   `lines` with the current count.
3. `claim` — if `patternComplete(marks, state.pattern)` and no winner: `winner = id`,
   `phase = 'ended'`, `terminalReason = 'pattern-claimed'`, `claimTick = tick`, emit `win`. If a
   winner already exists, emit `claim-too-late` with no penalty. Otherwise `invalidClaims++` and
   emit `invalid-claim`.
4. `forfeit` — ends the round with `terminalReason = 'forfeit:<id>'` and no winner.

Commands arriving while `phase !== 'active'` are refused with `game-not-active` (except `forfeit`).

### Scoring

`scoreBreakdown(state, playerId)` — integers only:

```
total = 1000·won + 50·lines + 10·marksMade + 15·max(0, parCalls − callsUsed)·won − 25·(invalidMarks + invalidClaims)
```

`speedBonus` applies only when the player won and `parCalls > 0`; `callsUsed = callIndex + 1`.

**Worked example.** Journey stage 3 (`pattern: 'any-line'`, `parCalls: 42`). You win on the 37th
call with 14 marks made, 2 completed lines, and one false claim earlier in the round:

| Component | Maths | Value |
|---|---|---|
| Pattern | won | +1000 |
| Lines | 2 × 50 | +100 |
| Marks | 14 × 10 | +140 |
| Speed | (42 − 37) × 15 | +75 |
| Invalid | 1 × 25 | −25 |
| **Total** | | **1290** |

### Terminal states and ties

A round ends when someone claims a complete pattern, or on forfeit. `compareResults` orders the
final ranking by: winner first → fewer invalid actions → lower `claimTick` (unclaimed sorts last)
→ stable id comparison. The deck can run out (75 calls) without a winner; the round then sits
active with no legal `call` left, and the player leaves via Pause → Leave round.

### RNG, undo and hints

All randomness is `mulberry32`. `Session.snapshots` stores a serialized state before every
state-changing command; `undo()` restores it, pops the command, and drops hash checkpoints past the
restored tick so an exported replay still verifies. The Undo button is shown only in `practice` and
`learn` modes (`native/app.ts` `undoShown`). `Hint` reports the callable numbers, or
"Pattern complete — press Claim!", from `legalActions` + `patternComplete`.

---

## 5. Modes and progression

| Mode | Entry | Content | Ranked | Undo | Caller |
|---|---|---|---|---|---|
| Practice / **Play** | **Play** on the title (Normal) or the Practice picker | `practiceStage(easy\|normal\|hard)`, fresh random seed | no | yes | local, `callSpeed` |
| Learn | Learn list | 3 `LESSONS`, 0 bots, manual calls only | no | yes | player |
| Journey | Journey list | 40 authored stages | yes | no | local |
| Daily | Daily button | `dailyFor(day)`, the platform's UTC day | yes | no | local |
| Challenge | Challenge picker | 4 constrained rounds | yes | no | local |
| Hosted | Hosted Play (signed in) | a realtime room, refereed by `server.js` | recorded by the server | no | **server.js**, 4 s fixed |

**Practice difficulties:** easy = `any-line`, 1 bot @ 0.40 skill, par 42; normal = `two-lines`,
2 bots @ 0.60, par 58; hard = `frame`, 3 bots @ 0.80, par 70.

**Journey curve** (`content.js`): 40 stages in 5 blocks of 8. Pattern advances with the block along
`any-line → diagonal → corners → two-lines → frame → x-shape → full-house`; every 8th stage is a
**Mastery** stage that pulls the *next* block's pattern forward as a test. `difficulty = 1 + ⌊i/5⌋`
drives `botSkill = min(0.95, 0.35 + 0.07·difficulty)`, and bot count steps 1 → 2 → 3 → 4 at stages
11, 21 and 31. Theme rotates per block. Stages unlock strictly one ahead of the first unfinished
stage (`buildJourneyList`), so nothing is skippable but nothing is a wall.

**Challenges:** Speed Lantern (`any-line`, par 38, 3 bots @ 0.85), Iron Frame (`frame`, par 68),
Steady Hand (`two-lines`, "win with zero invalid actions"), Full Glow (`full-house`, 4 bots @ 0.80).

**Daily:** the date string (the platform's UTC day, `serverNow()`; the device's when offline) is hashed
to a seed; that seed picks pattern and theme. Identical for everyone on the same UTC day, immutable once published. Best score is kept per day in
`progress.dailyHistory` and shown in the Setup title on a repeat visit.

**Unlocks and achievements.** Journey stage gating is the only content lock. Five achievements:
First Light (first win), Line Keeper (50 lines lifetime), Steady Flame (3 wins in a row),
Full Lantern (win a blackout round), Long Road (all 40 Journey stages). Unlocks are announced on
the results screen with the `achievement` cue.

---

## 6. Controls and interaction

| Input | Keyboard (default, rebindable) | Gamepad (default) | Pointer / touch |
|---|---|---|---|
| Move between cells | Arrow keys (the UI's focus over the card grid; no wrap) | D-pad / left stick | — |
| Mark a cell | `Enter` (`mark`) or `Space` on the focused cell; `Enter` with nothing focused focuses the card | South on the focused cell | tap/click the cell, or its tile in the 3D hall |
| Draw a number | `Space` (`call`) when no widget has focus, or **Call** | West | **Call** |
| Claim | `C` (`claim`) or **Claim** | North | **Claim** |
| Hint | `H` (`hint`) | Right shoulder | **Hint** |
| Undo (practice/learn) | `U` (`undo`) | Left shoulder | **Undo** |
| Pause | `P` (`pause`) or `Esc` (`back`) during a round | Start / East | **Pause** |
| Reset 3D camera | `R` (`camera`) | Right stick press | — |
| Back / close | `Esc` (`back`): sub-screens go back (Settings and Help to the pause dialog when opened from it); on the pause dialog resumes | East | Back / Done |

The runtime owns rebinding (Settings → **Change keys and buttons** opens it), F1 and its Options. Tray buttons show
their key (`bindingLabel`). Touch needs no on-screen controls: the card and tray are buttons.

**Input locking.** Marks are ignored unless the phase is `active` and no dialog is open. A short dedupe
(the same cell on the same tick within 400 ms) absorbs double presses. `Claim` is disabled until the
pattern is complete. In hosted rounds `Call` is disabled (the server is the caller).

**Feedback for every input.** Marks: the cell turns amber with a ring, the 3D tile lights, the `mark`
sample, the screen-reader name changes. Rejections: the `invalid` sample plus a plain-language line
under the card ("Number 47 has not been called yet."), also announced. Calls: the chip and the ball
repaint, the ball pops (unless reduced motion), the `call` sample, "Called 47" announced. Buttons: the
`ui` sample.

## 7. Screens and UI flow

```
title ─┬─► setup ─► play (countdown 3-2-1-Go) ─► results ─┬─► title
       │             ▲   │                                └─► setup (next Journey stage) / Journey list
       │             └ pause dialog (Resume / Settings / Help / Leave round)
       ├─► journey / learn lists ─► setup / lesson
       ├─► Practice / Challenge pickers (dialogs) ─► setup
       ├─► settings, help (back to the title or the pause dialog)
       └─► hosted hall lobby ─► play (server-driven) ─► results
```

A top bar shows on every screen: the title, the status line (the phase in words: "Main menu", "Get
ready…", "Round active — Two Lines", "Paused", …) and the audio caption line (`♪ number called`).

**Layouts** (the old media queries, picked from the window's logical size):
- **Wide** (≥ 1024 wide, taller than 500 and not a short landscape): objective rail | call chip, card,
  hint line | Hall roster rail; the tray along the bottom. The card is at most min(480, height − 300).
  Taller than 900: the 3D hall shows under the hint line, 4:3, at most 640 wide, with 14 px rounded corners.
- **Stacked** (narrower portrait windows): the objective rail condensed above, the roster condensed
  below the card, the tray pinned at the bottom over a gradient (phones).
- **Short landscape** (≤ 500 tall, or landscape under 1024 × 720): narrow rails (120–170) beside the
  card, cells down to 36 px, no game title during play; the title menu lays its nine buttons out 3×3.

Pages taller than the window scroll (results keep Retry / Copy Replay / Continue pinned below the
scroll). Larger UI and text sizes from the runtime scale everything (`ui.preferences()`).

## 8. Art direction

**Palette** (`tools/ui-style.css` tokens, `content.js THEMES`): page `#0f1226`, ink `#e8ecff`, accent
`#ffd7a0`, lantern amber `#ffb454`, panels `#1a2040` / `#2b3a67` / `#3d5290`, ok `#8be09b`, danger
`#ff7a7a`. The runtime's high contrast swaps in black panels, white ink and a gold accent and drops the
key art. Five 3D themes tint background, lanterns, floor and fill: Ember Court, Jade Garden, River Night,
Plum Festival, Paper Dawn.

**Shape and motion.** Warm circles against cool rectangles: spherical lanterns and the call ball over a
grid of 10 px-radius tiles; marks are an amber tile plus a ring. The markable-cell outline pulses (1.2 s,
"Hint markable cells"), the target pattern's cells carry a faint inner ring (corners, frame, diagonals),
the call ball pops; on animated looks the hall's lanterns sway, the ball bobs, its light flickers, motes
rise, sky lanterns drift up the title and the title lantern's glow pulses. The runtime's reduced motion
stops all of it and shortens the countdown beats from 750 to 500 ms.

**Graphics looks** (`native/quality.ts`, keyed by the runtime's graphics tier; the runtime owns the
level, render scale, adaptive resolution and frame-rate limit):

| Tier | Shadows | AO | Bloom / grade | AA | Reflections | Hall lanterns | Motion | Detail | Materials | Floor tex | LOD | Motes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Low | off | off | off | MSAA | off | 12 | still | plain | Lambert | — | ½ | — |
| Balanced | 512 | off | on | FXAA | RoomEnvironment | 24 | animated | detailed | Standard | 512 | ¾ | 60 |
| High | 1024 | on | on | SMAA | on | 40 | animated | detailed | Physical (clearcoat) | 512 | 1 | 90 |
| Ultra | 2048 | high | on | MSAA | on | 40 | animated | detailed | Physical | 1024 | 1.5 | 150 |

Motes grow up to 2× with the level inside a tier. "Detailed" is the old lit-paper/lacquer finish: the
`-lux` button and panel classes, gradient card cells and call chip, ribbed lathe lanterns with caps, the
textured plank floor, the lacquered board, bevelled glossy tiles, a brass pole. Bloom only takes lantern
paper and highlights (threshold 2.0); the grade is the old GradeShader in display space with a 0.26
vignette. Lights are three.js r185's intensities ÷ π.

**Key art.** `assets/title-hall.webp` behind the title under a radial scrim; `assets/results-lantern.webp`
as the results banner (hidden on short landscape and under high contrast).

## 9. Audio direction

Each event plays one of its two authored one-shots (`sfx/manifest.json`, variant from a seeded RNG):
`ui`, `call`, `mark`, `invalid`, `line`, `win`, `lose`, `tick`, `go`, `achievement` (the event table and
sources are in `sfx/manifest.md`). Under the game a quiet lantern hum (110 + 165 Hz sines at 0.05) loops
from the first press. Menu taps play on the runtime's interface bus, everything else on effects; Options
› Audio owns volumes, mute and the voice limit. Clips load one at a time once the mixer runs; a clip still
loading is silent. **Captions:** every event writes its line (`♪ marked`, `♪ number called`, `♪ bingo!
round won`, …) under the status line, so the audio reads with sound off.

## 10. Localization

Every player-facing string is localized in en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and
it-IT: code calls `T('<US-English text>', vars)` (`js/i18n.js`, catalogues in `js/locales/` keyed by the
English text; es-ES and fr-CA list their differences). The language is the runtime's interface language
(Options › Language, else the account's or the device's), mapped to the nearest shipped locale, and a
change shows on the next frame. Content names (patterns, lessons, challenges, themes, achievements,
captions) stay English data and translate where shown; rule refusal codes map to sentences.

## 11. Accessibility

- **Keyboard and pad path** is complete: every screen focuses its first action, the card is a UI grid
  (arrows / D-pad), every round action has a key and a pad button, dialogs focus their first button.
- **Screen readers.** Cells are buttons named "row 3 column 2, number 47, marked | callable" inside a
  grid named "Your bingo card"; the call chip reads "Called 47"; calls, rejections, hints, countdown
  beats and outcomes are announced (`ui.announce`).
- **Captions** mirror every audio event. **Contrast**: the runtime's high contrast swaps the tokens and
  drops the key art. **Reduced motion**: the runtime's option (§8). **Text and UI size**: the runtime's.
- **Targets**: 44 px minimum on buttons and cells (36 px cells on short landscape screens).
- **Game options** (Settings): Theme, Call speed (Fast 3 s / Normal 5 s / Relaxed 8 s / Manual only),
  Hint markable cells, Left-handed action tray (the tray's order reversed), Reset progress (confirmed).

## 12. StarHermit integration

- **Player.** `player()`: the title shows "Playing as <display name> · cloud save synced | saving… |
  cloud save offline"; guests see **Sign in with StarHermit** (the runtime's sign-in). Signed in, **Invite
  a friend** copies the invite link. Signing out shows a toast and play goes on locally.
- **Save.** The progress record (`js/progress.js`) is the game's save, schema 1, on the device and in the
  cloud slot; conflicts merge the best of both (union of stages, lessons, days; best score per stage
  and per day; earliest unlock times; the larger round count). The browser build's cloud save (the JS
  SDK's JSON document under `game:<slug>`) shows as foreign: its progress is merged in and the slot
  replaced once (`replaceForeign`). Guests' old browser `localStorage` progress does not migrate.
- **Options.** Theme, call speed, hint markable cells and the left-handed tray are synced game settings.
  The browser build's account settings keys (`theme`, `callSpeed`, `autoHint`, `leftHanded`, …,
  `ui.language`) are adopted where the game still has the option and then removed; volumes, mute,
  graphics, reduced motion, high contrast, larger text and language are the runtime's Options.
- **Leaderboard.** One board, `high-score` (integer, higher is better, 0–100,000). Signed in, every
  finished solo round except Learn posts its total (floored at 0) on a practice session to
  `server.js`, which range-checks it (the user's decision: solo scores keep the client's total); the
  results show "Leaderboard rank: #N" (or posted / not posted). Hosted rounds post nothing.
- **Hosted halls** (signed in). Hosted Play quick-joins an open hall of the game (one team of four
  seats) or creates and opens one; the lobby lists the players, and the host's **Start round** starts
  the room. The platform binds a session to it and `server.js` referees: seats are the room's players
  by slot, then bot lanterns to four; the pattern, par and theme are the day's (`dailyFor` on the
  platform's UTC day) with a deck shuffled from the script's own seed; it calls every 4 s, the bots mark
  and claim right after each call (the browser build's HallHost rule), and each mark or claim is applied
  for the sender's seat (penalties included). Players get the cards, marks and the numbers called so
  far — never the seed or the deck to come. The round ends on a claimed pattern, 8 s after the 75th call
  with no claim (`deck-exhausted`), or when every player has left (`abandoned`); the script returns the
  result (winner, each seat's score, the ranking), which closes the room and is recorded. No client
  reports a result.
- **Daily.** The platform's clock (`serverNow()`), the device's UTC date when offline.
- **Not used:** matchmaking queues, friend-picker invites, chat, platform achievements, replays.
  Achievements and personal bests stay in the save.

## 13. Technical architecture

**Layering.** `js/rules.js` (pure) ← `js/session.js` (log, undo, replay) ← `native/app.ts`; hosted rounds
read the server's view through a session-shaped facade over `HallClient`. `server.js` runs the same
rules (its RULES block is generated; `npm run server` rewrites it, the tests fail when it is stale).

**Time.** A round clock advanced by the runtime's fixed steps (60 a second) drives the countdown beats,
auto calls, bot reactions (600 + (1 − skill)·4000 + jitter ms after each call) and the beat before results;
a pause or a hidden window freezes it, so play scripts replay exactly.

**Determinism and replay.** `mulberry32` everywhere; Copy Replay puts the envelope (`exportReplay()`:
seed, commands, periodic hashes, terminal) on the clipboard; results print the seed and the final hash.

**Rendering.** The scene draws only on the play screen when the hall has room; the UI paints the page
colour around its rectangle. The card cells, call chip and sky lanterns are overlay drawing, never canvas
repaints per frame; the ball's number is one 256² canvas texture repainted per call.

## 14. Testing and acceptance criteria

`npm test` runs:
- **Unit** (`node --test`, 54 cases): `tests/rules.test.js` and `tests/session.test.js` (unchanged from the
  browser build: RNG, cards, patterns, scoring, ties, serialization, undo, replay verification, content
  validation); `tests/save.test.mjs` (old cloud document, normalization, merge, options);
  `tests/server.test.mjs` (`server.js` under a fake platform host: declarations and a current RULES block,
  score posting, seats, views without the seed or deck, the caller, seat-bound commands and penalties,
  full rounds to a recorded result, leavers, deck exhaustion); `tests/hosted.test.mjs` (two `HallClient`s
  over a fake platform running `server.js`, lobby to result); `tests/jint.test.mjs` (a whole hall and a
  score post in the platform's own Jint script worker under the 250 ms budget — skipped where the worker
  is not built); `tests/i18n.test.mjs` (every key of `native/*.ts`, `js/*.js` and the content in all nine
  locales, no stray keys); then `tests/validate-content.js` (44 items).
- **Native** (`tests/native.mjs`): the web index matches the files, `tsc` (strict, no skipLibCheck),
  `starhermit check .` with no warnings, and every `tests/native/*.play` as a guest `--render-check`:
  `screens.play` (Help, Settings and Options, reset dialog, lists, Daily, pickers, Hosted Play as a guest),
  `practice.play` (call, hint, a refused mark undone, pause, Help and back, Leave round),
  `journey-stage1.play`, `challenge-speed.play` and `learn-lines.play` — whole rounds to results generated
  by `tools/gen-plays.mjs` from the rules (it replays the caller, the player's marks and the bots exactly).
- **Browser** (`npm run test:browser`, `tools/browser-play.mjs`): the packaged loader in Chrome on the GPU
  (`~/games/tools/gpu-chrome.mjs`) at 1366×768, 1920×1080 (the 3D hall), a 390×844 phone at DPR 3 and an
  844×390 landscape phone: Quick Play by keys, a call, a hint, a tap on the card, the pause dialog; any
  console error or warning or the runtime's error screen fails.

QA bar: every mode reaches results through visible controls; nothing is cut off at 1366×768, 390×844 or
844×390; rules, hints and bots read the same `legalActions`; rounds are reproducible from seed and log.

## 15. Asset inventory

| Path | Purpose | Source |
|---|---|---|
| `assets/title-hall.webp` | Title backdrop | FLUX.2 klein, 1280×720 |
| `assets/results-lantern.webp` | Results banner | FLUX.2 klein, 1024×576 |
| `cover.jpg`, `coverart.png`, `icon.png` | Store cover, cover art, icon | prior passes |
| `sfx/*.opus` | 18 one-shots, two per event (`sfx/manifest.md`) | MOSS-SFX v2 |
| `assets/ui-style.json` | The converted style sheet | `npm run css` |

No 3D model is loaded: the hall is procedural primitives and instanced lanterns.

## 16. Known limitations

1. **Local-player assumptions.** Offline paths address the local seat as `'you'` / `players[0]`
   (hosted play uses `meId()`), as before.
2. **Invalid-actions row sign.** The local results table prints a zero penalty as "+0".
3. **Bots do not mis-claim.** `claim-too-late` and bot false claims are essentially never seen.
4. **Deck exhaustion offline has no ceremony.** After 75 calls with no winner a local round stays
   active; the player leaves via Pause. (Hosted halls end it after 8 s.)
5. **Achievement counters are session-scoped** (`linesTotal`, `winStreak` reset on restart).
6. **Hosted halls**: one round per hall (the browser build's host tab restarted rounds every 15 s);
   no spectators or mid-round joins (a started room takes no joiners); the hosted client path is not
   live-tested here (only the fake platform and the Jint worker run it); hosted replays are not exportable.
7. **Lessons have auto calls.** A lesson's countdown arms the auto caller at the chosen call speed, as
   the browser build did (the lesson steps still wait for the player).
8. **Arrow keys stop at the card's edge** (the browser build wrapped them).
9. **Old guest progress** in a browser's `localStorage` does not carry over (cloud saves do).

## 17. Design intent not yet implemented

- **Unified seat identity** offline (route every read through `meId()`).
- **A no-winner terminal state** offline with its own results screen.
- **Lifetime achievement counters** persisted in the save.
