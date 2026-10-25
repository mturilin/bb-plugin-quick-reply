// Tests for lib/lines.ts against Markdown HTML shaped like BB's (bb 0.46).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";
import { extractUnits, normalize, occurrences } from "./lines.ts";

function root(html: string): Element {
  const window = new Window();
  const div = window.document.createElement("div");
  div.setAttribute("data-markdown-preview", "");
  div.innerHTML = html;
  return div as unknown as Element;
}

const texts = (html: string) => extractUnits(root(html)).map((u) => u.text);

test("paragraphs and list items are lines; headings and rules are not", () => {
  assert.deepEqual(
    texts(`<h2>Plan</h2><p>First <strong>step</strong>.</p><hr><ul><li>One</li><li>Two <code>x</code></li></ul><ol><li>Three</li></ol>`),
    ["First step.", "One", "Two x", "Three"],
  );
});

test("a list item with a nested list keeps only its own text", () => {
  assert.deepEqual(
    texts(`<ol><li><strong>Parent</strong><ul><li>Child A</li><li>Child B</li></ul></li><li>Next</li></ol>`),
    ["Parent", "Child A", "Child B", "Next"],
  );
});

test("block quotes are descended into", () => {
  assert.deepEqual(texts(`<blockquote><p>Quoted</p><p>Again</p></blockquote>`), ["Quoted", "Again"]);
});

test("table body rows are lines; header rows are not", () => {
  assert.deepEqual(
    texts(`<div class="overflow-x-auto"><table><thead><tr><th>Name</th><th>Why</th></tr></thead><tbody><tr><td>A</td><td>fast</td></tr><tr><td>B</td><td>cheap</td></tr></tbody></table></div>`),
    ["A | fast", "B | cheap"],
  );
});

test("a code block wrapper is one line holding just the code", () => {
  const units = extractUnits(root(`<div class="code"><div class="header"><span>ts</span><button>Copy</button></div><pre><code>const a = 1;\nconst b = 2;\n</code></pre></div>`));
  assert.equal(units.length, 1);
  assert.equal(units[0]!.text, "const a = 1;\nconst b = 2;");
  assert.equal(units[0]!.el.className, "code");
});

test("empty elements produce no lines", () => {
  assert.deepEqual(texts(`<p>  </p><ul><li></li></ul>`), []);
});

test("normalize and occurrences", () => {
  assert.equal(normalize("  a \n  b "), "a b");
  assert.deepEqual(occurrences(["x", "y", "x", "x"]), [0, 0, 1, 2]);
});
