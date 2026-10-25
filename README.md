# Line Review (bb-plugin-line-review)

A BB plugin for reviewing long agent replies line by line. Hover over any line
of an agent's reply to get 👍, 👎 and 💬. When you're done, press **Submit
replies** above the message box. The agent receives one ordinary message from
you, with each line you marked quoted and your reaction under it:

```
My replies, line by line:

> Use Postgres for the job queue
👍

> Retry failed jobs 5 times with exponential backoff
👎 3 retries is enough
```

The agent is never told the plugin exists. The plugin has no skill, CLI
command or agent tool, and the message reads like something you typed.

## Using it

- **Vote:** hover a line, click 👍 or 👎. Click the same one again to take it
  back.
- **Comment:** click 💬, type, press Enter to save (Shift+Enter for a new
  line, Esc to cancel). Clicking elsewhere also saves. Clear the text, or
  press **Remove**, to delete a comment.
- **Send:** the bar above the message box shows how many lines you marked.
  **Submit replies** sends them right away, or queues them if the agent is
  still working. Anything already typed in the message box is sent along,
  with the replies after it. **Clear** drops every mark in the thread.

What counts as a line: each paragraph, list item, table row (not the header)
and code block. Headings and horizontal rules get no controls. A list item
with a nested list is one line for its own text; the nested items are lines
of their own.

Marks are saved in this BB window's local storage per thread, so switching
threads, scrolling and reloading BB keep them. Marks untouched for 30 days
are dropped.

## How it works

| File | Role |
| --- | --- |
| `content.ts` | Content script. Finds agent replies on the page, tags each line with `data-lr-*` attributes, and draws the floating toolbar and comment box. |
| `lib/lines.ts` | Splits a rendered reply into lines. |
| `lib/marks.ts` | The marks store, shared by the content script and the bar, kept in localStorage. |
| `lib/format.ts` | Builds the message sent to the agent. |
| `app.tsx` | Registers the content script and the bar above the message box (a composer banner), which sends through BB's composer API. |
| `app.css` | Styles, built from BB's theme variables. |
| `server.ts` | Empty backend, required by BB. |

### Depends on BB's page layout

BB has no plugin slot inside ordinary replies, so the content script reads
the chat page directly. It relies on three things observed on bb 0.46:

- each timeline row has `data-timeline-row-id`, and agent messages contain
  `:assistant:` in it, after the thread id and a `:`;
- a reply's Markdown is inside `[data-markdown-preview]`;
- the chat scroll area is `[data-page-scroll-viewport]`.

If a BB update changes these, the controls stop appearing. Nothing else
breaks, and saved marks are kept. Sending uses BB's official composer API and
is not affected.

## Development

```
npm install
npm test            # unit tests (node --test, happy-dom)
npm run typecheck
bb plugin build
bb plugin install . # once; afterwards: bb plugin reload line-review
```
