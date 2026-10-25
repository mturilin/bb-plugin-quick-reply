// Tests for lib/marks.ts: identity of lines, add/update/remove rules,
// persistence, and tolerance of bad stored data.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMarksStore, parseState, STORAGE_KEY, type KeyValueStorage, type LineRef } from "./marks.ts";

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const line = (text: string, occurrence = 0, index = 0): LineRef => ({ rowId: "thr_a:assistant:x", text, occurrence, index });

test("a vote creates a mark and pressing it off removes the mark", () => {
  const store = createMarksStore(memoryStorage(), () => 1);
  store.update("thr_a", line("Use Postgres"), { vote: "up" });
  assert.equal(store.forThread("thr_a").length, 1);
  store.update("thr_a", line("Use Postgres"), { vote: null });
  assert.equal(store.forThread("thr_a").length, 0);
});

test("a question replaces an earlier vote on the same line", () => {
  const store = createMarksStore(null, () => 1);
  store.update("thr_a", line("Add a cache"), { vote: "up" });
  store.update("thr_a", line("Add a cache"), { vote: "question" });
  assert.equal(store.forThread("thr_a").length, 1);
  assert.equal(store.find("thr_a", line("Add a cache"))?.vote, "question");
  const q = { rowId: "r", text: "t", occurrence: 0, index: 0, vote: "question", comment: "", updatedAt: 1 };
  assert.equal(parseState(JSON.stringify({ thr_a: [q] }), 1).size, 1);
});

test("a comment-only mark is kept, and a blank comment removes it", () => {
  const store = createMarksStore(null, () => 1);
  store.update("thr_a", line("Retry 5 times"), { comment: "3 is enough" });
  assert.equal(store.find("thr_a", line("Retry 5 times"))?.vote, null);
  store.update("thr_a", line("Retry 5 times"), { comment: "   " });
  assert.equal(store.forThread("thr_a").length, 0);
});

test("vote and comment are kept independently", () => {
  const store = createMarksStore(null, () => 1);
  store.update("thr_a", line("A"), { vote: "down" });
  store.update("thr_a", line("A"), { comment: "why?" });
  assert.deepEqual(
    { vote: store.find("thr_a", line("A"))?.vote, comment: store.find("thr_a", line("A"))?.comment },
    { vote: "down", comment: "why?" },
  );
});

test("duplicate lines are told apart by occurrence, and index does not matter", () => {
  const store = createMarksStore(null, () => 1);
  store.update("thr_a", line("Done.", 0, 2), { vote: "up" });
  store.update("thr_a", line("Done.", 1, 5), { vote: "down" });
  assert.equal(store.find("thr_a", line("Done.", 0, 9))?.vote, "up");
  assert.equal(store.find("thr_a", line("Done.", 1, 9))?.vote, "down");
});

test("snapshot reference changes only for the thread that changed", () => {
  const store = createMarksStore(null, () => 1);
  store.update("thr_a", line("A"), { vote: "up" });
  store.update("thr_b", line("B"), { vote: "up" });
  const a = store.forThread("thr_a");
  const b = store.forThread("thr_b");
  store.update("thr_b", line("B"), { comment: "x" });
  assert.equal(store.forThread("thr_a"), a);
  assert.notEqual(store.forThread("thr_b"), b);
});

test("remove deletes only the given lines", () => {
  const store = createMarksStore(null, () => 1);
  store.update("thr_a", line("A"), { vote: "up" });
  store.update("thr_a", line("B"), { vote: "up" });
  store.remove("thr_a", [line("A")]);
  assert.deepEqual(store.forThread("thr_a").map((m) => m.text), ["B"]);
});

test("marks persist and reload; listeners hear every change", () => {
  const storage = memoryStorage();
  const first = createMarksStore(storage, () => 1);
  let calls = 0;
  first.subscribe(() => calls++);
  first.update("thr_a", line("A"), { vote: "up" });
  first.clearThread("thr_a");
  first.update("thr_a", line("B"), { vote: "down" });
  assert.equal(calls, 3);
  const second = createMarksStore(storage, () => 2);
  assert.equal(second.find("thr_a", line("B"))?.vote, "down");
});

test("bad or stale stored data is ignored", () => {
  assert.equal(parseState("{not json", 0).size, 0);
  assert.equal(parseState(JSON.stringify({ thr_a: [{ rowId: 1 }] }), 0).size, 0);
  const old = { rowId: "r", text: "t", occurrence: 0, index: 0, vote: "up", comment: "", updatedAt: 0 };
  assert.equal(parseState(JSON.stringify({ thr_a: [old] }), 31 * 24 * 3600 * 1000).size, 0);
  assert.equal(parseState(JSON.stringify({ thr_a: [old] }), 1000).size, 1);
});

test("storage that throws does not break the store", () => {
  const broken: KeyValueStorage = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("quota"); },
  };
  const store = createMarksStore(broken, () => 1);
  store.update("thr_a", line("A"), { vote: "up" });
  assert.equal(store.forThread("thr_a").length, 1);
  assert.equal(STORAGE_KEY, "bb-quick-reply:v1");
});
