// bb-plugin-line-review — frontend entry.
//
// What: registers the two halves of Line Review.
//   1. A content script (content.ts) that puts 👍 / 👎 / 💬 on each line of
//      agent replies.
//   2. A bar above the thread's message box that counts the marks and sends
//      them to the agent with "Submit replies".
// Why: reviewing long agent output line by line without copying text, and
//   without the agent knowing a tool is involved: what it receives is an
//   ordinary message from the user.
// Design notes:
//   - Sending goes through the composer handle (`useComposer().submit`), the
//     same path as pressing Enter, so BB queues the message if the agent is
//     still working, and the user's provider/model choices apply.
//   - Whatever the user had typed in the message box stays: the replies are
//     added after it and sent together. If sending fails, the message box is
//     restored to what it was and the marks are kept.
//   - Marks are cleared only for the lines that were actually sent, so a mark
//     added while sending survives.

import { useState, useSyncExternalStore } from "react";
import { definePluginApp, useComposer } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { mountLineControls } from "./content.ts";
import { formatReplies, orderMarks } from "./lib/format.ts";
import { marksStore, type LineMark } from "./lib/marks.ts";
import "./app.css";

/**
 * Subscribe a component to one thread's marks.
 * Returns the thread's marks (stable reference between changes); empty when
 * `threadId` is null.
 */
const NO_MARKS: readonly LineMark[] = Object.freeze([]);

function useThreadMarks(threadId: string | null): readonly LineMark[] {
  const store = marksStore();
  // The snapshot must be referentially stable between changes, hence the
  // shared empty array rather than a fresh `[]`.
  return useSyncExternalStore(store.subscribe, () =>
    threadId === null ? NO_MARKS : store.forThread(threadId),
  );
}

/**
 * Position of each timeline row currently on the page, top to bottom, so the
 * sent message follows the conversation's order.
 */
function rowRanks(): Map<string, number> {
  const ranks = new Map<string, number>();
  document.querySelectorAll<HTMLElement>("[data-timeline-row-id]").forEach((row, i) => {
    const id = row.dataset.timelineRowId;
    if (id !== undefined && !ranks.has(id)) ranks.set(id, i);
  });
  return ranks;
}

/** "1 line" / "3 lines". */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The bar above a thread's message box. Renders nothing until the thread has
 * at least one marked line.
 *
 * Post-conditions (on Submit replies): appends the formatted replies to the
 * message box, submits it, and on success removes the sent marks. On
 * failure: restores the message box and shows an error toast.
 */
function RepliesBar() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const marks = useThreadMarks(threadId);
  const [sending, setSending] = useState(false);
  if (threadId === null || marks.length === 0) return null;

  const up = marks.filter((m) => m.vote === "up").length;
  const down = marks.filter((m) => m.vote === "down").length;
  const comments = marks.filter((m) => m.comment.trim() !== "").length;
  const summary = [
    up > 0 ? `${up} 👍` : null,
    down > 0 ? `${down} 👎` : null,
    comments > 0 ? plural(comments, "comment") : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

  const submit = async () => {
    if (sending) return;
    const sent = orderMarks(marks, rowRanks());
    const saved = composer.draft;
    setSending(true);
    try {
      composer.insert(formatReplies(sent), { at: "end", block: true });
      // The SDK requires an options object; `experimental_data` only reaches
      // other plugins' dispatch hooks, never the agent.
      await composer.submit({ experimental_data: null });
      marksStore().remove(threadId, sent);
    } catch (cause) {
      composer.replace(saved);
      toast.error(
        `Replies not sent: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="lr-bar" role="region" aria-label="Line replies">
      <span className="lr-bar-summary">
        Replies on {plural(marks.length, "line")}: {summary}
      </span>
      <button
        type="button"
        className="lr-text-button"
        disabled={sending}
        onClick={() => marksStore().clearThread(threadId)}
      >
        Clear
      </button>
      <button
        type="button"
        className="lr-text-button lr-primary"
        disabled={sending}
        onClick={() => void submit()}
      >
        {sending ? "Sending…" : "Submit replies"}
      </button>
    </div>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "line-controls",
    mount: ({ signal }) => mountLineControls(signal),
  });
  app.composer.customize({
    id: "replies-bar",
    scopes: ["thread"],
    banners: [{ id: "replies", chrome: "bare", component: RepliesBar }],
  });
});
