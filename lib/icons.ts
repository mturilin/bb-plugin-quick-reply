// lib/icons.ts — the plugin's icons, drawn as inline SVG.
//
// What: path data for Tabler Icons' outline `thumb-up`, `thumb-down`,
//   `help-circle`, `message`, `paperclip`, `file` and `x` (v3.49.0), and a
//   helper that builds an <svg>.
// Why: emoji come with their own colors and shapes (❓ is tall and narrow
//   next to 👍), so the four buttons looked uneven. Line icons share one size
//   and stroke, take the surrounding text color, and match BB's own buttons.
// Design notes: the paths are copied rather than installed as a package; a
//   handful of icons does not justify a dependency. The content script builds plain DOM, so
//   it cannot use BB's React icon component.
// License: Tabler Icons, MIT License, Copyright (c) 2020-2026 Paweł Kuna,
//   https://github.com/tabler/tabler-icons

export type IconName =
  | "thumb-up"
  | "thumb-down"
  | "help-circle"
  | "message"
  | "paperclip"
  | "file"
  | "x";

const PATHS: Record<IconName, readonly string[]> = {
  "thumb-up": [
    "M7 11v8a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1v-7a1 1 0 0 1 1 -1h3a4 4 0 0 0 4 -4v-1a2 2 0 0 1 4 0v5h3a2 2 0 0 1 2 2l-1 5a2 3 0 0 1 -2 2h-7a3 3 0 0 1 -3 -3",
  ],
  "thumb-down": [
    "M7 13v-8a1 1 0 0 0 -1 -1h-2a1 1 0 0 0 -1 1v7a1 1 0 0 0 1 1h3a4 4 0 0 1 4 4v1a2 2 0 0 0 4 0v-5h3a2 2 0 0 0 2 -2l-1 -5a2 3 0 0 0 -2 -2h-7a3 3 0 0 0 -3 3",
  ],
  "help-circle": [
    "M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0",
    "M12 16v.01",
    "M12 13a2 2 0 0 0 .914 -3.782a1.98 1.98 0 0 0 -2.414 .483",
  ],
  message: [
    "M8 9h8",
    "M8 13h6",
    "M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12",
  ],
  paperclip: ["M15 7l-6.5 6.5a1.5 1.5 0 0 0 3 3l6.5 -6.5a3 3 0 0 0 -6 -6l-6.5 6.5a4.5 4.5 0 0 0 9 9l6.5 -6.5"],
  file: [
    "M14 3v4a1 1 0 0 0 1 1h4",
    "M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2",
  ],
  x: ["M18 6l-12 12", "M6 6l12 12"],
};

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Build one icon.
 *
 * @param doc - the document to create it in.
 * Returns a decorative 24×24-viewBox <svg> stroked with `currentColor`;
 * size it with CSS. It is `aria-hidden`: the button carries the label.
 */
export function createIcon(doc: Document, name: IconName): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "lr-icon");
  for (const d of PATHS[name]) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
