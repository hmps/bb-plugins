# Child Thread Split

Adds an "Open in split" icon button next to child threads in two places:

- The active child thread rows above the composer.
- Generated messages about a child thread:
  - a child report (a BB system message such as "<child> finished"), whose
    collapsed preview starts with the child pill;
  - an agent message whose header says "Message from <child>".

The button opens the child thread in a split pane next to the pane that shows
it. It uses bb's own split action (`experimental_useSidebarThreadActions().open(id, { split: true })`).
The plugin has no split logic of its own.

## Behavior

- The button is a native `<button>` with an `aria-label` ("Open <title> in split").
  Enter and Space activate it.
- The button sits next to the row link or at the end of the message header, never
  inside a link or a toggle. A click does not follow a link or toggle the message.
- For a child report, the button is in the header, not in the preview. The preview
  is a `role="button"` toggle, and a button inside it is a nested control.
- When a child report expands, bb removes the preview. The button goes away with it.
- The button shows on row or message hover and on keyboard focus. Touch screens
  always show it and get a larger hit area.
- bb reports when it cannot split (narrow window, splits off, unknown thread). Then
  the plugin shows no button.
- At bb's pane cap (8 panes), bb replaces the focused pane, which can be the parent.
  The plugin hides the button there, unless the child is already open.
- In a collapsed composer banner, the button leaves the tab order.
- Messages get a button only for a direct child of the thread in that pane.
  Forks, hidden threads (such as side chats), and other threads get no button.
- Colors come from host theme variables, so light and dark mode follow bb.

## Install

```sh
pnpm install
bb plugin build
bb plugin install /Users/hmps/dev/bb-plugins/plugins/child-thread-split --yes
```

## Development

```sh
pnpm test        # vitest, jsdom, SDK testing harness
pnpm typecheck
bb plugin build
```

## DOM contracts

bb has no slot for these places, so the plugin finds them in the DOM. One app
overlay keeps a `MutationObserver` on `document.body`. It inserts one
`span[data-child-thread-split]` per target and portals the button into it.
Unmount disconnects the observer and removes every span.

These selectors follow the bb 0.44 markup. A change in bb can break them.

| Place | Contract |
| --- | --- |
| Composer rows | `[id="thread-prompt-banner-child-threads-body"] ul > li > a[href]`. The thread id is the last `/threads/<id>` segment of `href`. The title comes from `.bb-thread-title`. |
| Collapsed banner | `aria-hidden="true"` on an ancestor. |
| Message rows | `[class~="group/timeline-row"]`, the first child of the message panel. Its first child is the header. The button goes at the end of the row. |
| Thread pill | `[data-prompt-mention="true"][data-prompt-mention-serialized-text^="@thread:"]`. The thread id and label come from `data-prompt-mention-resource`. |
| Agent message pill | A pill that is a direct child of the header's `span[title]`, after the lead-in `span` (GeneratedAgentSourceTitle). |
| Child report pill | The collapsed preview line `div.flex.min-w-0.items-baseline.truncate > div.min-w-0.truncate > [data-markdown-preview] > p`, with the pill as the first content of the `p`. The line is in the panel, after the row, at most 6 levels down. The expanded body (`div.pl-2…` without `flex`) and pills after other text do not match. |
| Panes | `[data-split-pane-id]` ancestors, matched against `useSidebarSplitLayout()`. |

## Fragility

- A bb class or attribute rename stops the button from showing. It does not break bb.
- The pane cap (`MAX_PANES = 8`) is a copy of a bb constant. The SDK does not expose it.
- A portalled click does not reach the pane's own focus handler. So, in a
  multi-pane layout, the plugin first calls `open(paneThread, { split: true })` to
  focus the pane that shows the button. This call also navigates to that thread (replace).
- The side chat exclusion uses `isHidden` on the sidebar thread. This is an assumption.
- Plugin Tailwind utilities do not reach portalled nodes, so the styles are plain CSS.
