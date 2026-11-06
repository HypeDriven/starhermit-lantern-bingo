// Sound, as the browser build's js/audio.js: each game event plays one of its
// two authored one-shots (sfx/<name>.opus, mapped in sfx/manifest.json),
// the variant picked by the event's SoundBank, with a caption line for every
// event so the audio reads with sound off; under it the quiet lantern-hum
// ambience (110 Hz + 165 Hz sines at 0.05), rendered offline once into a
// looping clip.
//
// The browser build's four buses become the runtime's (Options › Audio owns
// the volumes, the mute and the voice limit): menu and tray taps → the
// "interface" bus, every other one-shot and the ambience → "effects"; the old
// default bus levels (effects 0.8, ambience 0.4) are folded into each
// sound's gain. The synthesized transients the browser build played while a
// clip was still decoding are not ported (a live synthesis graph makes clip
// loads fail on the engine's web runtime): an event whose clips are still
// loading is silent, its caption still shows. Every clip starts loading at start-up (the mixer
// takes them before it runs); the hum still waits for it.
import { OfflineAudioContext, SoundBank, context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
import { files } from "starhermit:engine";

export type Cue = "ui" | "call" | "mark" | "invalid" | "line" | "win" | "lose" | "tick" | "go" | "achievement";
/** The caption each event writes (translated where shown). */
export const CAPTIONS: Partial<Record<Cue, string>> = {
  ui: "tap", call: "number called", mark: "marked", invalid: "not allowed",
  line: "line complete", win: "bingo! round won", lose: "round lost",
  go: "round begins", achievement: "achievement unlocked",
};
const LEVEL = { effects: 0.8, ambience: 0.4 };

const byEvent = new Map<string, string[]>();
const banks = new Map<string, SoundBank>();
let suspended = false;
let captionHook: ((text: string) => void) | null = null;
/** fn(caption) for each event (the caption line). */
export function onCaption(fn: (text: string) => void): void { captionHook = fn; }

/** Reads the clip index and loads every clip at once (onStart); an event whose clips are still loading is skipped. */
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
  const loads = new Map<string, Promise<AudioClip | null>>();
  for (const name of new Set([...byEvent.values()].flat())) {
    loads.set(name, loadClip(`sfx/${name}.opus`).catch((e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); return null; }));
  }
  for (const [event, names] of byEvent) {
    void Promise.all(names.map((n) => loads.get(n)!)).then((loaded) => {
      const list = loaded.filter((c) => c !== null);
      if (list.length) banks.set(event, new SoundBank({ clips: list, bus: event === "ui" ? "interface" : "effects", gain: LEVEL.effects }));
    });
  }
  void renderAmbience().then((c) => { bed = c; }, (e: unknown) => console.warn(`ambience: ${String(e)}`));
}

/** Plays an event's sample (once loaded) and writes its caption. */
export function cue(type: Cue): void {
  const caption = CAPTIONS[type];
  if (caption) captionHook?.(caption);
  if (suspended) return;
  try { banks.get(type)?.play(); }
  catch { /* the mixer is full this frame: skip it */ }
}

// -- the ambience ------------------------------------------------------------------------------
const RATE = 22050;
/** js/audio.js startAmbience: 110 Hz and 165 Hz sines at 0.05, two seconds (whole periods) looped. */
async function renderAmbience(): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, RATE * 2, RATE);
  for (const hz of [110, 165]) {
    const osc = off.createOscillator();
    osc.frequency.value = hz;
    const g = off.createGain();
    g.gain.value = 0.05;
    osc.connect(g).connect(off.destination);
    osc.start();
  }
  return createClip(await off.startRendering());
}
let bed: AudioClip | null = null;
let bedSound: Sound | null = null;
let ambienceOn = false;

/** The hum runs from the first press on (as the browser build started it on its audio unlock). */
export function startAmbience(): void { ambienceOn = true; }
/** A hidden window: everything holds. */
export function setSuspended(on: boolean): void { suspended = on; }

/** Each frame once the mixer runs: the ambience bed. */
export function update(): void {
  if (context.state !== "running") return;
  try {
    if (!bed) return;
    const want = ambienceOn && !suspended;
    if (want && !bedSound) bedSound = playClip(bed, { bus: "effects", gain: LEVEL.ambience, loop: true });
    else if (!want && bedSound) { try { bedSound.stop(); } catch { /* gone */ } bedSound = null; }
  } catch (e) { console.warn(`audio: ${String(e)}`); }
}
