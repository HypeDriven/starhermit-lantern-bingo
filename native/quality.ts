// The hall's look per graphics level: the browser build's four presets and
// their 60 FPS budgets (js/gfx.js TABLE and BUDGETS before the port) keyed by
// the runtime's quality tier (frame().quality), with the dust motes scaled
// within the tier by the level (frame().levelIndex), as the browser build
// scaled them by its hardware level (at most 2×). The runtime owns what the
// old Settings › Graphics panel did besides: Auto and the level choice,
// render scale and the pixel-ratio cap, adaptive resolution, the frame-rate
// limit and readout. The per-effect overrides of the old panel are gone with
// it (Options choose a level).
import type { QualityTier } from "starhermit:engine";
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
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  shadows: 0 | 512 | 1024 | 2048;
  ao: "off" | "on" | "high";
  bloom: boolean;
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

const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, lanterns: "low", animated: false, detailed: false },
  balanced: { shadows: 512, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, lanterns: "medium", animated: true, detailed: true },
  high: { shadows: 1024, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, lanterns: "high", animated: true, detailed: true },
  ultra: { shadows: 2048, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, lanterns: "high", animated: true, detailed: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", floor: 256, segments: 0.5, motes: 30, title: 0.75, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", floor: 512, segments: 0.75, motes: 60, title: 1, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", floor: 512, segments: 1, motes: 90, title: 1, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", floor: 1024, segments: 1.5, motes: 150, title: 1.25, bloomRes: 1, aoRes: 1 },
};
export const LANTERN_COUNT = { low: 12, medium: 24, high: 40 };
export const TITLE_LANTERNS = { low: 10, medium: 18, high: 28 };
/** The first level index of each tier. */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  const b = BUDGETS[preset];
  return { preset, ...TABLE[preset], budget: { ...b, motes: Math.round(b.motes * k) } };
}
