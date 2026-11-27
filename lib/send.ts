import type { ComposerDraftSnapshot, PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { formatReplies, withReplies } from "./format.ts";
import type { LineMark } from "./marks.ts";

const COMPOSER = "[data-app-composer]";
const SEND_BUTTON = "button[type='submit'][data-promptbox-submit-action]:not([disabled])";
const EDITOR = "[data-promptbox-editor-content] [contenteditable='true']";
const TYPEAHEAD_MENU = "[data-promptbox-typeahead-menu]";

/** Intercept the desktop send controls for the composer that owns this banner. */
export function interceptSend(
  bar: HTMLElement,
  hasReplies: () => boolean,
  send: () => void,
): () => void {
  const appWindow = bar.ownerDocument.defaultView;
  const root = bar.closest(COMPOSER);
  if (appWindow === null || root === null) return () => {};
  const { Element: ComposerElement } = appWindow;

  function targetInComposer(event: Event): Element | null {
    const target = event.target;
    return !event.defaultPrevented && target instanceof ComposerElement &&
      target.closest(COMPOSER) === root ? target : null;
  }

  function take(event: Event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onClick(event: MouseEvent) {
    if (event.button !== 0 || !targetInComposer(event)?.closest(SEND_BUTTON) || !hasReplies()) return;
    take(event);
    send();
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    const editor = targetInComposer(event)?.closest(EDITOR);
    if (!editor || root.querySelector(TYPEAHEAD_MENU) || !hasReplies()) return;
    take(event);
    if (!event.repeat) send();
  };

  appWindow.addEventListener("click", onClick, true);
  appWindow.addEventListener("keydown", onKeyDown, true);
  return () => {
    appWindow.removeEventListener("click", onClick, true);
    appWindow.removeEventListener("keydown", onKeyDown, true);
  };
}

/** Wait for BB to expose the replacement through its composer handle before submitting. */
async function waitForDraft(composer: PluginComposerApi, expected: ComposerDraftSnapshot) {
  const matches = (draft: ComposerDraftSnapshot) =>
    draft.text === expected.text &&
    draft.mentions.length === expected.mentions.length &&
    expected.mentions.every((mention, index) =>
      draft.mentions[index]?.from === mention.from && draft.mentions[index]?.to === mention.to,
    ) &&
    draft.attachments.length >= expected.attachments.length &&
    expected.attachments.every((file, index) => {
      const actual = draft.attachments[index];
      return actual?.path === file.path && actual.type === file.type &&
        actual.sourceProjectId === file.sourceProjectId;
    });
  for (let tries = 0; tries < 50; tries += 1) {
    if (matches(composer.draft)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("BB did not apply the combined draft.");
}

export async function submitReplies(composer: PluginComposerApi, marks: readonly LineMark[]) {
  const files = marks.flatMap((mark) => mark.attachments);
  const replies = formatReplies(marks);
  const saved = composer.draft;
  const text = withReplies(saved.text, replies);
  const offset = text.length - saved.text.trimEnd().length;
  const prepared = {
    text,
    mentions: saved.mentions.map((mention) => ({
      ...mention,
      from: mention.from + offset,
      to: mention.to + offset,
    })),
    attachments: [...saved.attachments, ...files],
  };

  composer.setInputLock(true);
  try {
    composer.replace(prepared);
    await waitForDraft(composer, prepared);
    await composer.submit({ experimental_data: null });
  } catch (error) {
    // A failed host submission restores the combined draft. Restore the user's
    // text and keep files from any native uploads that completed meanwhile.
    composer.replace((draft) => {
      if (draft.text !== prepared.text) return draft;
      return {
        ...saved,
        attachments: [...saved.attachments, ...draft.attachments.slice(prepared.attachments.length)],
      };
    });
    throw error;
  } finally {
    composer.setInputLock(false);
  }
}
