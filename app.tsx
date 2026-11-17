// bb-plugin-quick-reply — frontend entry.
//
// What: registers the two halves of Quick Reply.
//   1. A content script (content.ts) that puts agree / disagree / tell-me-more /
//      comment buttons on each line of agent replies.
//   2. A bar above the thread's message box: "↑ Replies: N ↓", Clear, and
//      "Submit replies", which sends the marks to the agent.
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
//   - The bar shows only how many lines are marked. ↑ / ↓ scroll the chat to
//     each marked line in turn (content.ts, jumpToMark), so the user can check
//     what they are sending once the lines have scrolled away. Which mark is
//     current is deliberately not shown.

import { useState, useSyncExternalStore } from "react";
import { definePluginApp, useComposer } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { jumpToMark, mountLineControls, rowRanks } from "./content.ts";
import { formatReplies, orderMarks } from "./lib/format.ts";
import { iconPaths, type IconName } from "./lib/icons.ts";
import type { Direction } from "./lib/step.ts";
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
 * One icon-only button of the bar (↑ / ↓), styled like the line toolbar's.
 * `onPointerDown` keeps focus in the message box when it is clicked.
 */
function IconButton(props: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="lr-button"
      title={props.label}
      aria-label={props.label}
      onPointerDown={(event) => event.preventDefault()}
      onClick={props.onClick}
    >
      <svg
        className="lr-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {iconPaths(props.icon).map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    </button>
  );
}

/**
 * The bar above a thread's message box. Renders nothing until the thread has
 * at least one marked line.
 *
 * Post-conditions (on ↑ / ↓): scrolls the chat to the previous / next marked
 * line and flashes it; shows a toast when that line cannot be found.
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

  const jump = async (direction: Direction) => {
    const result = await jumpToMark(threadId, direction);
    if (result === "missing") {
      toast("Couldn't find that line in the chat. The reply may have changed since you marked it.");
    }
  };

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
      <span className="lr-nav">
        <IconButton icon="arrow-up" label="Previous marked line" onClick={() => void jump("previous")} />
        <span className="lr-count">Replies: {marks.length}</span>
        <IconButton icon="arrow-down" label="Next marked line" onClick={() => void jump("next")} />
      </span>
      <span className="lr-spacer" />
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
