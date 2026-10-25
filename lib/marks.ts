// lib/marks.ts — the per-line marks (👍 / 👎 / comment) and where they are kept.
//
// What: an in-memory store of line marks, grouped by thread and mirrored to
//   localStorage, that the content script and the composer banner share.
// Why: marks must survive BB re-rendering a reply, the timeline unloading
//   rows that scroll far away, switching threads, and reloading the app.
// Design notes:
//   - A line is identified by (rowId, text, occurrence): the timeline row of
//     the agent message, the line's text, and which copy of that text it is
//     within the row (lists often repeat lines like "Done."). Position alone
//     is fragile because a reply that is still streaming can shift; text alone
//     cannot tell duplicate lines apart.
//   - `index` (the line's position in the reply) is kept only to order lines
//     in the outgoing message.
//   - One localStorage key holds every thread. The data is a few KB per
//     reviewed reply; threads untouched for 30 days are dropped on load.
// Gotchas:
//   - Both the content script and the React banner import this module from
//     the same bundle, so they share one instance. Another BB window has its
//     own instance; the `storage` event keeps them in step.
//   - Storage access can throw (quota, privacy mode). Marks then live only in
//     memory for this window, which is still usable.

/** A reviewer's verdict on one line; `null` means "comment only". */
export type Vote = "up" | "down" | null;

/** Where a line is: enough to find it again after BB re-renders the reply. */
export interface LineRef {
  /** BB's `data-timeline-row-id` of the agent message, e.g. `thr_x:assistant:…`. */
  rowId: string;
  /** Normalized text of the line (see lib/lines.ts). */
  text: string;
  /** 0 for the first line in the row with this exact text, 1 for the next, … */
  occurrence: number;
  /** Position of the line within the reply; used only for ordering. */
  index: number;
}

/** One marked line. A mark with no vote and an empty comment is never stored. */
export interface LineMark extends LineRef {
  vote: Vote;
  comment: string;
  /** Epoch milliseconds of the last change. */
  updatedAt: number;
}

/** Minimal slice of the Web Storage API the store needs; injectable for tests. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface MarksStore {
  /** Marks for one thread, in insertion order. Stable reference until changed. */
  forThread(threadId: string): readonly LineMark[];
  /** The mark for one line, or undefined. */
  find(threadId: string, ref: LineRef): LineMark | undefined;
  /**
   * Create, update, or delete the mark for a line.
   * Post-conditions: a mark left with no vote and a blank comment is removed;
   *   listeners are notified; the new state is persisted.
   */
  update(threadId: string, ref: LineRef, patch: { vote?: Vote; comment?: string }): void;
  /** Remove exactly these marks (e.g. the ones just sent). Post-conditions as `update`. */
  remove(threadId: string, marks: readonly LineRef[]): void;
  /** Remove every mark in a thread. Post-conditions as `update`. */
  clearThread(threadId: string): void;
  /** Call `listener` after every change. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Re-read persisted state (another window changed it). Notifies listeners. */
  reload(): void;
}

export const STORAGE_KEY = "bb-line-review:v1";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const EMPTY: readonly LineMark[] = Object.freeze([]);

/** True when two refs name the same line. `index` is deliberately ignored. */
export function sameLine(a: LineRef, b: LineRef): boolean {
  return a.rowId === b.rowId && a.text === b.text && a.occurrence === b.occurrence;
}

/**
 * Parse persisted state, dropping anything malformed or stale.
 *
 * @param raw - the stored JSON string, or null when nothing is stored.
 * @param now - current epoch ms, for the 30-day cutoff.
 * Returns a fresh map of thread id → marks. Never throws: the value is
 * untrusted (any page code can write localStorage).
 */
export function parseState(raw: string | null, now: number): Map<string, LineMark[]> {
  const state = new Map<string, LineMark[]>();
  if (raw === null) return state;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return state;
  }
  if (typeof data !== "object" || data === null) return state;
  for (const [threadId, list] of Object.entries(data as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const marks = list.filter(isLineMark);
    const newest = Math.max(0, ...marks.map((m) => m.updatedAt));
    if (marks.length > 0 && now - newest < MAX_AGE_MS) state.set(threadId, marks);
  }
  return state;
}

function isLineMark(value: unknown): value is LineMark {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.rowId === "string" &&
    typeof m.text === "string" &&
    typeof m.occurrence === "number" &&
    typeof m.index === "number" &&
    (m.vote === "up" || m.vote === "down" || m.vote === null) &&
    typeof m.comment === "string" &&
    typeof m.updatedAt === "number"
  );
}

/**
 * Build a store backed by `storage`.
 *
 * @param storage - where to persist; null keeps marks in memory only.
 * @param now - clock, injectable for tests.
 */
export function createMarksStore(
  storage: KeyValueStorage | null,
  now: () => number = Date.now,
): MarksStore {
  const listeners = new Set<() => void>();
  let state = load();

  function load(): Map<string, LineMark[]> {
    try {
      return parseState(storage?.getItem(STORAGE_KEY) ?? null, now());
    } catch {
      return new Map();
    }
  }

  function commit(threadId: string, next: LineMark[]) {
    // Replace the array (never mutate it) so React's useSyncExternalStore
    // sees a new snapshot for the changed thread only.
    if (next.length === 0) state.delete(threadId);
    else state.set(threadId, next);
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(state)));
    } catch {
      // Quota or privacy mode: keep working from memory.
    }
    for (const listener of listeners) listener();
  }

  return {
    forThread: (threadId) => state.get(threadId) ?? EMPTY,
    find: (threadId, ref) => state.get(threadId)?.find((m) => sameLine(m, ref)),
    update(threadId, ref, patch) {
      const current = state.get(threadId) ?? [];
      const existing = current.find((m) => sameLine(m, ref));
      const merged: LineMark = {
        rowId: ref.rowId,
        text: ref.text,
        occurrence: ref.occurrence,
        index: ref.index,
        vote: patch.vote !== undefined ? patch.vote : (existing?.vote ?? null),
        comment: patch.comment !== undefined ? patch.comment : (existing?.comment ?? ""),
        updatedAt: now(),
      };
      const keep = merged.vote !== null || merged.comment.trim() !== "";
      const rest = current.filter((m) => !sameLine(m, ref));
      if (!keep && rest.length === current.length) return; // nothing to delete
      if (!keep) return commit(threadId, rest);
      // Keep the original slot so the store's order stays stable while editing.
      const at = existing === undefined ? -1 : current.indexOf(existing);
      commit(
        threadId,
        at === -1 ? [...current, merged] : current.map((m, i) => (i === at ? merged : m)),
      );
    },
    remove(threadId, refs) {
      const current = state.get(threadId);
      if (current === undefined) return;
      const next = current.filter((m) => !refs.some((r) => sameLine(m, r)));
      if (next.length !== current.length) commit(threadId, next);
    },
    clearThread(threadId) {
      if (state.has(threadId)) commit(threadId, []);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reload() {
      state = load();
      for (const listener of listeners) listener();
    },
  };
}

let shared: MarksStore | null = null;

/**
 * The store for this BB window, created on first use.
 * Post-conditions: on first call, reads localStorage (when available).
 */
export function marksStore(): MarksStore {
  if (shared === null) {
    let storage: KeyValueStorage | null = null;
    try {
      storage = globalThis.localStorage ?? null;
    } catch {
      storage = null;
    }
    shared = createMarksStore(storage);
  }
  return shared;
}
