// Tests for lib/format.ts: the message the agent receives.
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatReplies, orderMarks, QUOTE_LIMIT, quote, verdict } from "./format.ts";
import type { LineMark } from "./marks.ts";

const mark = (over: Partial<LineMark>): LineMark => ({
  rowId: "r1", text: "t", occurrence: 0, index: 0, vote: null, comment: "", updatedAt: 0, ...over,
});

test("formats quotes with the verdict underneath", () => {
  const text = formatReplies([
    mark({ text: "Use Postgres for the job queue", vote: "up" }),
    mark({ text: "Retry failed jobs 5 times", vote: "down", comment: "3 retries is enough", index: 1 }),
    mark({ text: "Store results in S3", comment: "which bucket?", index: 2 }),
  ]);
  assert.equal(
    text,
    [
      "My replies, line by line:",
      "> Use Postgres for the job queue\n👍",
      "> Retry failed jobs 5 times\n👎 3 retries is enough",
      "> Store results in S3\n💬 which bucket?",
    ].join("\n\n"),
  );
});

test("nothing marked means nothing to send", () => {
  assert.equal(formatReplies([]), "");
});

test("multi-line text is quoted line by line and long text is cut", () => {
  assert.equal(quote("a\n\nb"), "> a\n>\n> b");
  const long = quote("x".repeat(QUOTE_LIMIT + 50));
  assert.ok(long.endsWith("…"));
  assert.equal(long.length, 2 + QUOTE_LIMIT + 1);
});

test("verdict trims the comment", () => {
  assert.equal(verdict({ vote: "up", comment: "  yes  " }), "👍 yes");
  assert.equal(verdict({ vote: "down", comment: "" }), "👎");
});

test("orders by row position on the page, then by line position", () => {
  const ranks = new Map([["r1", 5], ["r2", 9]]);
  const ordered = orderMarks(
    [
      mark({ rowId: "r2", index: 0, text: "c" }),
      mark({ rowId: "r1", index: 3, text: "b" }),
      mark({ rowId: "r1", index: 1, text: "a" }),
      mark({ rowId: "gone", index: 0, text: "first", updatedAt: 1 }),
    ],
    ranks,
  );
  assert.deepEqual(ordered.map((m) => m.text), ["first", "a", "b", "c"]);
});
