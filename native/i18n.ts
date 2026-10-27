// Localization: the browser build's dictionaries (js/locales/*.js through
// js/i18n.js, US-English text as the keys, the nine StarHermit locales) and
// its account strings (js/sh-strings.js) in the interface language the
// runtime reports (preferences().language: the player's choice in Options ›
// Language, else the account's preferred language or the device's), mapped
// to the nearest shipped locale. The runtime's Options replaced the game's
// own Language selector (sh-language.js) and its ?lang= override. A change
// shows on the next frame (the UI is immediate mode).
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { T as translate, setLocale } from "../js/i18n.js";
import { pickLocale, shStrings } from "../js/sh-strings.js";

let locale = "";
function apply(tag: string): void {
  const next = pickLocale([tag]) as string;
  if (next === locale) return;
  locale = next;
  setLocale(locale);
  ui.setLanguage(locale);
}
/** Wires the language (from onStart). */
export function initLanguage(): void {
  apply(preferences().language);
  onPreferencesChange((p) => apply(p.language));
}
export function currentLocale(): string { return locale || "en-US"; }

type Vars = Record<string, string | number>;
/** An English source string in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return translate(key, vars ?? undefined); }
/** Marks an English key that is translated with T() where it is shown. */
export const N = (s: string): string => s;
export interface ShStrings {
  signIn: string; invite: string; copied: string; copyFailed: string; signedOut: string; playingAs: string;
  lbPosting: string; lbRank: string; lbPosted: string; lbNotPosted: string;
}
/** The account lines (sign-in, invite, the signed-out toast, the leaderboard line). */
export function shT(): ShStrings { return shStrings([currentLocale()]) as ShStrings; }
