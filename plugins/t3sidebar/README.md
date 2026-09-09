# t3sidebar

An inbox-style replacement for bb's sidebar thread list, and the reference
example for `app.slots.experimental_threadList`.

This is a fork of the `t3sidebar` example from the bb repository, with touch
support: on a touch screen the Snooze and Settle buttons stay visible, and a
long-press on any row opens the menu with the same actions.

Install from the `hmps` marketplace:

```sh
bb marketplace add git:https://github.com/hmps/bb-plugins.git@main
bb plugin install t3sidebar@hmps
```

Turn it on in **Settings → Appearance → Sidebar**. bb's own list stays the
default, and comes back the moment you switch away or disable this plugin.

The plugin replaces the scrolling list only. bb's New-thread button, search
field, plugin nav rows, and footer stay exactly where they are — this list
filters by the host's search and adds just one control of its own, a project
scope picker.

## The idea

The list never re-orders itself. Threads sort by creation time, newest first,
and hold that place until you park them. Status lives inside each card instead
of in its position, so the sidebar only moves when you act — no row slides
away under your cursor because an agent finished something.

One setting, off by default, bends that rule: **Needs attention first**
(Tools → t3sidebar) sorts each shelf by urgency: threads that wait for your
input, then unread results, then live work, then everything you have read.
Inside each tier the order stays newest first.

Four shelves:

- **Inbox** — three-line cards: project and one fixed-width status slot on the
  first line; title on the second; then branch (or the machine, when a thread
  has no worktree), activity counts, the pull-request number, and the agent
  glyph. Pinned threads sit above.

  One slot, one marker, one width, so the whole column lines up. The slot
  shows the status glyph while a thread has something to say, and the age
  ("now", "7m") once it does not. The glyphs are bb's own shapes: the red
  circle-x for a failure, the circle-question for a raised hand, the spinner
  for live work, and a notification dot for a thread that finished while you
  were not looking. The two that wait on you — the dot and the raised hand —
  are drawn vivid (blue with a halo, amber) so they pull the eye down a long
  list; the rest stay muted.

  The third line also counts what is queued: a small bubble-and-clock badge
  with the number of messages waiting in the thread's queue. The sidebar's
  thread view has no queue field, so the plugin's backend reads it over the
  SDK once per thread and then pushes changes as bb reports them.

  Snooze, Settle, and **Settle and archive** sit in the status slot on hover.
  The last action records the settlement, then archives the BB thread. A touch
  screen has no hover, so the controls stay on, and a long-press on any row
  opens the menu with the same actions.

- **Working** — live work that does not need you, folded to one line above
  the inbox. Open it and the threads show as full cards, the same as the inbox. A thread that starts working leaves the inbox for this shelf, and comes
  back the moment it finishes or asks you something. Pinned threads stay
  pinned. The setting **Working shelf** (Tools → t3sidebar, on by default)
  turns this off, and working threads then stay in the inbox.
- **Snoozed** — hidden until a wake time you chose. A snoozed thread comes
  back early if it starts working or asks you something.
- **Settled** — work you are done with, collapsed to one line each.

The server runs a daily sweep at 03:15. It checks settled rows older than ten
days and archives only threads that still have no new attention, pending
interaction, live status, or activity. Threads that are not returned as active
by bb remain in the plugin store. A failed archive stays in the store for a
later sweep.

Warning: archiving a thread in a managed environment can start its environment
cleanup. Keep a thread unsettled if you still need its managed worktree.

## Child threads live in the header

A flat inbox has nowhere to nest a child thread, so the list hides a child
while its parent is on screen. Two chips in the thread header carry that
relation instead:

- On a parent: a chip with one coloured disc per child. It opens the list of
  children.
- On a child: a chip that names the parent and opens it. Without it the child
  is a dead end, because it is not in the list.

The parent chip sits on the left of the children chip, so the header reads up
then down. A child that has children of its own shows both. Each disc takes
its colour from the thread id, so the same thread keeps one colour in the list
and in both chips.

An orphan — a child whose parent is deleted — stays in the list, and its
header shows no parent chip.

A hidden child must not make its parent read as idle, so the parent card rolls
its whole branch up: a branch badge counts the descendants that work, and the
empty status slot borrows their glyph — the raised hand when one asks you
something, the spinner when one only runs. The parent then follows them onto
the Working shelf, and stays unparkable while they work. The rollup reads every
thread, not the scoped list, so a child spawned into another project still
counts. The children chip in the header follows the same order: "Needs you",
then "N working", then the plain count.

## What it demonstrates

| Plugin API                                           | Used for                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `experimental_threadList`                            | the sidebar's scrolling list (bb keeps the New-thread button, search, nav rows, and footer) |
| `experimental_threadHeaderAction`                    | the two header chips: children on a parent, and the way back on a child                     |
| `experimental_useSidebarThreads`                     | live threads and projects, from the host's own cache                                        |
| `experimental_useSidebarThreadActions`               | open, open-in-split, new thread                                                             |
| `experimental_useSidebarThreadSplit`                 | dragging a card out to a split pane                                                         |
| `experimental_useSidebarThreadPullRequest`           | the `#412` badge, coloured by bb's attention state                                          |
| `@radix-ui/react-context-menu` (shimmed)             | this plugin's own right-click menu, built on the action hook                                |
| `bb.storage.database()` + `bb.rpc` + `bb.realtime`   | the settled/snoozed store                                                                   |
| `bb.sdk.threads.queuedMessages` + `bb.sdk.subscribe` | queued-message counts, cached per thread and pushed on `queue-changed`                      |

The plugin API ships **no components**. Status glyphs and the right-click menu
are both this plugin's own: `indicator` arrives as data, and every menu item is
one call on `experimental_useSidebarThreadActions`. Choosing them is the point
of a replaced sidebar. Deletion still routes through `requestDelete`, so BB
shows its confirmation dialog rather than a plugin deleting a subtree silently.
The small icon and select components also live in this example. The example
does not import BB's private shared UI package.

## Where the lifecycle lives

Settled and snoozed state is in **this plugin's** SQLite database, never on
bb's thread. Putting it on the thread would mean a schema change, a wire
change, and a `HOST_DAEMON_PROTOCOL_VERSION` bump for a concept only this
sidebar understands. Uninstalling the plugin takes its state with it.

One rule matters more than the rest: **a thread that is working can never be
parked.** bb has more kinds of live work than a session status — workflows,
background agents, background commands, plan mode, goals — and every one of
them blocks parking and wakes a parked thread. Hiding running work is the one
failure this feature cannot afford. See `canPark` in `src/lifecycle.ts`.
