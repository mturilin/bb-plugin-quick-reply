import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComposerDraftSnapshot, PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { Window } from "happy-dom";
import type { LineMark } from "./marks.ts";
import { interceptSend, submitReplies } from "./send.ts";

test("only the owning composer intercepts its send arrow and plain Enter", () => {
  const window = new Window();
  window.document.body.innerHTML = `
    <div data-app-composer>
      <div id="bar"></div>
      <div data-promptbox-editor-content><div id="editor" contenteditable="true"></div></div>
      <button type="submit" data-promptbox-submit-action><span id="arrow"></span></button>
      <button type="submit" data-promptbox-submit-action disabled id="disabled"></button>
      <button type="button" data-promptbox-submit-action id="stop"></button>
      <button type="button" id="options"></button>
      <div data-app-composer>
        <button type="submit" data-promptbox-submit-action id="other"></button>
      </div>
    </div>`;
  const $ = (id: string) => window.document.getElementById(id)!;
  let sends = 0;
  let hasReplies = true;
  const dispose = interceptSend($("bar") as unknown as HTMLElement, () => hasReplies, () => sends++);
  const click = (id: string) => {
    const event = new window.MouseEvent("click", { bubbles: true, cancelable: true });
    $(id).dispatchEvent(event);
    return !event.defaultPrevented;
  };
  const enter = (options = {}) => $("editor").dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options }),
  );

  assert.equal(click("arrow"), false);
  assert.equal(enter(), false);
  assert.equal(enter({ repeat: true }), false);
  assert.equal(enter({ shiftKey: true }), true);
  assert.equal(enter({ metaKey: true }), true);
  assert.equal(enter({ isComposing: true }), true);
  for (const id of ["disabled", "stop", "options", "other"]) assert.equal(click(id), true);

  const menu = window.document.createElement("div");
  menu.setAttribute("data-promptbox-typeahead-menu", "");
  $("bar").after(menu);
  assert.equal(enter(), true);
  menu.remove();

  hasReplies = false;
  assert.equal(click("arrow"), true);
  assert.equal(enter(), true);
  hasReplies = true;
  dispose();
  assert.equal(click("arrow"), true);
  assert.equal(enter(), true);
  assert.equal(sends, 2);
});

const screenshot = { type: "localImage", path: "screenshot.png", name: "screenshot.png" } as const;
const nativeFile = { type: "localFile", path: "notes.txt", name: "notes.txt" } as const;
const mark: LineMark = {
  rowId: "row", text: "First paragraph", occurrence: 0, index: 0, vote: null,
  comment: "See screenshot", attachments: [screenshot], updatedAt: 0,
};
const saved: ComposerDraftSnapshot = {
  text: "Summary for Project",
  mentions: [{ kind: "project", projectId: "proj_test", label: "Project", from: 12, to: 19 }],
  attachments: [nativeFile],
};

function fakeComposer(initial: ComposerDraftSnapshot, send: (draft: ComposerDraftSnapshot) => void) {
  let draft = initial;
  const locks: boolean[] = [];
  const composer = {
    get draft() { return draft; },
    replace(next) {
      const replacement = typeof next === "function" ? next(draft) : next;
      draft = { ...replacement, attachments: replacement.attachments ?? draft.attachments };
    },
    setInputLock(active) { locks.push(active); },
    async submit() { send(draft); },
  } satisfies Pick<PluginComposerApi, "draft" | "replace" | "setInputLock" | "submit">;
  return { composer: composer as PluginComposerApi, locks };
}

test("submits the ordered comments, note, mentions, and both kinds of attachment once", async () => {
  const sent: ComposerDraftSnapshot[] = [];
  const { composer, locks } = fakeComposer(saved, (draft) => sent.push(draft));
  await submitReplies(composer, [mark, { ...mark, text: "Second paragraph", attachments: [] }]);

  assert.equal(sent.length, 1);
  const [draft] = sent;
  assert.equal(draft.text, [
    "My replies, line by line:",
    "> First paragraph\nComment: See screenshot\nAttached: screenshot.png (screenshot.png)",
    "> Second paragraph\nComment: See screenshot",
    "---",
    saved.text,
  ].join("\n\n"));
  assert.deepEqual(draft.attachments, [nativeFile, screenshot]);
  const [mention] = draft.mentions;
  assert.equal(draft.text.slice(mention.from, mention.to), "Project");
  assert.equal(mention.projectId, "proj_test");
  assert.deepEqual(locks, [true, false]);
});

test("submits a screenshot-only reply when the composer is empty", async () => {
  const { composer } = fakeComposer({ text: "", attachments: [], mentions: [] }, (draft) => {
    assert.equal(draft.text, "My replies, line by line:\n\n> First paragraph\nAttached: screenshot.png (screenshot.png)");
    assert.deepEqual(draft.attachments, [screenshot]);
  });
  await submitReplies(composer, [{ ...mark, comment: "" }]);
});

test("restores the draft on failure and keeps a native file that finished uploading", async () => {
  const lateFile = { ...nativeFile, path: "late.txt", name: "late.txt" };
  const { composer, locks } = fakeComposer(saved, (draft) => {
    composer.replace({ ...draft, attachments: [...draft.attachments, lateFile] });
    throw new Error("Send rejected");
  });
  await assert.rejects(submitReplies(composer, [mark]), /Send rejected/);
  assert.deepEqual(composer.draft, { ...saved, attachments: [nativeFile, lateFile] });
  assert.deepEqual(locks, [true, false]);
});

test("does not submit if BB never applies the combined draft", async () => {
  const { composer, locks } = fakeComposer(saved, () => assert.fail("Unexpected submission"));
  composer.replace = () => {};

  await assert.rejects(submitReplies(composer, [mark]), /did not apply the combined draft/);
  assert.equal(composer.draft, saved);
  assert.deepEqual(locks, [true, false]);
});
