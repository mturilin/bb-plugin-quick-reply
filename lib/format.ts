// lib/format.ts — turns line marks into the message sent to the agent.
//
// What: builds plain Markdown that quotes each marked line and puts the
//   verdict and comment under it, in words.
// Why: the agent must understand the reply without knowing a plugin made it,
//   so the output reads like something a person would type: a quote, then a
//   reaction.
// Design notes:
//   - Verdicts are written as words ("Agreed", "Disagreed", "Please explain
//     this in more detail") rather than symbols.
//     Emoji are open to reading (is 👍 "agreed" or "seen"?), and smaller
//     models read them less reliably than plain words.
//   - Only marked lines appear. Lines left alone are not mentioned at all.
//   - Long lines (code blocks, big paragraphs) are cut to QUOTE_LIMIT
//     characters; the quote only has to identify the line, and the agent
//     still has the full text in its own history.

import type { LineMark } from "./marks.ts";

export const QUOTE_LIMIT = 300;
export const HEADER = "My replies, line by line:";

/**
 * Order marks the way they appear in the conversation.
 *
 * @param marks - the marks to order (not mutated).
 * @param rowRank - position of each timeline row; rows missing from the map
 *   (unloaded because they scrolled far away) sort before the rows on screen,
 *   by the time they were first marked, which in practice is reading order.
 * Returns a new array.
 */
export function orderMarks(
  marks: readonly LineMark[],
  rowRank: ReadonlyMap<string, number>,
): LineMark[] {
  const firstMarked = new Map<string, number>();
  for (const m of marks) {
    firstMarked.set(m.rowId, Math.min(firstMarked.get(m.rowId) ?? Infinity, m.updatedAt));
  }
  const rank = (rowId: string) => rowRank.get(rowId) ?? -1;
  return [...marks].sort(
    (a, b) =>
      rank(a.rowId) - rank(b.rowId) ||
      firstMarked.get(a.rowId)! - firstMarked.get(b.rowId)! ||
      a.rowId.localeCompare(b.rowId) ||
      a.index - b.index,
  );
}

/** Quote `text` as a Markdown block quote, shortened to QUOTE_LIMIT characters. */
export function quote(text: string): string {
  const short = text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT).trimEnd()}…` : text;
  return short
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
}

/** What each verdict says on its own, and before a comment. */
export const VERDICT_WORDS = {
  up: { alone: "Agreed.", lead: "Agreed" },
  down: { alone: "Disagreed.", lead: "Disagreed" },
  question: { alone: "Please explain this in more detail.", lead: "Please explain in more detail" },
} as const;

/**
 * The reaction line under a quote: the verdict in words, then the comment.
 * Returns e.g. "Agreed.", "Disagreed: 3 retries is enough", or
 * "Comment: which bucket?" for a comment with no verdict.
 */
export function verdict(mark: Pick<LineMark, "vote" | "comment">): string {
  const comment = mark.comment.trim();
  if (mark.vote === null) return `Comment: ${comment}`;
  const words = VERDICT_WORDS[mark.vote];
  return comment === "" ? words.alone : `${words.lead}: ${comment}`;
}

/**
 * Build the full message.
 *
 * @param marks - marks already in conversation order (see orderMarks).
 * Returns "" when there is nothing to send; otherwise the header followed by
 * one quote + verdict pair per mark, separated by blank lines.
 */
export function formatReplies(marks: readonly LineMark[]): string {
  if (marks.length === 0) return "";
  const blocks = marks.map((m) => `${quote(m.text)}\n${verdict(m)}`);
  return [HEADER, ...blocks].join("\n\n");
}
