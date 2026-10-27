// The browser build's DOM shell (index.html + css/style.css) as
// starhermit:ui, built every frame: the top bar (the title, the status line
// that names the phase in words, the audio captions) over every screen; the
// title over the lantern-hall key art with the drifting sky lanterns and the
// lantern hero, its nine-button menu, the progress and account lines and the
// Sign in / Invite buttons; Mode Setup; the Journey and Learn lists; the
// round (the objective rail, the call chip with the caller's line, the 5×5
// card, the hint line, the 3D hall under the card on tall desktop windows,
// the Hall roster rail and the action tray); Results with the key-art
// banner, the breakdown, ranking, achievements and the pinned Retry / Copy
// Replay / Continue row; Settings, How to Play, the hosted hall's lobby; the
// pause, Practice, Challenge and reset dialogs; and the toast. The browser's
// media queries are layouts picked by the window's logical size: wide
// (≥ 1024: rails beside the card), stacked (rails above and below) and short
// landscape (≤ 500 tall: narrow rails beside the card, no title during play).
import { frame, openMenu } from "starhermit:engine";
import { bindingLabel, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { OffscreenCanvas } from "starhermit:canvas";
import { CENTER, GRID, PATTERNS, countLines, hashState } from "../js/rules.js";
import { CHALLENGES, JOURNEY_STAGES, LESSONS, THEMES } from "../js/content.js";
import { HALL_SEATS } from "../js/hosted.js";
import * as A from "./app.ts";
import { app, type Stage } from "./app.ts";
import { N, T, shT } from "./i18n.ts";
import * as platform from "./platform.ts";
import { TITLE_LANTERNS, type Look } from "./quality.ts";
import * as render from "./render.ts";
import { ink } from "./style.ts";

// ------------------------------------------------------------------ layout helpers
interface Layout { lw: number; lh: number; sc: number; ox: number; oy: number }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  return { lw: Math.max(1, (f.width - sa.left - sa.right) / sc), lh: Math.max(1, (f.height - sa.top - sa.bottom) / sc), sc, ox: sa.left / sc, oy: sa.top / sc };
}
const lastHeight = new Map<string, number>();
const pr = (): ui.UiPreferences => ui.preferences();
let look: Look | null = null;
export function setLook(l: Look): void { look = l; }
const lux = (): boolean => !!look && look.detailed && !pr().highContrast;
const animated = (): boolean => !!look && look.animated && !pr().reducedMotion;
function textWidth(text: string, style: string | readonly string[], kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: typeof style === "string" ? style : [...style] }).width / pr().scale;
}
const gapV = (n: number): void => { ui.widget("", { role: "none", size: { width: 1, height: n } }); };

interface Btn { id: string; text: string; primary?: boolean; disabled?: boolean; act: () => void; kbd?: string; cls?: string }
function btnClass(b: Btn): string { return b.cls ?? (b.primary ? (lux() ? "primary-lux" : "primary") : (lux() ? "menu-btn-lux" : "menu-btn")); }
const buttonWidth = (b: Btn): number => textWidth(b.text, btnClass(b), "button") + (b.kbd ? textWidth(b.kbd, "kbd") + 16 : 0) + 4;
/** A button `width` wide (null: its text's); a label too long wraps inside; `kbd` a key hint chip. */
function button(b: Btn, width: number | null = null): void {
  const cls = btnClass(b);
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  const s: ui.Style = width != null ? { width } : {};
  if (b.kbd) {
    opts.content = () => ui.row(`${b.id}-face`, () => { ui.label(b.text); ui.style("kbd").label(b.kbd!); }, { spacing: 6, align: "center" });
  } else if (width != null && buttonWidth(b) > width) {
    const inner = Math.max(20, width - 36);
    opts.content = () => { ui.style({ text: { align: "center" } }).paragraph(b.text, inner); };
  }
  if (ui.style(cls, s).id(b.id).button(b.text, opts)) b.act();
}
/** Buttons at their own widths in rows that wrap at `width` (CSS flex-wrap), centred. */
function flow(label: string, list: Btn[], width: number, gap = 12): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, buttonWidth(b));
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, buttonWidth(b) > width ? width : null);
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, width, align: "center" });
}
/** Buttons in rows of equal width (a menu column, or `perRow` a row). */
function menu(label: string, list: Btn[], width: number, perRow = 1, gap = 10): void {
  ui.column(label, () => {
    for (let i = 0; i < list.length; i += perRow) {
      const row = list.slice(i, i + perRow);
      const bw = (width - gap * (perRow - 1)) / perRow;
      ui.row(`${label}-r${i}`, () => { for (const b of row) button(b, bw); }, { spacing: gap });
    }
  }, { spacing: gap, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "body", id?: string, center = false): void {
  if (!text) return;
  const styles: (string | ui.Style)[] = [cls];
  if (center) styles.push({ text: { align: "center" } });
  let u = ui.style(...styles);
  if (id) u = u.id(id);
  if (ui.measureText(text, { style: styles }).width / pr().scale <= width) u.label(text);
  else u.paragraph(text, width);
}
const keyName = (action: string): string => bindingLabel(action, "keyboard") || "—";
/** Markup in the old rich-text keys (<kbd>, <strong>) as plain text. */
const plain = (s: string): string => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  const P = ink(pr().highContrast);
  // The page colour everywhere but the 3D hall's rectangle (last frame's: the scene shows through there).
  const hv = app.screen === "play" ? hallView : null;
  if (hv) {
    draw.rect(0, 0, f.width, hv.y, P.bg);
    draw.rect(0, hv.y + hv.h, f.width, f.height - hv.y - hv.h, P.bg);
    draw.rect(0, hv.y, hv.x, hv.h, P.bg);
    draw.rect(hv.x + hv.w, hv.y, f.width - hv.x - hv.w, hv.h, P.bg);
  } else draw.rect(0, 0, f.width, f.height, P.bg);
  hallView = null;
  const top = topbar(L);
  switch (app.screen) {
    case "title": titleScreen(L, top); break;
    case "setup": setupScreen(L, top); break;
    case "journey": listScreen(L, top, "journey"); break;
    case "learn": listScreen(L, top, "learn"); break;
    case "play": playScreen(L, top); break;
    case "results": resultsScreen(L, top); break;
    case "settings": settingsScreen(L, top); break;
    case "help": helpScreen(L, top); break;
    case "hall": hallScreen(L, top); break;
  }
  dialogs(L);
  toast(L);
  render.setView(app.screen === "play" ? hallView : null, f.width, f.height);
  const opened = app.modal ? app.modalOpened : app.openedFrame;
  if (app.focusNext) {
    const age = f.frame - opened;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}
let hallView: { x: number; y: number; w: number; h: number } | null = null;

/** The top bar: the game's title, the status line and the audio captions. Returns its height. */
function topbar(L: Layout): number {
  const shortLand = L.lh <= 500 && L.lw > L.lh;
  const hideTitle = shortLand && app.screen === "play";
  const r = ui.place("topbar", { anchor: "top-start", x: L.ox, y: L.oy }, () => {
    ui.column("topbar-col", () => {
      if (!hideTitle) ui.style(lux() ? "game-title-lux" : "game-title", shortLand ? { text: { size: 20 } } : {}).id("game-title").heading("Lantern Bingo");
      para(A.textOf(app.status), L.lw - 16, "status-line", "live-status", true);
      para(app.caption ? "♪ " + T(app.caption) : " ", L.lw - 16, "captions", "captions", true);
    }, { width: L.lw, align: "center", spacing: 2, padding: { top: hideTitle ? 4 : 8 } });
  });
  return r.height / L.sc + 4;
}

/** A centred column of content under the top bar, scrolling when taller than the room. */
function page(key: string, L: Layout, top: number, maxW: number, build: (w: number) => void, footer?: (w: number) => void): void {
  const pad = 8;
  const w = Math.min(maxW, L.lw - 2 * pad);
  const fh = footer ? (lastHeight.get(key + "-foot") ?? 60) : 0;
  const avail = L.lh - top - pad - fh;
  const h = lastHeight.get(key) ?? 0;
  const fresh = frame().frame - app.openedFrame <= 5;
  ui.place(`page-${key}`, { anchor: "top-start", x: L.ox, y: L.oy + top }, () => {
    const body = (): void => {
      const r = ui.column(`${key}-body`, () => build(w), { width: w, spacing: 12, align: "center" });
      lastHeight.set(key, r.height / L.sc);
    };
    if (h > avail) ui.scrollArea(`${key}-scroll`, { width: L.lw, height: Math.max(80, avail) }, () => ui.column(`${key}-sc`, body, { width: L.lw - 14, align: "center", padding: { bottom: pad } }), fresh ? { scrollTo: { top: 0 } } : undefined);
    else ui.column(`${key}-outer`, body, { width: L.lw, align: "center" });
    if (footer) {
      const c = ui.column(`${key}-foot`, () => footer(w), { width: L.lw, align: "center", padding: { top: 10, bottom: 8 }, style: "tray" });
      lastHeight.set(key + "-foot", c.height / L.sc);
    }
  });
}
function h2(text: string, w: number, id?: string): void { para(text, w, "h2", id, true); }

// ------------------------------------------------------------------ title
interface SkyLantern { x: number; y: number; depth: number; phase: number; speed: number; hue: number }
let sky: SkyLantern[] = [];
let skySeed = 7;
let skyT = 0;
let skyLast = -1;
const skyRand = (): number => { skySeed = (skySeed * 16807) % 2147483647; return skySeed / 2147483647; };
function skySpawn(anywhere: boolean): SkyLantern {
  const depth = 0.35 + skyRand() * 0.65;
  return { x: skyRand(), y: anywhere ? skyRand() * 1.1 : 1.08 + skyRand() * 0.1, depth, phase: skyRand() * Math.PI * 2, speed: 0.012 + depth * 0.02, hue: skyRand() };
}
let glowSprite: OffscreenCanvas | null = null;
function glow(): OffscreenCanvas {
  if (glowSprite) return glowSprite;
  const c = new OffscreenCanvas(64, 64);
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowSprite = c;
  return c;
}
/** js/title-fx.js: paper lanterns drifting up over the painted hall (dimmed behind the menu column). */
function skyLanterns(x0: number, y0: number, W: number, H: number): void {
  if (!look || pr().highContrast) return;
  const n = Math.round(TITLE_LANTERNS[look.lanterns] * look.budget.title);
  if (sky.length !== n) { skySeed = 7; sky = Array.from({ length: n }, () => skySpawn(true)); }
  const t = frame().time;
  const dt = skyLast < 0 ? 0 : Math.min(0.1, Math.max(0, t - skyLast));
  skyLast = t;
  const moving = animated();
  if (moving) skyT += dt;
  const halo = look.bloom;
  const unit = Math.min(W, H);
  const clip = { clip: { x: x0, y: y0, width: W, height: H } };
  for (let i = 0; i < sky.length; i++) {
    const it = sky[i]!;
    if (moving) {
      it.y -= it.speed * dt;
      if (it.y < -0.1) sky[i] = Object.assign(it, skySpawn(false));
    }
    const sway = Math.sin(skyT * 0.6 + it.phase) * 0.012;
    const x = x0 + (it.x + sway) * W, y = y0 + it.y * H;
    const s = unit * (0.012 + it.depth * 0.022);
    const flicker = 0.85 + 0.15 * Math.sin(skyT * 3.1 + it.phase * 5);
    const nearMenu = Math.abs(it.x + sway - 0.5) < 0.2 ? 0.35 : 1;
    const a = (0.35 + it.depth * 0.55) * flicker * nearMenu;
    const warm = it.hue < 0.7 ? [255, 176, 84] : [255, 120, 70];
    if (halo) draw.image(glow(), x - s * 3.2, y - s * 3.2, s * 6.4, s * 6.4, { ...clip, blend: "add", tint: `rgba(${warm[0]},${warm[1]},${warm[2]},${(0.32 * a).toFixed(3)})` });
    draw.ellipse(x, y, s * 0.8, s, `rgba(${warm[0]! - 60},${warm[1]! - 70},40,${(a * 0.5).toFixed(3)})`, { ...clip, blend: "add" });
    draw.ellipse(x, y, s * 0.68, s * 0.85, `rgba(${warm[0]},${warm[1]},${warm[2]},${(a * 0.55).toFixed(3)})`, { ...clip, blend: "add" });
    draw.ellipse(x, y - s * 0.2, s * 0.35, s * 0.42, `rgba(255,236,190,${(a * 0.7).toFixed(3)})`, { ...clip, blend: "add" });
  }
}
function titleScreen(L: Layout, top: number): void {
  const f = frame();
  const sc = L.sc;
  const shortLand = L.lh <= 500 && L.lw > L.lh;
  // The #screen-title panel: the key art behind its scrim, max 1100 wide.
  const pw = Math.min(1100, L.lw - 16), px = L.ox + (L.lw - pw) / 2, py = L.oy + top, ph = L.lh - top - 8;
  if (!pr().highContrast) {
    draw.box(px * sc, py * sc, pw * sc, ph * sc, "title-wash");
    skyLanterns(px * sc, py * sc, pw * sc, ph * sc);
  }
  const list: Btn[] = [
    { id: "btn-play", text: T("Play"), primary: true, act: () => A.nav("play-quick") },
    { id: "btn-journey", text: T("Journey"), act: () => A.nav("journey") },
    { id: "btn-daily", text: T("Daily"), act: () => A.nav("daily") },
    { id: "btn-practice", text: T("Practice"), act: () => A.nav("practice") },
    { id: "btn-challenge", text: T("Challenge"), act: () => A.nav("challenge") },
    { id: "btn-learn", text: T("Learn"), act: () => A.nav("learn") },
    { id: "btn-hosted", text: T("Hosted Play"), act: () => A.nav("hosted") },
    { id: "btn-settings", text: T("Settings"), act: () => A.nav("settings") },
    { id: "btn-help", text: T("Help"), act: () => A.nav("help") },
  ];
  const acct: Btn[] = [];
  if (!platform.signedIn()) acct.push({ id: "btn-signin", text: shT().signIn, act: A.signIn });
  if (platform.inviteLink()) acct.push({ id: "btn-invite", text: shT().invite, act: A.copyInvite });
  const h = lastHeight.get("title") ?? 0;
  const avail = ph;
  const build = (): void => {
    const r = ui.column("title-body", () => {
      // The lantern hero (its glow pulses with ambient motion on detailed looks).
      const hs = shortLand ? 40 : Math.min(96, Math.max(56, L.lw * 0.1));
      ui.widget("", {
        role: "none", size: { width: hs * 1.6, height: hs * 1.2 },
        draw: (q) => {
          const k = pr().scale;
          const t = f.time;
          const pulse = lux() && animated() ? (Math.sin(t * Math.PI * 2 / 3.2) + 1) / 2 : 0;
          const dy = -4 * k * pulse;
          if (lux()) {
            const gs = hs * k * (0.75 + 0.2 * pulse);
            draw.image(glow(), q.x + q.width / 2 - gs, q.y + q.height / 2 - gs + dy, gs * 2, gs * 2, { blend: "add", tint: `rgba(255,170,70,${(0.35 + 0.3 * pulse).toFixed(3)})` });
          }
          const es = Math.min(250, hs * k);
          draw.text("🏮", q.x + q.width / 2, q.y + (q.height - es * 1.2) / 2 + dy, { size: es, align: "center" });
        },
      });
      const mw = shortLand ? Math.min(600, L.lw * 0.92) : Math.min(340, L.lw * 0.92);
      if (shortLand) menu("title-menu", list, mw, 3, 8);
      else menu("title-menu", list, mw, 1, 10);
      para(A.titleProgress(), Math.min(pw - 24, 600), "muted", "title-progress", true);
      const line = A.accountLine();
      if (line) para(line, Math.min(pw - 24, 600), "muted", "account-line", true);
      if (acct.length) menu("title-account", acct, mw, 1, 10);
    }, { width: pw, align: "center", spacing: shortLand ? 6 : 12, padding: { top: 8, bottom: 8 } });
    lastHeight.set("title", r.height / sc);
  };
  ui.place("page-title", { anchor: "top-start", x: px, y: py }, () => {
    if (h > avail) ui.scrollArea("title-scroll", { width: pw, height: avail }, build);
    else ui.column("title-outer", build, { width: pw, height: avail, justify: "center", align: "center" });
  });
}

// ------------------------------------------------------------------ setup and lists
function setupScreen(L: Layout, top: number): void {
  const ps = app.pendingSetup;
  if (!ps) { A.goTitle(); return; }
  const { stage } = ps;
  page("setup", L, top, 640, (w) => {
    h2(T("Mode Setup"), w, "setup-heading");
    ui.column("setup-details", () => {
      const iw = w - 44;
      para(A.stageTitle(stage), iw, "strong", "setup-name");
      para(T("Pattern: {name} — {desc}", { name: A.patternName(stage.pattern), desc: A.patternDesc(stage.pattern) }), iw);
      para(T(stage.bots === 1 ? "Opponents: {n} lantern" : "Opponents: {n} lanterns", { n: stage.bots }) + " · " + T("Expected duration: ~{n} min", { n: stage.expectedMinutes ?? 4 }), iw);
      para(T("Par: {n} calls", { n: stage.parCalls }) + " · " + T("Seed: {seed}", { seed: stage.seed }) + " · " + T("Content v{v}", { v: stage.version || 1 }), iw);
      para(stage.ranked ? T("Ranked result.") : T("Unranked practice — undo allowed, no rating effect."), iw);
      if (stage.constraint) para(T("Constraint: {text}", { text: T(stage.constraint) }), iw);
    }, { style: lux() ? "panel-lux" : "panel", width: w, spacing: 12 });
    flow("setup-row", [
      { id: "btn-start", text: T("Start"), primary: true, act: () => { A.cue("ui"); A.startRound(ps.mode, stage); } },
      { id: "btn-setup-back", text: T("Back"), act: () => A.nav("title") },
    ], w);
  });
}
function listScreen(L: Layout, top: number, kind: "journey" | "learn"): void {
  page(kind, L, top, 640, (w) => {
    h2(T(kind === "journey" ? "Journey" : "Learn"), w, `${kind}-heading`);
    const items: { id: string; label: string; aria: string; cls: string; locked: boolean; act: () => void }[] = [];
    if (kind === "journey") {
      const done = new Set(platform.progress().journeyDone);
      const upTo = A.journeyUnlockedUpTo();
      (JOURNEY_STAGES as Stage[]).forEach((s, i) => {
        const locked = i > upTo;
        const label = `${s.mastery ? "★ " : ""}${A.stageTitle(s)} — ${A.patternName(s.pattern)}`;
        items.push({
          id: `stage-${i}`, label, aria: locked ? T("{stage} locked", { stage: A.stageTitle(s) }) : label,
          cls: done.has(s.id) ? "list-done" : s.mastery ? "list-mastery" : "list-btn", locked,
          act: () => { A.cue("ui"); A.openSetup("journey", s); },
        });
      });
    } else {
      const done = new Set(platform.progress().lessonsDone);
      (LESSONS as { id: string; title: string }[]).forEach((l, i) => {
        const label = T(l.title) + (done.has(l.id) ? " ✓" : "");
        items.push({ id: `lesson-${i}`, label, aria: label, cls: done.has(l.id) ? "list-done" : "list-btn", locked: false, act: () => A.startLesson(l as never) });
      });
    }
    const gap = 10;
    const lw = w - 14;
    const cols = Math.max(1, Math.floor((lw + gap) / (150 + gap)));
    const cw = (lw - gap * (cols - 1)) / cols;
    const body = (): void => {
      const r = ui.column(`${kind}-items`, () => {
        for (let i = 0; i < items.length; i += cols) {
          ui.row(`${kind}-r${i}`, () => {
            for (let j = i; j < Math.min(items.length, i + cols); j++) {
              const it = items[j]!;
              const inner = cw - 20;
              if (ui.style(it.cls, { width: cw }).id(it.id).button(it.aria, {
                ...(it.locked ? { disabled: true } : {}),
                content: () => { ui.style({ text: { align: "center" } }).paragraph(it.label, inner); },
              })) it.act();
            }
          }, { spacing: gap, align: "stretch" });
        }
      }, { spacing: gap, width: lw });
      lastHeight.set(`${kind}-items`, r.height / L.sc);
    };
    const maxH = Math.max(160, L.lh * 0.6);
    const ih = lastHeight.get(`${kind}-items`) ?? 0;
    const fresh = frame().frame - app.openedFrame <= 5;
    if (ih > maxH) ui.scrollArea(`${kind}-scroll`, { width: w, height: maxH }, body, fresh ? { scrollTo: { top: 0 } } : undefined);
    else body();
    flow(`${kind}-back`, [{ id: `btn-${kind}-back`, text: T("Back"), act: () => A.nav("title") }], w);
  });
}

// ------------------------------------------------------------------ the round
type PlayKind = "wide" | "stacked" | "land";
function playKind(L: Layout): PlayKind {
  // Short landscape (the old ≤ 500 px breakpoint, and landscape windows too short for the stacked
  // rails above and below a 44 px-cell card) keeps the rails beside the card.
  if (L.lw > L.lh && (L.lh <= 500 || (L.lw < 1024 && L.lh < 720))) return "land";
  return L.lw >= 1024 ? "wide" : "stacked";
}
/** The objective rail's lines. */
function objective(w: number, condensed: boolean): void {
  const s = app.session!;
  const st = s.state;
  const me = A.mePlayer(st);
  const sb = s.score(me.id);
  const head = T("Target: {pattern}", { pattern: A.patternName(st.pattern) });
  if (condensed) {
    para(head, w, "h4", "objective-text");
    para([A.patternDesc(st.pattern), T("Calls: {calls} · Lines: {lines} · Marks: {marks}", { calls: st.callIndex + 1, lines: countLines(me.marks), marks: me.marksMade }),
      T("Score so far: {total} (invalid −{penalty})", { total: sb.total, penalty: sb.invalidPenalty })].join("  ·  "), w, "muted", "progress-text");
    return;
  }
  para(head, w, "h4", "objective-text");
  para(A.patternDesc(st.pattern), w, "muted", "pattern-desc");
  para(T("Calls: {calls} · Lines: {lines} · Marks: {marks}", { calls: st.callIndex + 1, lines: countLines(me.marks), marks: me.marksMade }), w, "body", "progress-text");
  para(T("Score so far: {total} (invalid −{penalty})", { total: sb.total, penalty: sb.invalidPenalty }), w, "muted", "score-preview");
}
/** The Hall rail: each lantern's line count, the winner in green. */
function roster(w: number, condensed: boolean): void {
  const s = app.session!;
  const st = s.state;
  const me = A.mePlayer(st);
  para(T("Hall"), w, "h4", "roster-heading");
  const rows = st.players.map((p) => {
    const n = countLines(p.marks);
    return { id: p.id, name: p.id === me.id ? T("You") : A.seatName(p.id), lines: T(n === 1 ? N("{n} line") : N("{n} lines"), { n }), win: st.winner === p.id };
  });
  if (condensed) {
    para(rows.map((r) => `${r.name} ${r.lines}`).join("   "), w, "roster-name", "roster");
    return;
  }
  ui.column("roster", () => {
    for (const r of rows) {
      ui.row(`roster-${r.id}`, () => {
        para(r.name, w * 0.6, r.win ? "winner" : "roster-name");
        ui.spacer();
        ui.style(r.win ? "winner" : "roster-name").label(r.lines);
      }, { width: w, align: "center" });
    }
  }, { spacing: 6, width: w });
}
function rail(id: string, x: number, y: number, w: number, h: number | null, build: (w: number) => void): number {
  const pad = 12;
  const ch = lastHeight.get(id) ?? 0;
  const r = ui.place(id, { anchor: "top-start", x, y }, () => {
    const inner = (): void => {
      const c = ui.column(`${id}-in`, () => build(w - 2 * pad - (h != null && ch > h ? 12 : 0)), { spacing: 8 });
      lastHeight.set(id, c.height / pr().scale + 2 * pad);
    };
    ui.column(`${id}-col`, () => {
      if (h != null && ch > h) ui.scrollArea(`${id}-scroll`, { width: w - 2 * pad, height: h - 2 * pad }, inner);
      else inner();
    }, { style: lux() ? "rail-lux" : "rail", width: w, ...(h != null && ch > h ? { height: h } : {}) });
  }, { width: w });
  return r.height / pr().scale;
}
function trayButtons(): Btn[] {
  const hosted = app.mode === "hosted";
  const list: Btn[] = [
    { id: "btn-call", text: T("Call"), kbd: keyName("call"), disabled: hosted || !A.canAct(), act: () => { A.cue("ui"); A.doCall(); } },
    { id: "btn-claim", text: T("Claim"), kbd: keyName("claim"), primary: true, disabled: !A.claimReady() || !A.canAct(), act: A.claim },
  ];
  if (!hosted && A.undoShown()) list.push({ id: "btn-undo", text: T("Undo"), kbd: keyName("undo"), act: A.undo });
  list.push({ id: "btn-hint", text: T("Hint"), kbd: keyName("hint"), act: A.hint });
  list.push({ id: "btn-pause", text: T("Pause"), kbd: keyName("pause"), act: () => { A.cue("ui"); A.pauseGame(); } });
  return platform.options.leftHanded ? list.reverse() : list;
}
function playScreen(L: Layout, top: number): void {
  const s = app.session;
  if (!s) { A.goTitle(); return; }
  const kind = playKind(L);
  const pad = kind === "land" ? 4 : 8;
  // The action tray (bottom, sticky on phones).
  const trayW = L.lw - 2 * pad;
  const th = lastHeight.get("tray") ?? 64;
  const tr = ui.place("tray", { anchor: "top-start", x: L.ox, y: L.oy + L.lh - th }, () => {
    ui.column("tray-col", () => flow("tray-row", trayButtons(), trayW, kind === "land" ? 6 : 10), { width: L.lw, align: "center", padding: { top: kind === "land" ? 4 : 10, bottom: 4 }, style: L.lw <= 640 ? "tray" : undefined });
  });
  lastHeight.set("tray", tr.height / L.sc);
  let x0 = pad, x1 = L.lw - pad, y0 = top, y1 = L.lh - th - pad;
  if (kind === "wide" || kind === "land") {
    const rw = kind === "wide" ? Math.min(220, Math.max(150, L.lw * 0.17)) : Math.min(170, Math.max(120, L.lw * 0.17));
    const h = y1 - y0;
    rail("rail-left", L.ox + x0, L.oy + y0, rw, h, (w) => objective(w, false));
    rail("rail-right", L.ox + x1 - rw, L.oy + y0, rw, h, (w) => roster(w, false));
    x0 += rw + pad; x1 -= rw + pad;
  } else {
    const w = x1 - x0;
    const oh = rail("rail-left", L.ox + x0, L.oy + y0, w, null, (iw) => objective(iw, true));
    y0 += oh + pad;
    const rh = lastHeight.get("rail-right") ?? 60;
    rail("rail-right", L.ox + x0, L.oy + y1 - rh, w, null, (iw) => roster(iw, true));
    y1 -= rh + pad;
  }
  playfield(L, x0, y0, x1 - x0, y1 - y0, kind);
}
/** The call chip, the card, the hint line and (tall desktop) the hall below. */
function playfield(L: Layout, x: number, y: number, w: number, h: number, kind: PlayKind): void {
  const s = app.session!;
  const st = s.state;
  const me = A.mePlayer(st);
  const gap = kind === "land" ? 4 : 10;
  const bannerH = kind === "land" ? 40 : 52;
  const hintH = 26;
  const avail = h - bannerH - hintH - gap * 2;
  const tall = kind === "wide" && L.lh > 900;
  const cardMax = kind === "land" ? Math.min(480, L.lh - 175) : Math.min(480, L.lh - 300);
  const cgap = kind === "land" ? 4 : 6;
  // Cells keep the old 44 px minimum touch size (36 px on short landscape screens).
  const card = Math.max(5 * (kind === "land" ? 36 : 44) + 4 * cgap, Math.min(w, cardMax, avail));
  const cell = (card - cgap * 4) / 5;
  const cx = x + (w - card) / 2;
  const sc = L.sc;
  // The call banner: the ball chip and the caller's line.
  const v = st.currentCall;
  const timer = app.mode === "hosted" ? "" : app.callAuto > 0 ? T("(auto in {n}s)", { n: Math.round(app.callAuto / 1000) }) : app.phase === "active" ? T("(manual calls)") : "";
  ui.place("call-banner", { anchor: "top-start", x: L.ox + x, y: L.oy + y }, () => {
    ui.row("call-row", () => {
      const cs = bannerH - 4;
      ui.widget(v ? T("Called {n}", { n: v }) : "—", {
        role: "image", size: { width: cs, height: cs },
        draw: (q, ws) => {
          const k = ws.scale;
          const P = ink(ws.highContrast);
          const r = q.width / 2;
          if (lux()) {
            // The old bloom-look glow (box-shadow 0 0 22px) as an additive halo behind the chip.
            if (look?.bloom) draw.image(glow(), q.x - r * 0.6, q.y - r * 0.6, q.width + r * 1.2, q.height + r * 1.2, { blend: "add", tint: "rgba(255,180,84,0.55)" });
            // The lit-paper ball (radial #fff3d6 → #ffc56e → #e8922f from 35 % / 30 %) as layered discs:
            // a fully rounded draw.box gradient draws dark on the web runtime.
            draw.circle(q.x + r, q.y + r + 3 * k, r, "#00000040");
            draw.circle(q.x + r, q.y + r, r, "#e8922f");
            draw.circle(q.x + r * 0.9, q.y + r * 0.85, r * 0.8, "#f6aa4c");
            draw.circle(q.x + r * 0.8, q.y + r * 0.72, r * 0.55, "#ffc56e");
            draw.image(glow(), q.x + r * 0.7 - r * 0.45, q.y + r * 0.6 - r * 0.45, r * 0.9, r * 0.9, { tint: "#fff3d6" });
          }
          else draw.circle(q.x + r, q.y + r, r, P.accent2);
          const txt = v ? String(v) : "—";
          const size = (kind === "land" ? 18 : 24) * k * pr().textScale;
          const m = draw.measureText(txt, { size, weight: "800" });
          draw.text(txt, q.x + r, q.y + r - m.height / 2, { size, weight: "800", color: P.markedInk, align: "center" });
        },
      });
      if (timer) ui.style("timer", kind === "land" ? { text: { size: 16 } } : {}).id("call-timer").label(timer);
    }, { width: w, align: "center", justify: "center", spacing: 14, height: bannerH });
  });
  // The card.
  const gy = y + bannerH + gap;
  const mk = A.markable();
  const auto = platform.options.autoHint;
  const hints = patternCells(st.pattern);
  const fontSize = kind === "land" ? Math.min(18, Math.max(13, L.lw * 0.02)) : Math.min(26, Math.max(16, L.lw * 0.026));
  ui.place("card", { anchor: "top-start", x: L.ox + cx, y: L.oy + gy }, () => {
    ui.grid(T("Your bingo card"), () => {
      for (let i = 0; i < 25; i++) {
        const r = Math.floor(i / GRID) + 1, c = (i % GRID) + 1;
        const n = me.card[i]!;
        const marked = !!me.marks[i];
        const callable = !marked && mk.has(i);
        const label = i === CENTER ? T("row {r} column {c}", { r, c })
          : marked ? T("row {r} column {c}, number {n}, marked", { r, c, n }) : callable ? T("row {r} column {c}, number {n}, callable", { r, c, n }) : T("row {r} column {c}, number {n}", { r, c, n });
        const res = ui.id(`cell-${i}`).widget(label, {
          role: "button", size: { width: cell, height: cell }, disabled: i === CENTER,
          draw: (q, ws) => drawCell(q, ws, i, n, marked, callable && auto, hints.has(i), fontSize),
        });
        if (res.focused) app.focusCell = i;
        if (res.activated) A.markCell(i);
      }
    }, { columns: [cell, cell, cell, cell, cell], gap: cgap });
  });
  // The hint line.
  const hy = gy + card + gap;
  ui.place("hint-line", { anchor: "top-start", x: L.ox + x, y: L.oy + hy }, () => {
    ui.column("hint-col", () => para(A.textOf(app.hint), w, "hint-text", "hint-text", true), { width: w, align: "center" });
  });
  // The countdown over the card (a UI label: draw text stops at 256 window px).
  if (app.countdown) {
    const size = Math.min(128, Math.max(64, L.lw * 0.14));
    ui.place("countdown", { anchor: "top-start", x: L.ox + cx, y: L.oy + gy }, () => {
      ui.column("countdown-col", () => ui.style("countdown", { text: { size } }).id("countdown").label(T(app.countdown!)), { width: card, height: card, align: "center", justify: "center" });
    });
  }
  // The decorative hall under the card (tall desktop windows only), 4:3, at most 640 wide.
  if (tall) {
    const hy2 = hy + hintH + gap;
    const room = y + h - hy2;
    const hw = Math.min(w, 640, room * 4 / 3);
    if (hw >= 160) {
      const hh = hw * 3 / 4;
      const hx = x + (w - hw) / 2;
      hallView = { x: (L.ox + hx) * sc, y: (L.oy + hy2) * sc, w: hw * sc, h: hh * sc };
      // The 3D view shows through: mask its corners to the old 14 px radius.
      const P = ink(pr().highContrast);
      cornerMask(hallView, 14 * sc, P.bg);
    }
  }
}
/** Covers a view's four corners outside a rounded rectangle (the old overflow: hidden radius). */
function cornerMask(v: { x: number; y: number; w: number; h: number }, r: number, color: string): void {
  const steps = 6;
  const corner = (cx: number, cy: number, ox: number, oy: number, a0: number): void => {
    const pts: [number, number][] = [[ox, oy]];
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (i / steps) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    draw.polygon(pts, color);
  };
  corner(v.x + r, v.y + r, v.x, v.y, Math.PI);
  corner(v.x + v.w - r, v.y + r, v.x + v.w, v.y, -Math.PI / 2);
  corner(v.x + v.w - r, v.y + v.h - r, v.x + v.w, v.y + v.h, 0);
  corner(v.x + r, v.y + v.h - r, v.x, v.y + v.h, Math.PI / 2);
}
const PATTERN_CELLS: Record<string, number[]> = (() => {
  const diag = [0, 1, 2, 3, 4].map((i) => i * GRID + i).concat([0, 1, 2, 3, 4].map((i) => (GRID - 1 - i) * GRID + i));
  const frameCells: number[] = [];
  for (let i = 0; i < 25; i++) { const r = Math.floor(i / GRID), c = i % GRID; if (r === 0 || r === 4 || c === 0 || c === 4) frameCells.push(i); }
  return { corners: [0, 4, 20, 24], frame: frameCells, diagonal: diag, "x-shape": diag };
})();
/** The target pattern's cells, faintly ringed (corners, frame, diagonals). */
function patternCells(pattern: string): Set<number> { return new Set(PATTERN_CELLS[pattern] ?? []); }

function drawCell(q: ui.Rect, s: ui.WidgetState, i: number, n: number, marked: boolean, pulse: boolean, inPattern: boolean, font: number): void {
  const k = s.scale;
  const P = ink(s.highContrast);
  const rad = 10;
  const free = i === CENTER;
  const fancy = lux() && !s.highContrast;
  if (fancy) {
    let bg: ui.Fill;
    let shadow: ui.Shadow[] = [{ y: 1, color: "#ffffff29", inset: true }, { y: -3, color: "#00000047", inset: true }, { y: 3, blur: 8, color: "#00000059" }];
    if (marked) {
      bg = { type: "radial", center: { x: 0.5, y: 0.35 }, stops: [{ color: "#ffe6b0" }, { color: "#ffc56e", at: 0.45 }, { color: "#f0a042" }] };
      shadow = [{ y: 1, color: "#ffffff80", inset: true }, { y: -3, color: "#96500a59", inset: true }, look?.bloom ? { blur: 16, color: "#ffb4548c" } : { y: 3, blur: 8, color: "#00000059" }];
    } else if (free) bg = { type: "radial", center: { x: 0.5, y: 0.4 }, stops: [{ color: "#6b3a2a" }, { color: "#4a2620", at: 0.7 }, { color: "#3a1d1a" }] };
    else if (s.hovered) bg = { type: "linear", angle: 165, stops: [{ color: "#4b62a3" }, { color: P.panel3, at: 0.6 }, { color: "#2d3e70" }] };
    else bg = { type: "linear", angle: 165, stops: [{ color: "#3a4d86" }, { color: P.panel2, at: 0.55 }, { color: "#24315a" }] };
    draw.box(q.x, q.y, q.width, q.height, { radius: rad, background: bg, shadow });
  } else {
    const bg = marked ? P.accent2 : s.hovered ? P.panel3 : P.panel2;
    draw.roundRect(q.x, q.y, q.width, q.height, rad * k, bg);
  }
  if (inPattern && !marked) draw.strokeRoundRect(q.x + 1.5 * k, q.y + 1.5 * k, q.width - 3 * k, q.height - 3 * k, rad * k, "#ffd47a59", 3 * k);
  if (pulse) {
    const t = s.reducedMotion || pr().reducedMotion ? 0 : (1 - Math.cos(frame().time * Math.PI * 2 / 1.2)) / 2;
    const col = mix(P.accent2, P.accent, t);
    draw.strokeRoundRect(q.x - 1.5 * k, q.y - 1.5 * k, q.width + 3 * k, q.height + 3 * k, rad * k, col, 3 * k);
  }
  const color = marked ? P.markedInk : P.ink;
  const cx = q.x + q.width / 2, cy = q.y + q.height / 2;
  if (marked) draw.strokeCircle(cx, cy, q.width * 0.19, "#0f12268c", 3 * k);
  const text = free ? T("FREE") : String(n);
  let size = (free ? font * 0.7 : font) * k * pr().textScale;
  const maxW = q.width - 6 * k;
  let m = draw.measureText(text, { size, weight: "700", letterSpacing: free ? k : 0 });
  if (m.width > maxW) { size *= maxW / m.width; m = draw.measureText(text, { size, weight: "700", letterSpacing: free ? k : 0 }); }
  draw.text(text, cx, cy - m.height / 2, { size, weight: "700", color, align: "center", letterSpacing: free ? k : 0, ...(fancy && !marked ? { shadow: { color: "#00000073", x: 0, y: k } } : {}) });
  // The free centre is a disabled (pre-marked) button: drawn at the old 45 % opacity over the page.
  if (free) draw.roundRect(q.x - 1, q.y - 1, q.width + 2, q.height + 2, rad * k, P.bg + "8c");
}
function mix(a: string, b: string, t: number): string {
  const p = (h: string, o: number): number => parseInt(h.slice(1 + o, 3 + o), 16);
  const c = (o: number): number => Math.round(p(a, o) + (p(b, o) - p(a, o)) * t);
  return `rgb(${c(0)},${c(2)},${c(4)})`;
}

// ------------------------------------------------------------------ results
function resultsScreen(L: Layout, top: number): void {
  const res = app.results;
  const s = app.session;
  if (!res || !s) { A.goTitle(); return; }
  const st = s.state;
  const myId = A.meId() || st.players[0]!.id;
  const sb = s.score(myId);
  const won = st.winner === myId;
  const shortLand = L.lh <= 500 && L.lw > L.lh;
  page("results", L, top, 900, (w) => {
    h2(T("Results"), w, "results-heading");
    const lb = A.leaderboardLine();
    if (lb) para(lb, w, "results-lb", "results-lb", true);
    if (!shortLand && !pr().highContrast) {
      const aw = Math.min(w, 640);
      ui.widget("", { role: "none", size: { width: aw, height: aw * 9 / 16 }, draw: (q) => draw.box(q.x, q.y, q.width, q.height, "results-art") });
    }
    const pw = Math.min(w, 640);
    const iw = pw - 44;
    ui.column("results-body", () => {
      const headline = won ? T("🏮 Bingo! You lit the hall.") : st.winner ? T("{name} claimed first.", { name: A.seatName(st.winner) }) : T("Round ended.");
      para(headline, iw, "h3", "results-headline");
      if (res.hosted) para(T("Authoritative result from the hall host") + " · " + T("Reason: {reason}", { reason: A.hostedReason() }), iw, "muted");
      else para(T("Reason: {reason}", { reason: A.reasonText(st.terminalReason) }) + " · " + T("Seed {seed}", { seed: st.seed }) + " · Hash " + hashState(st), iw, "muted");
      const me = st.players.find((p) => p.id === myId)!;
      const rows: [string, number][] = res.hosted
        ? [[T("Pattern bonus"), sb.patternBase], [T("Line bonus"), sb.lineBonus], [T("Marks"), sb.marksScore], [T("Invalid actions"), -sb.invalidPenalty]]
        : [[T("Pattern bonus"), sb.patternBase], [T("Line bonus ({n} lines)", { n: sb.lines }), sb.lineBonus], [T("Marks ({n})", { n: me.marksMade }), sb.marksScore],
          [T("Speed bonus (par {par}, used {used})", { par: st.parCalls, used: sb.callsUsed }), sb.speedBonus], [T("Invalid actions"), -sb.invalidPenalty]];
      table("score", iw, rows.map(([k, v]) => [k, (res.hosted ? (k === T("Invalid actions") ? "−" + Math.abs(v) : "+" + v) : (v >= 0 ? "+" : "") + v)]), [T("Total"), String(sb.total)]);
      para(T("Ranking"), iw, "h4");
      table("ranking", iw, s.ranking().map((id, i) => [`${i + 1}. ${id === myId ? T("You") : A.seatName(id)}`, String(s.score(id).total)]), null);
      if (res.unlocked.length) {
        para(T("Achievements unlocked"), iw, "h4");
        ui.row("achievements", () => { for (const a of res.unlocked) ui.style("ach-chip").label("🏅 " + T(a.name)); }, { spacing: 8 });
      }
      if (!res.hosted) {
        para(T("Next"), iw, "h4");
        para(T(res.recommendation), iw, "muted", "results-next-line");
      }
    }, { style: lux() ? "panel-lux" : "panel", width: pw, spacing: 8 });
  }, (w) => {
    const btns: Btn[] = [];
    if (!res.hosted) btns.push({ id: "btn-retry", text: T("Retry"), primary: true, act: A.retry }, { id: "btn-replay", text: T("Copy Replay"), act: A.copyReplay });
    btns.push({ id: "btn-next", text: A.nextLabel(), act: A.resultsNext });
    flow("results-row", btns, w);
  });
}
function table(id: string, w: number, rows: string[][], total: string[] | null): void {
  ui.column(id, () => {
    rows.forEach((r, i) => ui.row(`${id}-${i}`, () => { para(r[0]!, w * 0.75, "body"); ui.spacer(); ui.style("body").label(r[1]!); }, { style: "score-row", width: w, align: "center" }));
    if (total) ui.row(`${id}-total`, () => { ui.style("score-total").label(total[0]!); ui.spacer(); ui.style("score-total").id(`${id}-total-v`).label(total[1]!); }, { width: w, align: "center", padding: { start: 8, end: 8, top: 4 } });
  }, { spacing: 0, width: w });
}

// ------------------------------------------------------------------ settings, help, hall
function group(id: string, title: string, w: number, build: (inner: number) => void): void {
  ui.column(id, () => { para(title, w - 30, "legend"); build(w - 30); }, { style: "group", width: w, spacing: 8 });
}
function selectRow(id: string, label: string, inner: number, cur: number, options: string[], onPick: (i: number) => void): void {
  ui.row(`${id}-row`, () => {
    para(label, Math.max(60, inner * 0.38));
    ui.spacer();
    const next = ui.style({ width: Math.min(240, inner * 0.6) }).id(id).select(label, cur, options);
    if (next !== cur) onPick(next);
  }, { width: inner, align: "center", spacing: 10 });
}
function settingsScreen(L: Layout, top: number): void {
  const o = platform.options;
  page("settings", L, top, 640, (w) => {
    h2(T("Settings"), w, "settings-heading");
    ui.column("settings-form", () => {
      const gw = w - 44;
      group("set-audio", T("Audio"), gw, (inner) => {
        para(T("Volumes, mute, graphics quality, language, reduced motion, high contrast and text size are in the StarHermit Options."), inner, "muted");
        flow("set-options", [{ id: "btn-options", text: T("Open Options"), act: () => { A.cue("ui"); openMenu(); } }], inner);
      });
      group("set-look", T("Theme"), gw, (inner) => {
        const ids = THEMES.map((t) => t.id);
        selectRow("set-theme", T("Theme"), inner, Math.max(0, ids.indexOf(o.theme)), THEMES.map((t) => T(t.name)), (i) => {
          platform.setOption("theme", ids[i]!);
          if (app.session && app.mode !== "hosted") render.startRound(app.stage?.theme || ids[i]!);
        });
      });
      group("set-a11y", T("Accessibility & Controls"), gw, (inner) => {
        const lh = ui.id("set-left").checkbox(T("Left-handed action tray"), o.leftHanded);
        if (lh !== o.leftHanded) platform.setOption("leftHanded", lh);
        const speeds = [3000, 5000, 8000, 0];
        selectRow("set-speed", T("Call speed"), inner, Math.max(0, speeds.indexOf(o.callSpeed)), [T("Fast (3s)"), T("Normal (5s)"), T("Relaxed (8s)"), T("Manual only")], (i) => platform.setOption("callSpeed", speeds[i]!));
        const ah = ui.id("set-autohint").checkbox(T("Hint markable cells"), o.autoHint);
        if (ah !== o.autoHint) { platform.setOption("autoHint", ah); A.syncHall(); }
        flow("set-keys", [{ id: "btn-rebind", text: T("Change keys and buttons"), act: () => { A.cue("ui"); requestRebind(); } }], inner);
      });
      flow("set-row", [
        { id: "btn-reset", text: T("Reset progress"), act: () => { A.cue("ui"); A.openModal("reset", "btn-reset-cancel"); } },
        { id: "btn-settings-done", text: T("Done"), primary: true, act: () => A.backFromSub("settings") },
      ], gw);
    }, { style: lux() ? "panel-lux" : "panel", width: w, spacing: 12 });
  });
}
const HELP_CARDS: [string, string][] = [
  [N("Mark calls"), N("Numbers are drawn one at a time and shown on the lantern ball. If a called number is on your card, select that cell to mark it (<kbd>Enter</kbd> or tap).")],
  [N("Complete the pattern"), N("Each round names a target pattern — a line, corners, a frame, or the full card. The objective panel always shows the current target.")],
  [N("Claim first"), N("When your marks complete the target pattern, press <strong>Claim</strong> (<kbd>C</kbd>) before the other lanterns do. False claims cost score.")],
  [N("Keyboard"), ""],
  [N("Scoring"), N("Pattern 1000 · each line +50 · each mark +10 · speed bonus under par · invalid action −25. Ties break on completion, fewer invalid actions, then faster claim.")],
  [N("Fair play"), N("Every round is seeded and replayable. Daily seeds are fixed per UTC day and identical for everyone.")],
];
function helpScreen(L: Layout, top: number): void {
  page("help", L, top, 900, (w) => {
    h2(T("How to Play"), w, "help-heading");
    const gap = 12;
    const iw = w - 44;
    const cols = Math.max(1, Math.floor((iw + gap) / (220 + gap)));
    const cw = (iw - gap * (cols - 1)) / cols;
    ui.column("help-cards", () => {
      for (let i = 0; i < HELP_CARDS.length; i += cols) {
        ui.row(`help-r${i}`, () => {
          for (let j = i; j < Math.min(HELP_CARDS.length, i + cols); j++) {
            const [hd, body] = HELP_CARDS[j]!;
            const text = body ? plain(T(body)) : T("Arrow keys move between cells, {mark} marks ({call} marks a focused cell, otherwise calls), {claim} claim, {undo} undo in Practice, {hint} hint, {pause} pause, {camera} reset camera, {back} back.", {
              mark: keyName("mark"), call: keyName("call"), claim: keyName("claim"), undo: keyName("undo"), hint: keyName("hint"), pause: keyName("pause"), camera: keyName("camera"), back: keyName("back"),
            });
            ui.column(`help-${j}`, () => { para(T(hd), cw - 28, "h3"); para(text, cw - 28, "body"); }, { style: "rule-card", width: cw, spacing: 6 });
          }
        }, { spacing: gap, align: "stretch" });
      }
    }, { style: lux() ? "panel-lux" : "panel", width: w, spacing: gap });
    flow("help-back", [{ id: "btn-help-back", text: T("Back"), act: () => A.backFromSub("help") }], w);
  });
}
function hallScreen(L: Layout, top: number): void {
  const h = app.hall;
  page("hall", L, top, 640, (w) => {
    h2(T("Hosted Play"), w, "hall-heading");
    ui.column("hall-body", () => {
      const iw = w - 44;
      if (!platform.signedIn()) {
        para(T("Hosted play is unavailable right now. Try Practice instead."), iw);
        flow("hall-signin", [{ id: "btn-hall-signin", text: shT().signIn, primary: true, act: A.signIn }], iw);
      } else if (!h) {
        para(A.textOf(app.status), iw, "muted", "hall-status");
      } else {
        para(T("Hall"), iw, "h4");
        for (const [i, p] of h.players.entries()) para(`${p.name}${p.you ? " (" + T("You") + ")" : ""}`, iw, "body", `hall-player-${i}`);
        para(T("{n} of {max} seats taken — empty seats play as lanterns.", { n: h.players.length, max: HALL_SEATS }), iw, "muted");
        if (h.isHost) flow("hall-start", [{ id: "btn-hall-start", text: T("Start round"), primary: true, disabled: h.phase !== "lobby", act: () => void A.startHall() }], iw);
        else para(T("Waiting for the host to start the round…"), iw, "muted", "hall-wait");
      }
    }, { style: lux() ? "panel-lux" : "panel", width: w, spacing: 10 });
    flow("hall-back", [{ id: "btn-hall-back", text: T("Back"), act: () => { A.leaveHosted(); A.nav("title"); } }], w);
  });
}

// ------------------------------------------------------------------ dialogs
function dialogs(L: Layout): void {
  const m = app.modal;
  if (!m) return;
  const w = Math.min(560, L.lw * 0.92) - 48;
  const fresh = frame().frame - app.modalOpened <= 1;
  let open = true;
  const body = (title: string, text: string, btns: Btn[]): void => {
    para(title, w, "h2", "modal-title", true);
    if (text) para(text, w, "body", "modal-body", true);
    gapV(8);
    flow("modal-actions", btns, w);
  };
  if (m === "pause") {
    open = ui.dialog(T("Paused"), "", true, () => body(T("Paused"), T("Take your time. The hall waits."), [
      { id: "btn-resume", text: T("Resume"), primary: true, act: () => { A.cue("ui"); A.resumeGame(); } },
      { id: "btn-pause-settings", text: T("Settings"), act: () => { A.cue("ui"); A.openSettings(true); } },
      { id: "btn-pause-help", text: T("Help"), act: () => { A.cue("ui"); A.openHelp(true); } },
      { id: "btn-leave", text: T("Leave round"), act: () => { A.cue("ui"); A.abandonRound(); } },
    ]));
    if (!open && !fresh && app.modal === "pause") A.resumeGame();
    return;
  }
  if (m === "practice") {
    open = ui.dialog(T("Practice"), "", true, () => body(T("Practice"), T("Select difficulty. Practice is unranked and undo is allowed."), [
      { id: "btn-practice-easy", text: T("Easy"), act: () => { A.cue("ui"); A.closeModal(); A.openSetup("practice", A.practiceStage("easy")); } },
      { id: "btn-practice-normal", text: T("Normal"), primary: true, act: () => { A.cue("ui"); A.closeModal(); A.openSetup("practice", A.practiceStage("normal")); } },
      { id: "btn-practice-hard", text: T("Hard"), act: () => { A.cue("ui"); A.closeModal(); A.openSetup("practice", A.practiceStage("hard")); } },
      { id: "btn-practice-cancel", text: T("Cancel"), act: () => { A.cue("ui"); A.closeModal(); } },
    ]));
  } else if (m === "challenge") {
    const list = CHALLENGES as Stage[] & { title: string; constraint: string }[];
    open = ui.dialog(T("Challenge"), "", true, () => {
      para(T("Challenge"), w, "h2", "modal-title", true);
      para(T("Constrained ranked goals. Pick one:"), w, "body", undefined, true);
      for (const c of list) para(`${T(c.title!)} — ${T(c.constraint!)}`, w, "body");
      gapV(8);
      flow("modal-actions", [
        ...list.map((c, i) => ({ id: `btn-challenge-${i}`, text: T(c.title!), primary: i === 0, act: () => { A.cue("ui"); A.closeModal(); A.openSetup("challenge", c); } })),
        { id: "btn-challenge-cancel", text: T("Cancel"), act: () => { A.cue("ui"); A.closeModal(); } },
      ], w);
    });
  } else if (m === "reset") {
    open = ui.dialog(T("Reset progress"), "", true, () => body(T("Reset progress"), T("This clears journey progress, best scores, and achievements on this device. Settings are kept. Continue?"), [
      { id: "btn-reset-cancel", text: T("Cancel"), primary: true, act: () => { A.cue("ui"); A.closeModal(); } },
      { id: "btn-reset-confirm", text: T("Reset"), act: () => { A.cue("ui"); A.resetProgress(); } },
    ]));
  }
  if (!open && !fresh && app.modal === m) A.closeModal();
}

// ------------------------------------------------------------------ toast
function toast(L: Layout): void {
  const t = app.toast;
  if (!t) return;
  const w = Math.min(L.lw * 0.92, 420);
  ui.place("toast", { anchor: "top", y: 8 }, () => {
    if (textWidth(t.text, "toast") + 36 <= w) ui.style("toast").id("toast").label(t.text);
    else ui.style("toast", { text: { align: "center" } }).id("toast").paragraph(t.text, w - 36);
  });
}
void PATTERNS;
