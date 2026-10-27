// Lantern Bingo on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules, the session with its undo and replay
// envelope, and the content are the browser build's (js/rules.js,
// js/session.js, js/content.js), unchanged; hosted halls are refereed by
// server.js (js/hosted.js); the controller is app.ts, the screens and HUD
// starhermit:ui (screens.ts), the lantern hall starhermit:scene (render.ts),
// saves, options and the platform platform.ts.
import { frame, onFixedUpdate, onPreferencesChange, onQuit, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onTouch } from "starhermit:input";
import * as ui from "starhermit:ui";
import * as A from "./app.ts";
import { app } from "./app.ts";
import * as audio from "./audio.ts";
import { initLanguage } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens, setLook } from "./screens.ts";
import { applyContrast, initStyles } from "./style.ts";

const STEP_MS = 1000 / 60;

onStart(() => {
  setFixedRate(60);
  initLanguage();
  initStyles();
  platform.initPlatform();
  platform.onOptionsChange(() => A.syncHall());
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  audio.loadSfx();
  A.boot();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));

let hidden = false;
onSuspend(() => {
  hidden = true;
  audio.setSuspended(true);
  A.onSuspend();
  platform.flush();
});
onResume(() => { hidden = false; audio.setSuspended(false); });
onQuit(() => platform.flush());

// ------------------------------------------------------------------ keys and pads
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  audio.startAmbience(); // the hum starts with the first press, as the browser build's audio unlock
  const fresh = A.fresh();
  if (app.modal) {
    // Back or Pause on the pause dialog resumes; the other dialogs close by their own Escape.
    if (app.modal === "pause" && (e.action === "back" || e.action === "pause") && fresh) A.resumeGame();
    return;
  }
  if (app.screen === "play") {
    switch (e.action) {
      case "mark":
        // Enter (South) on a focused cell or button is the widget's; with nothing focused it focuses the card.
        if (!ui.focused()) ui.setFocus(`cell-${app.focusCell}`);
        return;
      case "call":
        // Space with a card cell focused marks it (the widget takes it); otherwise it calls.
        if (!ui.focused()) A.doCall();
        return;
      case "claim": A.claim(); return;
      case "undo": A.undo(); return;
      case "hint": A.hint(); return;
      case "pause": if (fresh) A.pauseGame(); return;
      case "back": if (fresh) A.pauseGame(); return;
      case "camera": A.resetCamera(); return;
      default: return;
    }
  }
  if (e.action === "back" && fresh && app.screen !== "title") {
    if (app.screen === "settings") A.backFromSub("settings");
    else if (app.screen === "help") A.backFromSub("help");
    else if (app.screen === "hall") { A.leaveHosted(); A.nav("title"); }
    else A.nav("title");
  }
});

// ------------------------------------------------------------------ clicks and taps on the 3D hall's tiles
// Presses are queued and decided after the frame's UI is built (the hall's
// rectangle is that frame's; a press over a widget is the widget's).
const pending: { x: number; y: number }[] = [];
let lastTouch = -1e9;
onPointerButton((e) => {
  if (e.button !== 0 || !e.pressed || frame().time - lastTouch < 0.6) return;
  audio.startAmbience();
  pending.push({ x: e.x, y: e.y });
});
onTouch((e) => {
  if (!e.primary || e.control) return;
  lastTouch = frame().time;
  audio.startAmbience();
  if (e.phase === "start") pending.push({ x: e.x, y: e.y });
});
function handlePointer(): void {
  while (pending.length) {
    const p = pending.shift()!;
    if (app.screen !== "play" || app.modal || ui.pointerOver()) continue;
    const cell = render.pick(p.x, p.y);
    if (cell >= 0) A.markCell(cell);
  }
}

// ------------------------------------------------------------------ frame
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const key = `${f.quality}:${f.levelIndex}`;
  if (key === lookKey) return;
  lookKey = key;
  const look = lookFor(f.quality, f.levelIndex);
  setLook(look);
  render.applyLook(look);
}
onFixedUpdate(() => {
  if (hidden) return;
  A.step(STEP_MS);
});
let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  audio.update();
  applyContrast(ui.preferences().highContrast);
  if (app.toast && app.toast.until < frame().time) app.toast = null;
});
onRender(() => {
  drawScreens();
  handlePointer();
  render.update(frameDt);
});
