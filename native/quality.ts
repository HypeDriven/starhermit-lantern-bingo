// The hall's look per graphics level. The engine-owned effects (shadows and
// their map size, ambient occlusion, bloom, the grade, anti-aliasing) are the
// level's own (levelSettings(): the same table every StarHermit game reads).
// The game's art (materials, the floor texture, geometry LOD, lanterns,
// motes, reflections, detail, motion) is the browser build's four presets and
// budgets (js/gfx.js TABLE and BUDGETS before the port) keyed by the level's
// quality tier, with the dust motes scaled within the tier by the level's
// particle budget against the tier's anchor level (quantum, molecular,
// terrestrial, galactic), at most 2×. The runtime owns what the old
// Settings › Graphics panel did besides: Auto and the level choice, render
// scale and the pixel-ratio cap, adaptive resolution, the frame-rate limit
// and readout. The per-effect overrides of the old panel are gone with it
// (Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Hall materials (tiles, board, ball, pole, floor, lanterns). */
  material: "lambert" | "standard" | "physical";
  /** Lacquered floor texture size (px). */
  floor: number;
  /** Geometry LOD: floor, ball, pole, lantern lathe and caps, tile bevels. */
  segments: number;
  motes: number;
  /** Title sky lanterns multiplier. */
  title: number;
}
export interface Look {
  preset: QualityTier;
  /** The level's key-light shadow map size, 0 when the level draws no shadows. */
  shadows: number;
  /** The level's ambient occlusion (null: off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null: off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  /** Hanging lanterns in the hall (12 / 24 / 40); title lanterns 10 / 18 / 28. */
  lanterns: "low" | "medium" | "high";
  /** Title sky lanterns drift, the hall lanterns sway, the ball bobs, motes rise. */
  animated: boolean;
  /** Paper / lacquer finish: textured floor, lacquered board, bevelled glossy tiles, brass pole. */
  detailed: boolean;
  budget: Budget;
}

type Art = Pick<Look, "reflections" | "lanterns" | "animated" | "detailed">;
const ART: Record<QualityTier, Art> = {
  low: { reflections: false, lanterns: "low", animated: false, detailed: false },
  balanced: { reflections: true, lanterns: "medium", animated: true, detailed: true },
  high: { reflections: true, lanterns: "high", animated: true, detailed: true },
  ultra: { reflections: true, lanterns: "high", animated: true, detailed: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", floor: 256, segments: 0.5, motes: 30, title: 0.75 },
  balanced: { material: "standard", floor: 512, segments: 0.75, motes: 60, title: 1 },
  high: { material: "physical", floor: 512, segments: 1, motes: 90, title: 1 },
  ultra: { material: "physical", floor: 1024, segments: 1.5, motes: 150, title: 1.25 },
};
export const LANTERN_COUNT = { low: 12, medium: 24, high: 40 };
export const TITLE_LANTERNS = { low: 10, medium: 18, high: 28 };
/** The level whose settings are each tier's preset. */
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level (the frame's by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  // Motes grow with the level's particle budget above the tier's anchor, at most 2×.
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  const b = BUDGETS[preset];
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: { ...b, floor: Math.min(b.floor, s.maxTextureSize), motes: Math.round(b.motes * k) },
  };
}
