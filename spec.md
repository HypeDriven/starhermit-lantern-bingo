# Lantern Bingo — Running Game Design Document

**Status:** running spec. Present tense; describes the game as it ships today. Anything the design
wants but the code does not do yet is confined to §17.

---

## 1. Overview

**Pitch.** A festival lantern hall calls numbers into the dark; you dab your card, watch the target
pattern close, and slam CLAIM before the other lanterns do.

| | |
|---|---|
| Genre | Shared-call number game (75-ball bingo family) with seeded solo/bot rounds and an authoritative hosted room |
| Players | 1 human vs 0–4 deterministic bot "lanterns" offline; up to 4 seats + spectators in a hosted room |
| Session | 3–9 minutes per round (`expectedMinutes` on every content item); a Journey sitting is 2–4 rounds |
| Platforms | Desktop and mobile browsers, portrait and landscape; no install, no build step |
| Rendering | A three.js hall (`js/three.module.js`, r185, vendored) as decorative depth **behind** a DOM `<button>` grid that is the authoritative interaction surface. The game is fully playable with WebGL absent. |
| Persistence | `localStorage['lantern-bingo-v1']`, FNV-1a checksummed (offline cache); hosted mode mirrors the same doc to the StarHermit cloud-save slot |

### File map

| Path | Owns |
|---|---|
| `index.html` | Eight `<section class="screen">` panels, the action tray, the `<dialog>` modal, and the three live regions (`#live-status`, `#live-alert`, `#captions`). |
| `css/style.css` | Palette tokens, responsive grid at three breakpoints, safe-area insets, accessibility body classes, title/results key art. |
| `js/rules.js` | Pure rules engine: card generation, `PATTERNS`, `legalActions`, `applyCommand`, `scoreBreakdown`, `compareResults`, `serialize`/`deserialize`/`hashState`. No DOM, no `Date`, no `Math.random`. |
| `js/session.js` | `Session` — the only mutable holder of rules state; command log, undo snapshots, replay envelope + `verifyReplay`, `botCommands`. |
| `js/content.js` | `THEMES`, `LESSONS`, 40 `JOURNEY_STAGES`, 4 `CHALLENGES`, `dailyFor(dateISO)`, and the offline `validateContent` simulator. |
| `js/audio.js` | `AudioEngine`: four gain buses, sampled-clip loader over `sfx/manifest.json`, seeded synth fallback per event, caption emission. |
| `js/gfx.js` | Pure graphics quality model: presets, categories, `detectPreset(gpu)`, `resolve()`, `presetTier()`, `choosePreset()`, `describe()`. |
| `js/gfx-strings.js` | Graphics-section strings in the nine locales and `pickLocale(navigator.languages)`. |
| `js/hall-post.js` | Loaded on demand: EffectComposer chain (GTAO, UnrealBloom, grade + vignette, SMAA/FXAA) and the RoomEnvironment PMREM map. |
| `js/title-fx.js` | `TitleFx`: 2D-canvas sky lanterns drifting behind the main menu. |
| `js/vendor/three/addons/` | three r185 addons (postprocessing, shaders, RoomEnvironment), resolved through the `index.html` importmap. |
| `js/game.js` | Everything the player touches: `HallRenderer`, graphics runtime (GPU probe, adaptive scale, FPS meter, Graphics panel), screen state machine, card DOM, call loop, bots, results, settings, hosted hall client (rooms + legacy dev `/ws`), keyboard. |
| `starhermit-sdk.js` | Shared StarHermit client (unmodified copy): launch token, renewal, sign-in, profile, cloud save, settings, controls, invite link. |
| `js/platform.js` | Adapter over the SDK: hosted flag, nickname, cloud-save mirror + sync status, settings-KV mirroring, key bindings, sign-in/invite, Bearer fetch for the rooms lobby. No-op without a token. |
| `js/sh-strings.js` | Account-control strings in the nine locales. |
| `js/hallnet.js` | Realtime-rooms hall: REST lobby (quick-join/create/open/leave/result/mine), binary frame codec (server-stamped 16-byte sender prefix), guest throttles, and `HallHost` — the host-side caller/rounds runner. |
| `server.js` | StarHermit `server=` script: static host, a dev-only `/api/v1/time` clock probe, and a dependency-free RFC6455 WebSocket hall for local play (no token). |
| `sfx/` | 18 Opus one-shots + `manifest.txt` (canonical) / `manifest.json` (loader + generator input) / `manifest.md`. |
| `assets/` | `title-hall.webp`, `results-lantern.webp` key art. |
| `tests/` | `rules.test.js`, `session.test.js`, `platform.test.js`, `hallnet.test.js`, `gfx.test.js` (`npm test`), `e2e.mjs` (real-UI playthrough incl. Graphics presets/override/persistence at desktop + mobile and a tall-desktop 3D hall pass under Ultra and Low), `hosted-smoke.mjs` (token + mock platform in Chrome), `hall-rooms-smoke.mjs` (mock realtime platform, host+guest), `validate-content.js`, plus older smoke harnesses. |

---

## 2. Design pillars

**1. The call belongs to everyone; the card belongs to you.**
One number is drawn for the whole hall, and every seat races the same information. *Rules in:* a
single shared deck (`state.deck`, one shuffle per round), bots that see exactly what you see, a
roster rail showing each lantern's line count live. *Rules out:* per-player draws, hidden
information, catch-up handicaps, anything that makes a call mean something different to you.

**2. The dab is the verb.**
Marking is the only thing you do constantly, so it gets the best feedback in the game: an ink-stamp
sample, an amber cell flip, a 3D tile lighting, and an `aria-pressed` change. *Rules in:* one tap =
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

**5. WebGL is scenery, not the game.**
The lantern hall is atmosphere; the DOM grid is the game. *Rules in:* a `try/catch` around
`WebGLRenderer`, a context-lost message, a Low preset down to 12 lanterns at DPR 1 with no post-processing. *Rules out:*
any rule, hint or affordance that exists only in the 3D scene.

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
`learn` modes (`js/game.js`, `startRound`). `Hint` (`#btn-hint`) reports the callable numbers, or
"Pattern complete — press Claim!", from `legalActions` + `patternComplete`.

---

## 5. Modes and progression

| Mode | Entry | Content | Ranked | Undo | Caller |
|---|---|---|---|---|---|
| Practice / **Play** | `data-nav="play-quick"` (Normal) or the Practice picker | `practiceStage(easy\|normal\|hard)`, fresh random seed | no | yes | local, `callSpeed` |
| Learn | Learn list | 3 `LESSONS`, 0 bots, manual calls only | no | yes | player |
| Journey | Journey list | 40 authored stages | yes | no | local |
| Daily | Daily button | `dailyFor(day)`, local UTC day | yes | no | local |
| Challenge | Challenge picker | 4 constrained rounds | yes | no | local |
| Hosted | Hosted Play | realtime room (platform) or the dev server hall (local) | host-owned | no | **host client**, 4 s fixed |

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

**Daily:** the date string is hashed to a seed; that seed picks pattern and theme. Identical for
everyone on the same UTC day, immutable once published. Best score is kept per day in
`progress.dailyHistory` and shown in the Setup title on a repeat visit.

**Unlocks and achievements.** Journey stage gating is the only content lock. Five achievements:
First Light (first win), Line Keeper (50 lines lifetime), Steady Flame (3 wins in a row),
Full Lantern (win a blackout round), Long Road (all 40 Journey stages). Unlocks are announced on
the results screen with the `achievement` cue.

---

## 6. Controls and interaction

| Input | Desktop | Mobile |
|---|---|---|
| Mark a cell | click the grid button, or `Enter` on the focused cell, or click the 3D tile | tap the grid button or the 3D tile |
| Move the card cursor | `←↑→↓` (wraps in both axes) | — (direct tap) |
| Draw a number | `Space` (when a card cell is not focused) or **Call** | **Call** in the tray |
| Claim | `C` or **Claim** | **Claim** |
| Hint | `H` or **Hint** | **Hint** |
| Undo | `U` or **Undo** (practice/learn only) | **Undo** |
| Pause | `P` / `Esc` or **Pause** | **Pause** |
| Reset 3D camera | `R` | — |
| Back / close | `Esc` | Back / Done buttons |

`Space` is context-sensitive: with a card cell focused it marks, otherwise it calls, so keyboard
players never have to leave the grid. Every `keydown` handled on the play screen calls
`preventDefault()` for arrows, `Enter` and `Space` so the page never scrolls under the card.

**Input locking.** Marks are ignored unless `gamePhase === 'active'`, which covers boot, countdown,
pause, resolution and results. A short dedupe key (`mark-<cell>-<tick>`, cleared after 400 ms)
absorbs double-fire from touch and pointer events. `Claim` is `disabled` until the pattern is
actually complete. In hosted rounds `Call` is disabled (the server is the caller) and a spectator's
marks are answered with an on-screen explanation instead of a command.

**Feedback for every input.** Marks: cell flips amber with a ring, 3D tile lights, `mark` sample,
`aria-pressed` update. Rejections: `invalid` sample plus a plain-language line in `#hint-text`
("Number 47 has not been called yet.") that is also announced. Calls: ball texture repaints, pops
(unless reduced motion), `call` sample, `#call-display` updates, "Called 47" announced. Buttons:
`ui` sample on press.

---

## 7. Screens and UI flow

```
boot ─► title ─┬─► setup ─► play ─► results ─┬─► title
               │            ▲   │            └─► setup (next Journey stage)
               │            └ pause modal
               ├─► journey / learn ─► setup
               ├─► settings ─► title | pause
               ├─► help ─► title | pause
               └─► hosted ─► play (server-driven) ─► results
```

`showScreen(name)` hides all eight sections and focuses the first button in the new one.
`gamePhase` runs `boot → title → preparing → countdown → active ↔ paused → resolving → results`
and is mirrored verbatim into `#live-status`, which is also what the e2e test synchronizes on.
Pause opens the `<dialog>` with Resume / Settings / Help / Leave round; Settings and Help opened
from pause return to the pause modal rather than the title, so a paused round is never lost.

**Desktop (≥1024 px).** Three-column play grid: objective rail (target, description, calls/lines/
marks, running score) | playfield (3D hall, call banner, 5×5 card, hint line) | roster rail. The
card is capped at `min(480px, 100vh − 300px)`; the hall is shown only on viewports taller than
900 px and takes the height left under the card (4:3, at most 640 px wide), so the tray always stays
on screen. The pause dialog is centred, and the results Retry / Copy Replay / Continue row is
`position: sticky` at the bottom, so it stays visible when the breakdown runs past the fold.

**Large screens (above 1600×1000).** `ui-scale.js` sets `--ui-scale` (`min(w/1600, h/1000)`,
capped at 2.5) and `body` is CSS-`zoom`ed by it, so the whole page (dialog, toast and fps meter
included) renders as the ~1600–1778×1000 layout magnified; every vw/vh length is divided by
`--ui-scale` and the 3D hall multiplies its pixel ratio by `UIScale.value`.

**Tablet / small desktop (<1024 px).** The play grid collapses to one column; the roster rail moves
below the playfield (`order: 3`) so the card stays in the upper half of the screen.

**Portrait mobile (≤640 px).** The hall goes 1:1, and the action tray becomes `position: sticky`
at the bottom over a gradient so Call/Claim are always reachable with a thumb.

**Landscape mobile (≤500 px tall).** Rails narrow to 120–170 px, the hall is capped at 40vw, cell
type shrinks, the title drops to 20 px, and the results key art is hidden — the card and the tray
must both fit without scrolling.

**Safe areas.** `viewport-fit=cover` plus `--sat-*` tokens from `env(safe-area-inset-*)` pad the
topbar, main, tray and modal. **Never cut off:** the 5×5 card, the Call/Claim buttons, the call
display, and `#live-status`.

---

## 8. Art direction

**Palette** (`css/style.css` `:root`, `content.js THEMES`):

| Token | Value | Use |
|---|---|---|
| page | `#0f1226` | night ground behind everything |
| `--ink` | `#e8ecff` | body text |
| `--accent` | `#ffd7a0` | headings, focus ring, hint text |
| `--accent-2` | `#ffb454` | lantern amber: primary buttons, marked cells, the call ball |
| `--panel` / `--panel-2` / `--panel-3` | `#1a2040` / `#2b3a67` / `#3d5290` | panel, control, hover |
| `--ok` / `--danger` | `#8be09b` / `#ff7a7a` | winner row / errors |
| High contrast | `#000` panels, `#fff` ink, `#ffd700` accent | body class `high-contrast` |

Five 3D themes tint background, lantern, floor and accent: Ember Court `0xffb454`, Jade Garden
`0x7be0a3`, River Night `0x6fb7ff`, Plum Festival `0xff8fc7`, Paper Dawn `0xfff1c9`.

**Shape language.** Warm circles against cool rectangles: spherical lanterns and a spherical call
ball float over a rectilinear grid of 10 px-radius tiles. Marks are a filled amber tile plus a
`::after` ring — a dauber dot, not a tick.

**Typography.** One system stack (`Segoe UI`/Roboto/Arial). Everything scales with `clamp()`; card
numbers `clamp(16px, 2.6vw, 26px)` at weight 700, the call ball 800 in a circular chip. Numbers are
tabular in score tables.

**Motion.** The markable-cell outline pulse (1.2 s), the call-ball scale pop on draw, and — with
Background motion on — the lantern sway (`sin` on x and y, per-instance phase), a gentle ball bob,
ball-light flicker, rising dust motes in the hall, drifting sky lanterns on the title and a glow
pulse on the title lantern. All are cut by the `reduced-motion` body class **and** by
`prefers-reduced-motion`; the countdown also shortens from
750 ms to 500 ms per beat. Nothing motion-only carries meaning.

**The hero.** The current call — the glowing ball on its pole under a point light, mirrored in the
`#call-display` chip. Second is the card; the hall recedes behind fog from 12 to 26 units.

**Graphics.** The hall renders with ACES filmic tone mapping and sRGB output, a hemisphere fill
plus a warm key light whose PCF shadow box is fitted to the card, ball and pole, a warm point light
on the ball and a theme-tinted fill behind the lantern rows. Optional effects: key-light shadows,
GTAO ambient occlusion, bloom limited to lantern paper and bright highlights (luminance threshold
2.0), a colour grade with vignette, SMAA/FXAA/MSAA anti-aliasing, RoomEnvironment image-based
reflections, 12/24/40 hanging lanterns, background motion, and surface detail (ribbed lathe
lanterns with caps, a textured plank floor, a lacquered clearcoat board under bevelled glossy
tiles, a brass pole and a clearcoat banded call ball; on the DOM side a lit-paper/lacquer finish
on card cells, the call chip, panels and buttons — paint only, never lower contrast, off under High
contrast). The Settings **Graphics** section offers a quality preset (Auto, chosen from the
detected GPU — software renderers get Low, discrete GPUs and Apple M get High, others Balanced,
touch devices capped at Balanced; Low; Balanced; High; Ultra), a render scale (50–200%), a
per-effect override for each category ("From preset (…)" by default; choosing a preset clears
overrides), adaptive resolution (steps the resolution down to 60% when ~90-frame averages exceed
26 ms and back up under 14 ms) and a frame-rate readout (bottom-left, non-interactive), plus a
summary "GPU · cost · W×H px". Changes apply immediately (no reload; canvas MSAA changes swap the
WebGL renderer, keeping the scene) and persist in `store.data.settings.graphics` (cloud-mirrored
with the other settings). If the post-processing addons or chain fail, the hall renders without
them and the panel says so. The current preset is exposed as `body[data-gfx-preset]`.

**Visual assets the design calls for.** (1) A title backdrop that says "festival hall at night"
before any text is read, dark enough in the centre for a menu column to sit on it. (2) A results
banner that reframes the round as a small ceremony. Both ship — see §15.

---

## 9. Audio direction

**Mix philosophy.** The hall is quiet so the call can be loud. Ambience is a two-oscillator drone
(110 Hz + 165 Hz at 0.05 gain) that never competes; calls sit on their own `voice` bus so a player
who only wants to hear numbers can drop everything else to zero.

**Buses** (`AudioEngine.buses`, defaults): `music` 0.5, `effects` 0.8, `ambience` 0.4, `voice` 0.7,
each a `GainNode` into a master gain. Mute zeroes all four without losing the slider values.

**Sampling and fallback.** After the first pointer gesture unlocks the `AudioContext`, the engine
fetches `sfx/manifest.json` and lazily decodes clips on first use. Each event id maps to two
variants chosen by a seeded RNG; a failed fetch or a not-yet-decoded buffer falls through to the
original synthesized transient, so the game is never silent. Sampled playback emits the same caption
as its synth twin.

### SFX event table — the source for `sfx/manifest.txt`

| Event id | Files | Description | Fires when |
|---|---|---|---|
| `ui` | `ui-lantern-tap`, `ui-menu-select` | papery lantern tap / clave + brass ping | any menu, tray or modal button press |
| `call` | `call-ball-draw`, `call-number-chime` | ball down a bamboo chute / two singing-bowl notes | `doCall()`, or a hosted snapshot whose `currentCall` changed |
| `mark` | `mark-paper-stamp`, `mark-ink-dab` | rubber stamp on card / dauber dot | a legal mark lands |
| `invalid` | `invalid-wood-thud`, `invalid-brush-scratch` | dull table knock / dry brush scratch | uncalled number, already marked, false claim, server rejection |
| `line` | `line-lantern-glow`, `line-chime-rise` | lantern flaring up / three glass chimes | a `lines` event names the local player |
| `win` | `win-festival-fanfare`, `win-bingo-bells` | temple bells + flute / hand-bell cascade | the local player claims first |
| `lose` | `lose-paper-sigh`, `lose-ember-fade` | paper sigh / ember pop into a fading gong | another lantern claims first |
| `tick` | `tick-clock-tap`, `tick-wood-tick` | escapement tick / bamboo on wood block | each "3", "2", "1" countdown beat |
| `go` | `start-gong-swell` | warm gong swell blooming into shimmer | the final "Go" beat as the round opens |
| `achievement` | `achieve-bell-bloom` | two hand bells with a glittering tail | 450 ms into results when a badge unlocked |

**Captions.** Every event writes a short caption into `#captions` (`♪ marked`, `♪ number called`,
`♪ bingo! round won`, `♪ round begins`, `♪ achievement unlocked`), so the audio layer is fully
readable with sound off.

---

## 10. Localization

The product requires en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT.
The Settings **Graphics** section is localized in all nine (`js/gfx-strings.js`, picked from
`navigator.languages`). **Not implemented** for the rest: every other string is a hard-coded English literal in `index.html`,
`js/game.js` (status lines, hints, results, modals) and `js/content.js` (pattern names, lesson
text, stage titles), and `<html lang="en">` is fixed. The intended shape is in §17: one
`js/i18n.js` keyed catalogue, `navigator.languages` negotiation with a Settings override persisted
to `store.data.settings.lang`, `data-i18n` attributes for static markup, and a +40% length budget
on every button and rail label (the layout already uses `clamp()` type and wrapping flex rows, so
German and French expansion fit without a new breakpoint).

---

## 11. Accessibility

- **Keyboard-only path.** Complete: `showScreen` focuses the first button of each screen; the card
  is a roving-tabindex grid (`ArrowKeys` + `Enter`); all round actions have single-key bindings; the
  pause dialog is a native `<dialog>` with focus moved to its first action and restored to the
  previously focused element on close.
- **Focus.** `:focus-visible` draws a 3 px `--accent` outline with 2 px offset on every interactive
  element, over both panel and lantern-amber backgrounds.
- **Live regions.** `#live-status` (`role="status"`, polite) carries the phase; `#live-alert`
  (`role="alert"`, assertive, visually hidden) carries calls, rejections, hints, countdown beats and
  the outcome, and is cleared-then-set on a frame boundary so repeated identical text re-announces.
- **Semantics.** Card cells are `role="gridcell"` buttons labelled "row 3 column 2, number 47,
  marked | callable"; the free centre is disabled; the roster and score tables are real lists and
  tables.
- **Captions.** `#captions` mirrors every audio event as text.
- **Contrast.** Body text `#e8ecff` on `#1a2040` and marked cells `#0f1226` on `#ffb454` both clear
  AA; the High contrast setting swaps in pure black/white/gold and drops both key-art images.
- **Reduced motion.** Auto-detected via `prefers-reduced-motion` at first boot, overridable in
  Settings; kills the cell pulse, ball pop and lantern sway and shortens the countdown.
- **Targets.** 44 px minimum on every button, tray item and settings row.
- **Other.** Larger text (120%), left-handed tray (row reversed), four independent volume sliders,
  and a Call speed of "Manual only" for players who want no timer at all.

---

## 12. StarHermit integration

`starhermit.txt` declares `name`, `launch=index.html`, `owner`, `server=server.js`, `cover`,
and one `control.<action>=<Code> | <Label>` line per keyboard action (left/right/up/down, mark,
call, claim, undo, hint, pause, camera, back).

All platform calls go through the shared client `starhermit-sdk.js` (loaded before the game
module) via the thin adapter `js/platform.js`. Without a launch token nothing calls the network
and the game plays exactly as offline.

**Used:**
- **Launch token + renewal.** `StarHermit.init()` reads `#game_token=` (library launch) or
  `#access_token=` (direct sign-in return), strips it from the URL and renews it before expiry.
  If renewal is refused the game shows a "signed out" toast, hides the account line and invite
  button, and keeps playing and saving locally.
- **Sign-in.** On `<id>.starhermit.com` without a token the title shows **Sign in with
  StarHermit** (`StarHermit.signIn()`); it is hidden when signed in and when running locally.
- **Identity.** The title account line shows "Playing as <nickname>" (profile `nickname`, falling
  back to `Player <id prefix>`) plus the cloud sync status; hosted-hall seats use the same name.
- **Cloud save.** The checksummed localStorage doc is mirrored to the `game:<slug>` cloud-save
  slot: remote wins on boot, saves debounce ~2 s, `pagehide`/hidden tab flush with keepalive.
  localStorage stays the offline cache.
- **Settings KV.** Every top-level preference (volumes, mute, theme, graphics, reduced motion,
  high contrast, larger text, left-handed tray, call speed, auto-hint) is patched to the
  per-player settings store when it changes; on boot the stored values override the local ones.
- **Controls.** Keyboard input is routed by `event.code` through `StarHermit.loadBindings()`
  (defaults = the manifest's `control.*` lines). The action-tray key hints and the Help
  "Keyboard" card show the effective bindings.
- **Invite link.** Signed-in players get **Invite a friend** on the title, which copies
  `StarHermit.inviteLink()` to the clipboard with a confirmation toast.
- **Hosted halls via realtime rooms.** With a token, Hosted Play quick-joins (or creates and
  opens) a StarHermit realtime room and connects to `/ws/v1/realtime?roomId=…&access_token=…`.
  The room's host client runs the caller/rounds with the same Session + bots as local play
  (`js/hallnet.js` `HallHost`); guests send their existing mark/claim commands as binary frames
  (guest→host; the relay stamps the 16-byte sender id; host→everyone snapshots). Mid-round
  joiners spectate until the next round; the host posts `POST /rooms/{id}/result` and rounds
  restart on a 15 s grace. Without a token, Hosted Play keeps using the repo's own `server.js`
  hall over `/ws` (local dev only — that protocol is unreachable on-platform).
- **Cover art.** `coverart.png` (1200×675).

The account-control strings (sign-in, invite, toasts, "Playing as") are localized in the nine
locales (`js/sh-strings.js`).

**Not used:** gameplay sessions, matchmaking queues, friend-picker invites, session chat,
platform achievements, leaderboards and replays — `server.js` is a standalone Node host, not a
platform game script, so it declares no achievements, scores or replays and there are no
platform sessions to join. Achievements and personal bests stay local and travel in the cloud save.

---

## 13. Technical architecture

**Layering.** `rules.js` (pure) ← `session.js` (log + undo + replay) ← `game.js` / `server.js`.
The client and the server import the *same* rules and session modules, so a hosted snapshot
deserializes into exactly the state the server holds. `game.js` never mutates `state` directly; it
either calls `Session.dispatch` or replaces `state` wholesale from a snapshot via a read-only
`hostedSessionFacade`.

**Determinism and replay.** `exportReplay()` emits `{schema, rulesVersion, meta, seed, pattern,
parCalls, playerIds, initialHash, commands, hashes, terminal}`. Hashes are FNV-1a over the canonical
serialization, recorded every 20 ticks and at the end. `Session.verifyReplay` re-runs the command
log from `createGame` and rejects on `bad-schema`, `initial-hash-mismatch`, `hash-mismatch`,
`winner-mismatch` or `final-hash-mismatch`. **Copy Replay** on the results screen puts the envelope
on the clipboard (with a `prompt()` fallback).

**Persistence.** One `localStorage` key holds `{payload, checksum}`; a checksum mismatch or any
parse error silently restores defaults rather than throwing. Saved: all settings, `journeyDone`,
`lessonsDone`, `bestScores` per content id, `dailyHistory` per day, achievements, `gamesPlayed`.
Reset progress clears progress only and keeps settings. In hosted mode the same doc is mirrored
to the platform cloud-save slot (zip+base64): remote wins on boot, local writes debounce ~2 s to
a PUT, and `pagehide` flushes pending saves. localStorage remains the offline cache.

**Rendering budget.** Pixel ratio = min(devicePixelRatio, preset cap) × render scale × adaptive
scale, with caps Low 1, Balanced 1.5, High/Ultra 2 (Ultra also ×1.25). Low: no shadows, no post,
canvas MSAA, 12 plain lanterns, still background — `hall-post.js` and its addons are not even
fetched. Balanced: 512² shadows, bloom, grade, FXAA, reflections, 24 lanterns. High: 1024²
shadows, GTAO, SMAA, 40 lanterns. Ultra: 2048² shadows, 16-sample GTAO, 4× MSAA render target.
The composer runs only when a pass needs it and is rebuilt when its key (passes, size, ratio)
changes. Lanterns are one `InstancedMesh` (+ one for caps); the call number is drawn into one
256×256 `CanvasTexture` reused for both `map` and `emissiveMap`. The hall skips rendering while its
holder is collapsed (compact layouts), and the title lanterns stop when the title is hidden. The loop skips entirely while `document.hidden`, and `dt` is clamped to
50 ms so a backgrounded tab cannot jump the sway.

**Failure paths.** No WebGL → an explanatory paragraph in the canvas holder and a fully playable
card. Context lost → `preventDefault()` plus a reload message; progress is already saved. No hall
available → "Hosted play is unavailable right now. Try Practice instead." (hosted mode off or a
rooms failure). Offline `/api/v1` → hosted features degrade to local play; the cloud slot is
skipped entirely without a token. Hosted rooms socket drop mid-round → one reconnect attempt via
`GET /rooms/mine`, then the honest unavailable message; the host leaving closes the hall for
everyone. Missing SFX clip → synth fallback.

**How the e2e test drives the real UI.** `tests/e2e.mjs` serves the repo over an ephemeral port and
drives headless Chrome through `playwright-core`. It only ever clicks visible elements —
`[data-nav=…]`, `#setup-start`, `#card-grid .card-cell[data-cell=…]`, `#btn-call`, `#btn-claim`,
`#btn-undo`, `#btn-hint`, `#btn-pause`, and the modal's Resume / Leave round buttons — and reads the
DOM only to synchronize (which cells carry `.markable`, whether `#btn-claim` is disabled, what
`#live-status` says). Both a 1280×800 desktop context and a fresh 390×844 touch context run the
full flow; any `pageerror` or non-noise `console.error` fails the run.

---

## 14. Testing and acceptance criteria

`npm test` runs 47 `node --test` cases with zero dependencies:

- **`tests/rules.test.js` (16).** RNG determinism; card column ranges, uniqueness and free centre;
  called-set growth; `legalActions` matching the called set; invalid marks and false claims scoring
  −25; every one of the 7 patterns reachable and detected by `patternComplete`; `countLines`;
  score-component arithmetic; `compareResults` tie-break order; `serialize`/`deserialize`/`hashState`
  round-trip and hash stability.
- **`tests/session.test.js` (10).** Identical seed + commands ⇒ identical hashes; tampered mid-run
  and initial hashes detected; undo restores the prior state and a post-undo replay still verifies;
  golden easy/medium/hard sessions terminate with valid winners; all 44 content items pass the
  offline validator; Journey has 40 unique ids and seeds; the daily is stable per day and differs
  across days; challenges validate.
- **`tests/platform.test.js` (7).** Adapter + real SDK with stubbed fetch: fragment token read,
  stripped and decoded; profile nickname (never username) with Bearer; cloud-save round-trip at
  `game:<slug>` with sync status; settings KV load + changed-key PATCH after priming; binding
  overrides and invite link; standalone = zero fetches; sign-in offered on the platform host.
- **`tests/hallnet.test.js` (8).** Frame codec round-trip + caps; socket identity harvest
  (room/roster/whoami); guest 30 msg/s throttle; host seating + bot fill; mid-round spectator →
  next-round seat; forced-identity + bounds validation + idempotent duplicates; authoritative call
  cadence with matching snapshot hash; round-end restart; seat retention across an absent guest.

`npm run validate` runs the same offline validator standalone (44 items, 0 failures): it plays a
perfect player through each stage and asserts the pattern is reachable within 75 calls and that
`parCalls` is not more than 2× off the measured need.

`npm run test:e2e` runs the playthrough described in §13. `node tests/hosted-smoke.mjs` drives
the real UI in Chrome against a mock platform with a launch token (fragment strip, account line,
debounced cloud PUT, zero console errors). `node tests/hall-rooms-smoke.mjs` runs a mock
realtime platform (REST lobby + relay over real sockets) with a `HallHost` host and a guest
client: create/open/quick-join, seating, authoritative calls, guest commands, validation
rejections, duplicate-id suppression, result posting, reconnect seat reclaim, and host-departure
room close.

**QA bar, as checkable statements.**

1. Every mode reachable from the title is playable to a results screen through visible controls
   alone — verified for Practice on desktop and mobile by `e2e.mjs`; Journey, Daily, Challenge and
   Learn share the same `startRound` path and the same Setup screen.
2. A first-time player is taught by the board: Setup states the goal, markable cells pulse, `Hint`
   explains, and three Learn lessons gate on the player performing each action.
3. No console errors or warnings on any screen at either viewport — asserted by `e2e.mjs`, which
   filters only known swiftshader/GPU noise and the expected `/ws` handshake failure of the
   deliberate hosted-offline test.
4. Nothing is cut off at 1280×800, 390×844 portrait or a 500 px-tall landscape: the card, the call
   display and the Call/Claim buttons are visible without horizontal scroll, and safe-area insets
   pad all four edges.
5. Rules, hints, tutorial and bots all read the same `legalActions`, so nothing can advise an
   illegal move.
6. Every round is reproducible from its seed and command log, and the results screen prints both the
   seed and the final hash.

---

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/title-hall.webp` | Title-screen backdrop: receding rows of amber lanterns over a reflective floor, dark centre for the menu column | FLUX.2 klein, 1280×720, seed 87451 (garbled hallucinated text removed with `ffmpeg delogo`, WebP q82, 51 KB) | generated this pass, wired (`#screen-title` background) |
| `assets/results-lantern.webp` | Results banner: a released lantern rising over scattered cards and number balls | FLUX.2 klein, 1024×576, seed 20463 (WebP q82, 27 KB) | generated this pass, wired (`.results-art`) |
| `coverart.png` | StarHermit cover, 1200×675 | prior pass | shipped |
| `icon.png`, `favicon.svg` | Platform icon and tab icon | prior pass | shipped |
| `sfx/ui-lantern-tap.opus`, `ui-menu-select.opus` | `ui` cue variants | MOSS-SFX v2 | shipped |
| `sfx/call-ball-draw.opus`, `call-number-chime.opus` | `call` cue variants | MOSS-SFX v2 | shipped |
| `sfx/mark-paper-stamp.opus`, `mark-ink-dab.opus` | `mark` cue variants | MOSS-SFX v2 | shipped |
| `sfx/invalid-wood-thud.opus`, `invalid-brush-scratch.opus` | `invalid` cue variants | MOSS-SFX v2 | shipped |
| `sfx/line-lantern-glow.opus`, `line-chime-rise.opus` | `line` cue variants | MOSS-SFX v2 | shipped |
| `sfx/win-festival-fanfare.opus`, `win-bingo-bells.opus` | `win` cue variants | MOSS-SFX v2 | shipped |
| `sfx/lose-paper-sigh.opus`, `lose-ember-fade.opus` | `lose` cue variants | MOSS-SFX v2 | shipped |
| `sfx/tick-clock-tap.opus`, `tick-wood-tick.opus` | `tick` countdown variants | MOSS-SFX v2 | shipped |
| `sfx/start-gong-swell.opus` | `go` — round-open swell on the final countdown beat | MOSS-SFX v2, 100 steps | generated this pass, wired |
| `sfx/achieve-bell-bloom.opus` | `achievement` — badge-unlock bloom on results | MOSS-SFX v2, 100 steps | generated this pass, wired |
| `js/three.module.js`, `js/three.core.min.js` | three.js r185 runtime | vendored (MIT) | shipped |
| `js/vendor/three/addons/**` | three.js r185 postprocessing/shaders/RoomEnvironment addons | vendored from `three@0.185.1` (MIT) | shipped |

No 3D model or character animation is generated: the hall is procedural primitives and instanced
spheres by design (pillar 5), and there is no humanoid in the game.

---

## 16. Known limitations

1. **No localization.** English only, `lang="en"` fixed (§10).
2. **Local-player assumptions in offline paths.** `tryMarkCell`, `tryClaim`, `endRound` and parts of
   `showResults` address the local seat as the literal id `'you'` and index `players[0]`. This is
   correct offline (the local seat is always seat 0) and hosted play uses separate code paths, but
   the two conventions have not been unified behind `meId()`.
3. **Invalid-actions row sign.** The results table renders the invalid-actions row through a
   `v >= 0 ? '+' : ''` formatter, so a zero penalty prints "+0"; the deduction itself is correct in
   the total.
4. **Bots do not mis-claim.** Bots only mark and claim correctly, so `claim-too-late` and bot false
   claims are reachable in the rules but essentially never seen in play.
5. **Hosted halls are host-routed rooms with no live-platform verification.** The rooms REST
   shapes, roster/presence pushes, and host-assignment rules follow the platform wiki but are
   parsed defensively (self/host ids come from roster flags or a host whoami echo); only the mock
   platform in `tests/hall-rooms-smoke.mjs` has run them end-to-end. The host tab backgrounding
   stalls the caller for all guests (the relay owns no sim). Friend invites and matchmaking beyond
   quick-join are not implemented.
6. **Deck exhaustion has no ceremony.** If 75 calls pass with no winner the round stays active with
   `call` illegal; the player must leave via Pause. There is no "nobody claimed" results screen.
7. **Achievement counters are session-scoped.** `achievementCtx.linesTotal` and `winStreak` reset on
   reload, so Line Keeper and Steady Flame are effectively per-session.
8. **Hosted replays are not exportable.** Copy Replay is hidden on hosted results because the
   envelope lives on the server.

---

## 17. Design intent not yet implemented

- **Localization (§10).** `js/i18n.js` with the nine required catalogues, `data-i18n` attributes in
  `index.html`, `navigator.languages` negotiation, a Settings language selector persisted in the
  save file, and localized pattern/lesson/stage strings moved out of `content.js`.
- **Unified seat identity.** Route every offline read through `meId()`/`mePlayer()` so the local
  seat is never assumed to be `players[0]`.
- **A no-winner terminal state.** Emit a `deck-exhausted` terminal reason and show a results screen
  for it instead of leaving the round parked.
- **Lifetime achievement counters.** Persist `linesTotal` and `winStreak` in the save file.

## Browser interference

`browser-guard.js` (loaded from `index.html`) suppresses browser UI that gets in the way of play: the right-click context menu, the iOS long-press callout, copy / cut / paste, and page text selection. Text fields (inputs, textareas, selects, contenteditable) keep normal selection, context menu and clipboard behaviour.
