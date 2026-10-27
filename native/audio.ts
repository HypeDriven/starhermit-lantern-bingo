// Sound, as the browser build's js/audio.js: each game event plays one of its
// two authored one-shots (sfx/<name>.opus, mapped in sfx/manifest.json),
// the variant picked by a seeded RNG, with a caption line for every event so
// the audio reads with sound off; under it the quiet lantern-hum ambience
// (110 Hz + 165 Hz sines at 0.05), rendered once into a looping clip.
//
// The browser build's four buses become the runtime's (Options › Audio owns
// the volumes, the mute and the voice limit): menu and tray taps → the
// "interface" bus, every other one-shot and the ambience → "effects"; the old
// default bus levels (effects 0.8, ambience 0.4) are folded into each
// sound's gain. The synthesized transients the browser build played while a
// clip was still decoding are not ported (a live synthesis graph makes clip
// loads fail on the engine's web runtime): a clip still loading is silent,
// its caption still shows. Clips load once the mixer runs (natively at once,
// in a browser after the first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
import { files } from "starhermit:engine";
import { mulberry32 } from "../js/rules.js";

export type Cue = "ui" | "call" | "mark" | "invalid" | "line" | "win" | "lose" | "tick" | "go" | "achievement";
/** The caption each event writes (translated where shown). */
export const CAPTIONS: Partial<Record<Cue, string>> = {
  ui: "tap", call: "number called", mark: "marked", invalid: "not allowed",
  line: "line complete", win: "bingo! round won", lose: "round lost",
  go: "round begins", achievement: "achievement unlocked",
};
const LEVEL = { effects: 0.8, ambience: 0.4 };

const byEvent = new Map<string, string[]>();
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
let suspended = false;
const variant = mulberry32(20260829 ^ 0xa51ced);
let captionHook: ((text: string) => void) | null = null;
/** fn(caption) for each event (the caption line). */
export function onCaption(fn: (text: string) => void): void { captionHook = fn; }

/** Reads the clip index and asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void {
  try {
    const list = files.readJson("sfx/manifest.json") as unknown as { name?: string; event?: string }[];
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || typeof item.name !== "string" || typeof item.event !== "string") continue;
      const l = byEvent.get(item.event) ?? [];
      l.push(item.name);
      byEvent.set(item.event, l);
    }
  } catch (e) { console.warn(`sfx manifest: ${String(e)}`); }
  wantClips = true;
}
function load(name: string): void { if (!queue.includes(name) && !clips.has(name)) queue.push(name); }
function pump(): void {
  if (loading || !queue.length) return;
  const name = queue.shift()!;
  loading = true;
  loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
}

/** Plays an event's sample (once loaded) and writes its caption. */
export function cue(type: Cue): void {
  const caption = CAPTIONS[type];
  if (caption) captionHook?.(caption);
  const names = byEvent.get(type);
  if (!names || !names.length) return;
  const name = names[Math.floor(variant() * names.length)]!;
  const clip = clips.get(name);
  if (!clip || suspended) return;
  try { playClip(clip, { bus: type === "ui" ? "interface" : "effects", gain: LEVEL.effects }); }
  catch { clips.delete(name); load(name); } // a clip the mixer lost: load it again
}

// -- the ambience ------------------------------------------------------------------------------
const RATE = 22050;
/** js/audio.js startAmbience: 110 Hz and 165 Hz sines at 0.05, two seconds (whole periods) looped. */
function ambienceClip(): AudioClip {
  const n = RATE * 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    out[i] = 0.05 * (Math.sin(2 * Math.PI * 110 * t) + Math.sin(2 * Math.PI * 165 * t));
  }
  return createClip([out], RATE);
}
let bed: AudioClip | null = null;
let bedSound: Sound | null = null;
let ambienceOn = false;

/** The hum runs from the first press on (as the browser build started it on its audio unlock). */
export function startAmbience(): void { ambienceOn = true; }
/** A hidden window: everything holds. */
export function setSuspended(on: boolean): void { suspended = on; }

/** Each frame: the clips once the mixer runs (one at a time), then the ambience bed. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const names of byEvent.values()) for (const n of names) load(n);
    return;
  }
  pump();
  if (loading || queue.length) return;
  try {
    if (!bed) { bed = ambienceClip(); return; }
    const want = ambienceOn && !suspended;
    if (want && !bedSound) bedSound = playClip(bed, { bus: "effects", gain: LEVEL.ambience, loop: true });
    else if (!want && bedSound) { try { bedSound.stop(); } catch { /* gone */ } bedSound = null; }
  } catch (e) { console.warn(`audio: ${String(e)}`); }
}
