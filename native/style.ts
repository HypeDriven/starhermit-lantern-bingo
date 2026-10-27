// The look of the menus, HUD and dialogs: the browser build's style sheet,
// rewritten class-based in tools/ui-style.css and converted once with
// `starhermit css` into assets/ui-style.json (`npm run css`), registered at
// start with the theme the runtime's own widgets (checkboxes, selects,
// dialogs, scroll bars) take. The old body.high-contrast palette (black
// panels, white ink, gold accent) is a token set applied while the
// runtime's high-contrast option is on.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

export const INK = {
  bg: "#0f1226", panel: "#1a2040", panel2: "#2b3a67", panel3: "#3d5290", ink: "#e8ecff", accent: "#ffd7a0", accent2: "#ffb454",
  ok: "#8be09b", danger: "#ff7a7a", markedInk: "#0f1226",
};
export const INK_HC = { ...INK, bg: "#000000", panel: "#000000", panel2: "#1a1a1a", panel3: "#333333", ink: "#ffffff", accent: "#ffffff", accent2: "#ffd700" };
type Tokens = Record<string, string | number>;
let base: Tokens = {};
const HIGH_CONTRAST: Tokens = {
  bg: INK_HC.bg, panel: INK_HC.panel, "panel-2": INK_HC.panel2, "panel-3": INK_HC.panel3, ink: INK_HC.ink, accent: INK_HC.accent, "accent-2": INK_HC.accent2,
};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  ui.setTheme({
    fontSize: 16, smallSize: 14.4, headingSize: 24, padding: 8, spacing: 8, radius: 10,
    text: INK.ink, muted: "#b9bdd4", panel: INK.panel, control: INK.panel2, hovered: INK.panel3,
    pressed: "#24305a", field: INK.panel2, accent: INK.accent2, focus: INK.accent, outline: "#ffffff2e",
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    widget: { focusRing: { color: "$accent", width: 3, offset: 2 } },
    checkbox: {
      text: { color: "$ink" }, minHeight: 44,
      parts: { box: { background: "$panel-2", border: { width: 1, color: "#ffffff44" }, radius: 4 }, mark: { background: "$accent-2" } },
    },
    select: {
      text: { color: "$ink" },
      parts: {
        field: { background: "$panel-2", radius: 6, padding: { top: 6, end: 10, bottom: 6, start: 10 }, minHeight: 40 },
        list: { background: "$panel", radius: 8, border: { width: 1, color: "$accent-2" } },
        option: { hovered: { background: "$panel-3" }, selected: { text: { color: "$accent" } } },
      },
    },
    dialog: {
      background: "$panel", radius: 14, padding: 24,
      shadow: { y: 10, blur: 40, color: "#00000080" },
      parts: { backdrop: { background: "#050818b8" } },
    },
    scrollArea: { parts: { bar: { background: "$panel-3", radius: 4 } } },
  });
}

let hcKey: boolean | null = null;
/** The high-contrast tokens over the sheet's while the runtime's option is on. */
export function applyContrast(highContrast: boolean): void {
  if (hcKey === highContrast) return;
  hcKey = highContrast;
  ui.setTokens(highContrast ? { ...base, ...HIGH_CONTRAST } : base);
}
export function ink(highContrast: boolean): typeof INK { return highContrast ? INK_HC : INK; }
