// bb-plugin-quick-reply — frontend entry.
//
// What: registers the two halves of Quick Reply.
//   1. A content script (content.ts) that puts agree / disagree / tell-me-more /
//      comment buttons on each line of agent replies.
//   2. A bar above the thread's message box with mark navigation, Clear, and
//      "Submit replies", which sends the marks to the agent.
// Why: reviewing long agent output line by line without copying text, and
//   without the agent knowing a tool is involved: what it receives is an
//   ordinary message from the user.
// Design notes:
//   - Sending goes through the composer handle (`useComposer().submit`), the
//     same path as pressing Enter, so BB queues the message if the agent is
//     still working, and the user's provider/model choices apply.
//   - The arrow, Enter, and Submit replies send one message. The marked
//     replies come first, followed by the user's note. If sending fails, the draft is
//     restored to what it was and the marks are kept.
//   - Marks are cleared only for the lines that were actually sent, so a mark
//     added while sending survives.
//   - Files on comments are already uploaded (lib/attachments.ts). Sending
//     adds them to the draft next to whatever the user attached there, so they
//     reach the agent like files attached by hand.
//   - The bar’s ↑ / ↓ buttons scroll the chat to marked lines.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { definePluginApp, useComposer, useSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { jumpToMark, mountLineControls, rowRanks } from "./content.ts";
import { setAttachmentClient } from "./lib/attachments.ts";
import { orderMarks } from "./lib/format.ts";
import { iconPaths, type IconName } from "./lib/icons.ts";
import type { Direction } from "./lib/step.ts";
import { marksStore, type LineMark } from "./lib/marks.ts";
import { interceptSend, submitReplies } from "./lib/send.ts";
import "./app.css";

/**
 * Subscribe a component to one thread's marks.
 * Returns the thread's marks (stable reference between changes); empty when
 * `threadId` is null.
 */
const NO_MARKS: readonly LineMark[] = Object.freeze([]);
const submittingDrafts = new Set<string>();

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

/** "1 line" / "3 lines". */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The bar above a thread's message box. Renders nothing until the thread has
 * at least one marked line.
 *
 * Post-conditions (on ↑ / ↓): scrolls the chat to the previous / next marked
 * line and flashes it; shows a toast when that line cannot be found.
 *
 * Post-conditions (on send): puts the replies before the general note,
 * submits the draft, and on success removes the sent marks. On
 * failure: restores the message box and shows an error toast.
 */
function RepliesBar() {
  const composer = useComposer();
  const draftKey = composer.key;
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const marks = useThreadMarks(threadId);
  const [sending, setSending] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const send = useRef<() => void>(() => {});
  const sdk = useSdk();
  // Runs even while the bar shows nothing: the comment box needs the client to
  // upload the first file of a line that has no mark yet.
  useEffect(() => setAttachmentClient(sdk), [sdk]);

  const submit = async () => {
    if (threadId === null || submittingDrafts.has(draftKey) || composer.isSubmitting) return;
    const store = marksStore();
    const sent = orderMarks(store.forThread(threadId), rowRanks());
    if (sent.length === 0) return;
    submittingDrafts.add(draftKey);
    setSending(true);
    try {
      await submitReplies(composer, sent);
      const current = store.forThread(threadId);
      store.remove(threadId, sent.filter((mark) => current.includes(mark)));
    } catch (cause) {
      toast.error(
        `Replies not sent: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      submittingDrafts.delete(draftKey);
      setSending(false);
    }
  };
  send.current = () => void submit();

  const hasMarks = marks.length > 0;
  useEffect(() => {
    if (threadId === null || !hasMarks || bar.current === null) return;
    return interceptSend(
      bar.current,
      () => submittingDrafts.has(draftKey) || marksStore().forThread(threadId).length > 0,
      () => send.current(),
    );
  }, [draftKey, threadId, hasMarks]);
  if (threadId === null || marks.length === 0) return null;

  const up = marks.filter((m) => m.vote === "up").length;
  const down = marks.filter((m) => m.vote === "down").length;
  const questions = marks.filter((m) => m.vote === "question").length;
  const comments = marks.filter((m) => m.comment.trim() !== "").length;
  const fileCount = marks.reduce((total, m) => total + m.attachments.length, 0);
  const summary = [
    up > 0 ? `${up} agreed` : null,
    down > 0 ? `${down} disagreed` : null,
    questions > 0 ? plural(questions, "question") : null,
    comments > 0 ? plural(comments, "comment") : null,
    fileCount > 0 ? plural(fileCount, "file") : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

  const jump = async (direction: Direction) => {
    const result = await jumpToMark(threadId, direction);
    if (result === "missing") {
      toast("Couldn't find that line in the chat. The reply may have changed since you marked it.");
    }
  };

  return (
    <div ref={bar} className="lr-bar" role="region" aria-label="Line replies">
      <IconButton icon="arrow-up" label="Previous marked line" onClick={() => void jump("previous")} />
      <IconButton icon="arrow-down" label="Next marked line" onClick={() => void jump("next")} />
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
