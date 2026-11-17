// lib/step.ts — which marked line the bar's ↑ / ↓ buttons go to next.
//
// What: picks the next or previous mark from the thread's marks in
//   conversation order, starting from the mark the last press went to.
// Why: the bar shows only "Replies: N", so the arrows are how the user checks
//   what they are about to send when the marked lines have scrolled away.
// Design notes:
//   - The first press (or a press after the remembered mark was sent, cleared
//     or removed) starts at an end: ↑ at the newest mark, because the user is
//     usually at the bottom of the chat; ↓ at the oldest.
//   - Stepping past either end wraps around.
//   - The position is not shown to the user (the bar never says "2 of 5"); it
//     only makes the next press predictable.

import { sameLine, type LineRef } from "./marks.ts";

/** ↑ is "previous" (older, higher in the chat), ↓ is "next". */
export type Direction = "previous" | "next";

/**
 * The mark a press of ↑ or ↓ goes to.
 *
 * @param ordered - the thread's marks in conversation order (see orderMarks).
 * @param last - the mark the previous press went to, if any.
 * @param direction - which button was pressed.
 * Returns the target mark, or undefined when there are no marks.
 */
export function stepTarget<T extends LineRef>(
  ordered: readonly T[],
  last: LineRef | undefined,
  direction: Direction,
): T | undefined {
  const count = ordered.length;
  if (count === 0) return undefined;
  const at = last === undefined ? -1 : ordered.findIndex((m) => sameLine(m, last));
  if (at === -1) return ordered[direction === "previous" ? count - 1 : 0];
  const step = direction === "previous" ? -1 : 1;
  return ordered[(at + step + count) % count];
}
