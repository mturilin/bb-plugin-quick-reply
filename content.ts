// content.ts — puts agree / disagree / tell-me-more / comment controls on each
//   line of agent replies.
//
// What: a BB content script that finds agent replies in the chat, marks each
//   reviewable line, shows a small floating toolbar on the line under the
//   pointer, and a floating comment box when the comment button is pressed.
// Why: the user wants to react to long agent output line by line, in place,
//   without copying text and without the agent knowing a tool is involved.
//   BB offers no slot inside ordinary replies, so this works on the page.
// Design notes:
//   - BB's own elements get only `data-lr-*` attributes. React leaves
//     attributes it does not manage alone, so this cannot break BB's
//     rendering. Every visible control lives in one layer appended to
//     <body>, positioned over the chat with `position: fixed`.
//   - Votes and comments on a line are painted with CSS from those attributes
//     (a colored edge, the comment text via `::after attr()`), so marks stay
//     visible without inserting nodes into BB's tree.
//   - Agent replies are rows whose `data-timeline-row-id` contains
//     ":assistant:"; the thread id is the part before the first ":". Both
//     were observed on bb 0.46 and are not a published API: if a BB update
//     changes them, the controls stop appearing and nothing else breaks.
//   - BB's timeline unloads rows far from the viewport and re-renders replies
//     while they stream, so a MutationObserver re-scans (debounced). Marks
//     are keyed by line text, not by element, and survive this.
// Gotchas:
//   - The observer watches child and text changes only, never attributes, so
//     painting does not re-trigger it. Changes inside our own layer are
//     ignored.
//   - Everything created here is removed when the signal aborts (plugin
//     reload, disable, or BB shutdown).

import { createIcon, type IconName } from "./lib/icons.ts";
import { extractUnits, occurrences } from "./lib/lines.ts";
import { marksStore, sameLine, STORAGE_KEY, type LineRef, type Vote } from "./lib/marks.ts";

const ROW_SELECTOR = "[data-timeline-row-id]";
const MARKDOWN_SELECTOR = "[data-markdown-preview]";
const VIEWPORT_SELECTOR = "[data-page-scroll-viewport]";
const UNIT_ATTR = "data-lr-unit";
const VOTE_ATTR = "data-lr-vote";
const COMMENT_ATTR = "data-lr-comment";
const HOVER_ATTR = "data-lr-hover";
const RESCAN_DELAY_MS = 120;
const HIDE_DELAY_MS = 250;

/** What a decorated line element stands for. */
interface Binding {
  threadId: string;
  ref: LineRef;
  /** The reply's Markdown root; the toolbar lines up with its right edge. */
  markdown: HTMLElement;
}

/** The thread id prefix of a timeline row id, or null if it has none. */
export function threadIdOfRow(rowId: string): string | null {
  const colon = rowId.indexOf(":");
  return colon > 0 ? rowId.slice(0, colon) : null;
}

/** True for rows that hold an agent (assistant) message. */
export function isAssistantRow(rowId: string): boolean {
  return rowId.includes(":assistant:");
}

/** Set or remove an attribute, touching the DOM only when the value changes. */
function setAttr(el: Element, name: string, value: string | null) {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

/**
 * The element that shows a line's comment. A table row cannot hold a block
 * `::after`, so its last cell does.
 */
function commentTarget(el: HTMLElement): Element {
  return el.tagName === "TR" ? (el.lastElementChild ?? el) : el;
}

/** The visible bounds the controls must stay within for `el`. */
function viewportRect(el: Element): DOMRect {
  const viewport = el.closest(VIEWPORT_SELECTOR);
  return viewport?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
}

/**
 * One toolbar button.
 *
 * @param kind - which verdict it sets ("up", "down", "question") or
 *   "comment"; app.css colors the pressed state by it.
 */
function button(
  kind: string,
  label: string,
  icon: IconName,
  onClick: () => void,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "lr-button";
  b.dataset.kind = kind;
  b.append(createIcon(document, icon));
  b.title = label;
  b.setAttribute("aria-label", label);
  // Keep focus (and any text selection) where it was when clicking.
  b.addEventListener("pointerdown", (event) => event.preventDefault());
  b.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return b;
}

/**
 * Install the line controls into the BB window.
 *
 * @param signal - aborted when the plugin frontend is replaced or stopped.
 * Pre-conditions: runs in the BB app page with `document.body` present.
 * Post-conditions (side effects): appends one layer element to <body>; adds
 *   `data-lr-*` attributes to lines of agent replies; adds document and
 *   window listeners and a MutationObserver. All of it is undone by the
 *   returned disposer, which also runs when `signal` aborts.
 * Returns the disposer.
 */
export function mountLineControls(signal: AbortSignal): () => void {
  const store = marksStore();
  const bindings = new WeakMap<HTMLElement, Binding>();
  let decorated = new Set<HTMLElement>();
  let active: HTMLElement | null = null; // line under the toolbar
  let editing: { el: HTMLElement; binding: Binding } | null = null;
  let rescanTimer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- floating layer ---------------------------------------------------
  const layer = document.createElement("div");
  layer.className = "lr-layer";

  const toolbar = document.createElement("div");
  toolbar.className = "lr-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Reply to this line");
  toolbar.hidden = true;
  const upButton = button("up", "Agree with this line", "thumb-up", () => vote("up"));
  const downButton = button("down", "Disagree with this line", "thumb-down", () => vote("down"));
  const questionButton = button("question", "Ask for more detail on this line", "help-circle", () =>
    vote("question"),
  );
  const commentButton = button("comment", "Comment on this line", "message", () => {
    if (active !== null) openEditor(active);
  });
  toolbar.append(upButton, downButton, questionButton, commentButton);

  const editor = document.createElement("div");
  editor.className = "lr-editor";
  editor.hidden = true;
  const textarea = document.createElement("textarea");
  textarea.className = "lr-textarea";
  textarea.rows = 3;
  textarea.placeholder = "Comment on this line";
  textarea.setAttribute("aria-label", "Comment on this line");
  const hint = document.createElement("span");
  hint.className = "lr-hint";
  hint.textContent = "Enter to save · Shift+Enter for a new line · Esc to cancel";
  const actions = document.createElement("div");
  actions.className = "lr-editor-actions";
  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "lr-text-button";
  removeButton.textContent = "Remove";
  removeButton.addEventListener("click", () => saveEditor(""));
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "lr-text-button";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", () => closeEditor());
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "lr-text-button lr-primary";
  saveButton.textContent = "Save";
  saveButton.addEventListener("click", () => saveEditor(textarea.value));
  actions.append(hint, removeButton, cancelButton, saveButton);
  editor.append(textarea, actions);

  layer.append(toolbar, editor);
  document.body.append(layer);

  // ---- scanning and painting ---------------------------------------------

  /** Paint one line from its stored mark. */
  function paint(el: HTMLElement, binding: Binding) {
    const mark = store.find(binding.threadId, binding.ref);
    setAttr(el, UNIT_ATTR, "");
    setAttr(el, VOTE_ATTR, mark?.vote ?? null);
    const comment = mark?.comment.trim() ?? "";
    setAttr(commentTarget(el), COMMENT_ATTR, comment === "" ? null : comment);
  }

  function unpaint(el: HTMLElement) {
    for (const name of [UNIT_ATTR, VOTE_ATTR, HOVER_ATTR]) setAttr(el, name, null);
    setAttr(commentTarget(el), COMMENT_ATTR, null);
  }

  /**
   * Find every line of every agent reply on the page, bind and paint it, and
   * clear lines that are gone or no longer lines.
   */
  function scan() {
    rescanTimer = null;
    const next = new Set<HTMLElement>();
    for (const markdown of Array.from(document.querySelectorAll<HTMLElement>(MARKDOWN_SELECTOR))) {
      const row = markdown.closest<HTMLElement>(ROW_SELECTOR);
      const rowId = row?.dataset.timelineRowId;
      if (rowId === undefined || !isAssistantRow(rowId)) continue;
      const threadId = threadIdOfRow(rowId);
      if (threadId === null) continue;
      const units = extractUnits(markdown);
      const counts = occurrences(units.map((u) => u.text));
      units.forEach((unit, index) => {
        const binding: Binding = {
          threadId,
          markdown,
          ref: { rowId, text: unit.text, occurrence: counts[index]!, index },
        };
        bindings.set(unit.el, binding);
        next.add(unit.el);
        paint(unit.el, binding);
      });
    }
    for (const el of decorated) if (!next.has(el)) unpaint(el);
    decorated = next;
    if (active !== null && !next.has(active)) active = relocate(active);
    if (editing !== null && !next.has(editing.el)) {
      const el = findLine(editing.binding.threadId, editing.binding.ref);
      if (el !== null) editing = { el, binding: bindings.get(el)! };
    }
    positionAll();
  }

  /** The element currently showing `ref`, if it is on the page. */
  function findLine(threadId: string, ref: LineRef): HTMLElement | null {
    for (const el of decorated) {
      const b = bindings.get(el);
      if (b !== undefined && b.threadId === threadId && sameLine(b.ref, ref)) return el;
    }
    return null;
  }

  function relocate(el: HTMLElement): HTMLElement | null {
    const b = bindings.get(el);
    return b === undefined ? null : findLine(b.threadId, b.ref);
  }

  function scheduleScan() {
    if (rescanTimer === null) rescanTimer = setTimeout(scan, RESCAN_DELAY_MS);
  }

  // ---- toolbar -------------------------------------------------------------

  function refreshPressed() {
    const binding = active === null ? undefined : bindings.get(active);
    const mark = binding === undefined ? undefined : store.find(binding.threadId, binding.ref);
    upButton.setAttribute("aria-pressed", String(mark?.vote === "up"));
    downButton.setAttribute("aria-pressed", String(mark?.vote === "down"));
    questionButton.setAttribute("aria-pressed", String(mark?.vote === "question"));
    commentButton.setAttribute("aria-pressed", String((mark?.comment.trim() ?? "") !== ""));
  }

  function show(el: HTMLElement) {
    cancelHide();
    if (active !== el) {
      if (active !== null) setAttr(active, HOVER_ATTR, null);
      active = el;
      setAttr(el, HOVER_ATTR, "");
    }
    refreshPressed();
    toolbar.hidden = false;
    positionToolbar();
  }

  function hide() {
    hideTimer = null;
    if (active !== null) setAttr(active, HOVER_ATTR, null);
    active = null;
    toolbar.hidden = true;
  }

  function scheduleHide() {
    if (hideTimer === null && active !== null) hideTimer = setTimeout(hide, HIDE_DELAY_MS);
  }

  function cancelHide() {
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = null;
  }

  /**
   * Put the toolbar beside the active line: right of the reply when there is
   * room inside the chat viewport, otherwise over the reply's right edge.
   *
   * Inside the reply, the toolbar must not cover BB's own controls in the
   * line. A code block's header holds a "Copy code" button in its top-right
   * corner, exactly where the toolbar lands, so the toolbar steps left of any
   * button or link it would overlap (found by `shiftClearOf`).
   */
  function positionToolbar() {
    if (active === null || toolbar.hidden) return;
    const binding = bindings.get(active);
    const line = active.getBoundingClientRect();
    const bounds = viewportRect(active);
    if (
      binding === undefined ||
      !active.isConnected ||
      line.height === 0 ||
      line.bottom < bounds.top ||
      line.top > bounds.bottom
    ) {
      hide();
      return;
    }
    const reply = binding.markdown.getBoundingClientRect();
    const width = toolbar.offsetWidth;
    const height = toolbar.offsetHeight;
    let left = reply.right + 6;
    const top = Math.min(Math.max(line.top, bounds.top + 2), bounds.bottom - height - 2);
    if (left + width > bounds.right - 4) {
      left = shiftClearOf(active, reply.right - width, top, width, height);
      left = Math.max(left, reply.left);
    }
    toolbar.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  /**
   * Move a toolbar placed at (`left`, `top`) leftwards until it overlaps none
   * of the clickable elements inside `line` (BB's copy buttons, links).
   *
   * Returns the new left edge; unchanged when nothing is in the way.
   */
  function shiftClearOf(line: HTMLElement, left: number, top: number, width: number, height: number): number {
    const controls = Array.from(line.querySelectorAll("button, a[href], [role='button']"))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0 && r.bottom > top && r.top < top + height)
      .sort((a, b) => b.right - a.right);
    for (const r of controls) {
      if (r.right > left && r.left < left + width) left = r.left - width - 4;
    }
    return left;
  }

  function vote(value: Exclude<Vote, null>) {
    const binding = active === null ? undefined : bindings.get(active);
    if (binding === undefined) return;
    const current = store.find(binding.threadId, binding.ref)?.vote ?? null;
    // Pressing the same vote again takes it back.
    store.update(binding.threadId, binding.ref, { vote: current === value ? null : value });
  }

  // ---- comment editor ------------------------------------------------------

  function openEditor(el: HTMLElement) {
    const binding = bindings.get(el);
    if (binding === undefined) return;
    if (editing !== null && editing.el !== el) saveEditor(textarea.value);
    editing = { el, binding };
    textarea.value = store.find(binding.threadId, binding.ref)?.comment ?? "";
    editor.hidden = false;
    positionEditor();
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  function saveEditor(value: string) {
    if (editing === null) return;
    store.update(editing.binding.threadId, editing.binding.ref, { comment: value.trim() });
    closeEditor();
  }

  function closeEditor() {
    editing = null;
    editor.hidden = true;
  }

  /** Put the comment box under its line, or above it near the bottom edge. */
  function positionEditor() {
    if (editing === null || editor.hidden) return;
    const el = editing.el;
    const bounds = viewportRect(el);
    if (!el.isConnected) {
      // The line scrolled out of the loaded window; keep the box where it was.
      return;
    }
    const line = el.getBoundingClientRect();
    const left = Math.max(bounds.left + 4, line.left);
    const width = Math.max(260, Math.min(560, bounds.right - left - 8));
    editor.style.width = `${Math.round(width)}px`;
    const height = editor.offsetHeight;
    let top = line.bottom + 6;
    if (top + height > bounds.bottom - 4) top = Math.max(bounds.top + 4, line.top - height - 6);
    editor.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function positionAll() {
    if (active !== null && !toolbar.hidden) {
      refreshPressed();
      positionToolbar();
    }
    positionEditor();
  }

  // ---- events --------------------------------------------------------------

  function onPointerOver(event: PointerEvent) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (layer.contains(target)) {
      cancelHide();
      return;
    }
    const line = target.closest<HTMLElement>(`[${UNIT_ATTR}]`);
    if (line !== null && bindings.has(line)) show(line);
    else scheduleHide();
  }

  function onPointerDown(event: PointerEvent) {
    // Clicking elsewhere while commenting keeps what was typed.
    if (editing !== null && event.target instanceof Node && !editor.contains(event.target)) {
      saveEditor(textarea.value);
    }
  }

  /**
   * The line whose displayed comment sits under the point (x, y), or null.
   *
   * The comment is drawn by CSS as the line's `::after` box, which the DOM
   * cannot hit-test on its own: a click on it lands on the line element.
   * So the comment's area is worked out from the pseudo-element's computed
   * height: the band just above the element's bottom padding.
   */
  function commentAt(target: Element, x: number, y: number): HTMLElement | null {
    const holder = target.closest<HTMLElement>(`[${COMMENT_ATTR}]`);
    if (holder === null) return null;
    const line = holder.closest<HTMLElement>(`[${UNIT_ATTR}]`);
    if (line === null || !bindings.has(line)) return null;
    const after = getComputedStyle(holder, "::after");
    const height = parseFloat(after.height) + parseFloat(after.marginTop || "0");
    if (!Number.isFinite(height) || height <= 0) return null;
    const box = holder.getBoundingClientRect();
    const bottom = box.bottom - parseFloat(getComputedStyle(holder).paddingBottom || "0");
    const inside = y >= bottom - height && y <= bottom && x >= box.left && x <= box.right;
    return inside ? line : null;
  }

  /** Clicking a comment shown under a line opens it for editing. */
  function onClick(event: MouseEvent) {
    if (!(event.target instanceof Element) || layer.contains(event.target)) return;
    const line = commentAt(event.target, event.clientX, event.clientY);
    if (line === null) return;
    event.preventDefault();
    event.stopPropagation();
    openEditor(line);
  }

  function onEditorKey(event: KeyboardEvent) {
    // Keep BB's own shortcuts from seeing keys typed into the comment box.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      closeEditor();
    } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      saveEditor(textarea.value);
    }
  }

  function onStorage(event: StorageEvent) {
    if (event.key === null || event.key === STORAGE_KEY) store.reload();
  }

  const observer = new MutationObserver((mutations) => {
    if (mutations.every((m) => layer.contains(m.target))) return;
    scheduleScan();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  const listen = { capture: true, passive: true } as const;
  document.addEventListener("pointerover", onPointerOver, listen);
  document.addEventListener("pointerdown", onPointerDown, listen);
  // Not passive: a click on a comment is consumed so BB does not also act on it.
  document.addEventListener("click", onClick, { capture: true });
  document.addEventListener("scroll", positionAll, listen);
  window.addEventListener("resize", positionAll, listen);
  window.addEventListener("storage", onStorage);
  textarea.addEventListener("keydown", onEditorKey);
  editor.addEventListener("keyup", (event) => event.stopPropagation());
  const unsubscribe = store.subscribe(scheduleScan);

  scan();

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    unsubscribe();
    document.removeEventListener("pointerover", onPointerOver, listen);
    document.removeEventListener("pointerdown", onPointerDown, listen);
    document.removeEventListener("click", onClick, { capture: true });
    document.removeEventListener("scroll", positionAll, listen);
    window.removeEventListener("resize", positionAll, listen);
    window.removeEventListener("storage", onStorage);
    if (rescanTimer !== null) clearTimeout(rescanTimer);
    cancelHide();
    for (const el of decorated) unpaint(el);
    decorated.clear();
    layer.remove();
  }
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
