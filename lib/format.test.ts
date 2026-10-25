// Tests for lib/format.ts: the message the agent receives.
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatReplies, orderMarks, QUOTE_LIMIT, quote, verdict } from "./format.ts";
import type { LineMark } from "./marks.ts";

const mark = (over: Partial<LineMark>): LineMark => ({
  rowId: "r1", text: "t", occurrence: 0, index: 0, vote: null, comment: "", updatedAt: 0, ...over,
});

test("formats quotes with the verdict underneath, in words", () => {
  const text = formatReplies([
    mark({ text: "Use Postgres for the job queue", vote: "up" }),
    mark({ text: "Retry failed jobs 5 times", vote: "down", comment: "3 retries is enough", index: 1 }),
    mark({ text: "Add a dead-letter queue", vote: "question", index: 2 }),
    mark({ text: "Store results in S3", comment: "which bucket?", index: 3 }),
  ]);
  assert.equal(
    text,
    [
      "My replies, line by line:",
      "> Use Postgres for the job queue\nAgreed.",
      "> Retry failed jobs 5 times\nDisagreed: 3 retries is enough",
      "> Add a dead-letter queue\nPlease explain this in more detail.",
      "> Store results in S3\nComment: which bucket?",
    ].join("\n\n"),
  );
  assert.doesNotMatch(text, /[👍👎❓💬]/u);
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

test("verdict trims the comment and words each vote", () => {
  assert.equal(verdict({ vote: "up", comment: "  but use the existing bucket  " }), "Agreed: but use the existing bucket");
  assert.equal(verdict({ vote: "down", comment: "" }), "Disagreed.");
  assert.equal(verdict({ vote: "question", comment: "why not Redis?" }), "Please explain in more detail: why not Redis?");
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
