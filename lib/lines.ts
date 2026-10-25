// lib/lines.ts — splits a rendered agent reply into reviewable "lines".
//
// What: walks the HTML BB renders for an assistant message and returns the
//   elements a person would react to one by one, with their text.
// Why: rendered Markdown has no fixed lines (wrapping depends on window
//   width), so a "line" is a structural unit: a paragraph, a list item, a
//   table row, or a code block. Headings and rules only organize the reply
//   and get no controls.
// Design notes:
//   - Works on BB's DOM as it is today (observed on bb 0.46): the reply's
//     Markdown root is `[data-markdown-preview]`, and paragraphs, lists,
//     tables, block quotes and code blocks are its descendants. Unknown
//     wrapper elements are handled generically: a wrapper holding a code
//     block becomes one unit, a wrapper holding other blocks is descended
//     into, and a wrapper holding only text becomes one unit.
//   - A list item that contains a nested list is a unit for its own text;
//     the nested items are units of their own.
// Gotchas: nothing here mutates the DOM; content.ts does that.

/** One reviewable line found in a reply. */
export interface Unit {
  /** The element the controls attach to. */
  el: HTMLElement;
  /** Normalized text used to identify the line and to quote it. */
  text: string;
}

const SKIP = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "HR", "BR", "SCRIPT", "STYLE"]);
const LIST = new Set(["UL", "OL"]);
const BLOCKS = "p, ul, ol, blockquote, table, pre";

/** Collapse runs of whitespace; trims the ends. */
export function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The text of a code block, keeping its line breaks.
 * Reads the `<pre>` itself so a wrapper's language label or copy-button
 * text is not included.
 */
function codeText(el: Element): string {
  const pre = el.tagName === "PRE" ? el : el.querySelector("pre");
  return (pre?.textContent ?? "").replace(/\s+$/, "").replace(/^\n+/, "");
}

/** A list item's own text, without the text of any list nested inside it. */
function ownText(li: Element): string {
  const clone = li.cloneNode(true) as Element;
  for (const nested of Array.from(clone.querySelectorAll("ul, ol"))) nested.remove();
  return normalize(clone.textContent ?? "");
}

function pushIfText(out: Unit[], el: Element, text: string) {
  if (text !== "") out.push({ el: el as HTMLElement, text });
}

function collectList(list: Element, out: Unit[]) {
  for (const li of Array.from(list.children)) {
    if (li.tagName !== "LI") continue;
    pushIfText(out, li, ownText(li));
    // Nested lists may sit directly in the item or inside a paragraph wrapper.
    for (const nested of Array.from(li.querySelectorAll(":scope > ul, :scope > ol"))) {
      collectList(nested, out);
    }
  }
}

function collectTable(table: Element, out: Unit[]) {
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    // Header rows label the columns; they are not something to agree with.
    if (tr.closest("thead") !== null || tr.querySelector("td") === null) continue;
    const cells = Array.from(tr.children).map((cell) => normalize(cell.textContent ?? ""));
    pushIfText(out, tr, cells.filter((c) => c !== "").join(" | "));
  }
}

function collect(root: Element, out: Unit[]) {
  for (const child of Array.from(root.children)) {
    const tag = child.tagName;
    if (SKIP.has(tag)) continue;
    if (tag === "P") pushIfText(out, child, normalize(child.textContent ?? ""));
    else if (tag === "PRE") pushIfText(out, child, codeText(child));
    else if (LIST.has(tag)) collectList(child, out);
    else if (tag === "TABLE") collectTable(child, out);
    else if (tag === "BLOCKQUOTE" || tag === "DETAILS") collect(child, out);
    else if (child.querySelector("pre") !== null && child.querySelector("p, li") === null) {
      // A code block wrapper (header, copy button, <pre>): one unit.
      pushIfText(out, child, codeText(child));
    } else if (child.querySelector(BLOCKS) !== null) collect(child, out);
    else pushIfText(out, child, normalize(child.textContent ?? ""));
  }
}

/**
 * All reviewable lines of one rendered reply, in reading order.
 *
 * @param markdownRoot - the reply's `[data-markdown-preview]` element.
 * Returns units; empty when the reply has no text yet.
 */
export function extractUnits(markdownRoot: Element): Unit[] {
  const out: Unit[] = [];
  collect(markdownRoot, out);
  return out;
}

/**
 * Number each unit by how many earlier units in the same reply have the
 * same text, so duplicate lines get distinct identities (see lib/marks.ts).
 *
 * @param texts - unit texts in reading order.
 * Returns occurrence counts aligned with `texts`.
 */
export function occurrences(texts: readonly string[]): number[] {
  const seen = new Map<string, number>();
  return texts.map((text) => {
    const n = seen.get(text) ?? 0;
    seen.set(text, n + 1);
    return n;
  });
}
