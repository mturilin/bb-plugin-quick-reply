// Tests for lib/step.ts: where the bar's ↑ / ↓ buttons go.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stepTarget } from "./step.ts";
import type { LineRef } from "./marks.ts";

const ref = (text: string): LineRef => ({ rowId: "r1", text, occurrence: 0, index: 0 });
const marks = [ref("a"), ref("b"), ref("c")];

test("no marks, no target", () => {
  assert.equal(stepTarget([], undefined, "next"), undefined);
  assert.equal(stepTarget([], ref("a"), "previous"), undefined);
});

test("the first press starts at an end: up at the newest, down at the oldest", () => {
  assert.equal(stepTarget(marks, undefined, "previous")?.text, "c");
  assert.equal(stepTarget(marks, undefined, "next")?.text, "a");
});

test("later presses step from the last mark and wrap around", () => {
  assert.equal(stepTarget(marks, ref("b"), "previous")?.text, "a");
  assert.equal(stepTarget(marks, ref("b"), "next")?.text, "c");
  assert.equal(stepTarget(marks, ref("a"), "previous")?.text, "c");
  assert.equal(stepTarget(marks, ref("c"), "next")?.text, "a");
});

test("a remembered mark that is gone restarts from an end", () => {
  assert.equal(stepTarget(marks, ref("sent"), "previous")?.text, "c");
  assert.equal(stepTarget(marks, ref("sent"), "next")?.text, "a");
});
