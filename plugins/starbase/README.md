# Starbase — the Sentinel

Starbase is an orchestration model for bb. The Governor talks to one Commander
thread per project. The Commander dispatches Crew threads into the target
projects. Each Crew thread keeps a parent link back to the Commander.

A thread is a Commander when it runs in a project listed in
`commanderProjectIds` and it has no parent. A thread is Crew when its parent is
a Commander, whatever project the Crew thread itself runs in.

bb already pushes a Crew thread's completion message to its parent, so a
finished Mission needs no plugin. This plugin, the Sentinel, covers the two
cases the push does not, and adds two commands.

## What it does

**Relays a pending interaction.** When a Crew thread waits for an interaction,
the Sentinel sends the Commander one line:

```
SENTINEL interaction · thr_crew · approval/command · rm -rf build · resolve: bb thread interactions approve int_1 thr_crew
```

**Relays a failure.** When a Crew thread lands in `error`, the Commander gets:

```
SENTINEL failed · thr_crew · the build broke
```

The Sentinel relays once per recorded event. It writes every event to its own
SQLite database under a unique key, and a replay with the same key is ignored.
The key is reserved before the send and released when the send fails, so a
failed relay is tried again on the next identical event.

The keys are:

- an interaction — `interaction:<threadId>:<interactionId>`;
- a failure — `failed:<threadId>:<digest>`, where the digest is the SHA-1 of
  the error text and `thread.updatedAt`. `thread.failed` gives no id for the
  failure itself, so two distinct failures on one thread in the same
  millisecond with the same text collapse into one relay.

A Commander has no parent, so its own events are never relayed. `thread.idle`
is never relayed either — bb's completion push already covers it. An idle Crew
thread is still recorded, so `--json` can report the last event.

**A Sentinel line is never steered into a live turn.** The Sentinel never sends
with `auto`, because `auto` resolves the mode from the thread's state at send
time and would steer a Commander that started a turn just after the status was
read. An idle Commander gets `start`, which only ever begins a turn. A busy
Commander gets `queue-if-active`, which only ever waits.

**A send is retried only when bb proves nothing was delivered.** The one retry
fires on exactly one error: HTTP 409 with `code: "thread_not_writable"` and
`details.reason: "already_active"`, which bb raises when `start` meets a thread
that just went active. That error means the message was refused, so sending it
again with `queue-if-active` cannot double-post. Every other failure — a
timeout, a dropped response — is ambiguous about delivery, so the Sentinel does
not retry it; it releases the dedupe key instead and lets the next identical
event try again.

The Sentinel polls nothing. Every relay runs from a bb lifecycle event.

## Commands

### `bb starbase sitrep [--commander <thread-id>] [--json]`

Report every Crew thread under a Commander, one line each:

```
thr_crew · Build the Sentinel · active · pr:https://github.com/hmps/bb-plugins/pull/9 open · worktree:clean · interactions:1
```

- `pr` — `none`, the pull request URL and its state, or `unknown` when bb could
  not read it.
- `worktree` — `clean`, `dirty`, `n/a` when there is no worktree to report (no
  environment, or a non-git one), or `unknown` when git could not answer.
- `interactions` — how many interactions are pending right now.

A title is collapsed to one line, so one Crew thread is always one line.

`--json` prints the same rows, plus a `last` field naming the kind of the last
mission event the Sentinel recorded.

Without `--commander`, the command uses the thread it runs in. It refuses a
thread that is not a Commander.

Like `settle`, the SITREP lists hidden Crew threads and reads every page. It
refuses rather than report a partial list.

### `bb starbase settle <thread-id>`

Archive a Crew thread and its descendants once the work is done.

The target must be Crew, or a thread beneath Crew. `settle` refuses a Commander
— that would file away the whole Base — and refuses a thread that does not sit
under a Commander at all.

`settle` archives a whole thread tree, so it checks the whole thread tree
first. It enumerates descendants with hidden threads included and reads every
page; when the list cannot be shown to be complete, it refuses with `settle:
could not enumerate all descendants` rather than archive a thread it never saw.

It refuses, with one line and a non-zero exit code, naming the first thread
that is not safe. A thread is safe only when both of these hold:

- its worktree is clean, it has no environment, or its environment is not a git
  repository. Those last two are definite answers with no worktree to lose. A
  worktree bb could not read is refused: an unknown state is not a safe one.
- its pull request is absent, merged, or closed. An open or draft pull request
  is refused, and so is a pull request state bb could not read.

A tree of more than 500 threads is refused rather than inspected in part.

### bb has no single-thread archive

In SDK 0.4.47 `threads.archive` and `threads.archiveAll` both POST to the same
`threads/:id/archive-all` route. There is no call that archives one thread, and
no dry run that reports the tree a call would take. `settle` is built around
that fact:

- It enumerates **children and forks**. A fork carries `sourceThreadId`, not
  `parentThreadId`, so a parent-only walk would miss it — and a hidden fork is
  exactly the thread that would be archived without ever being checked.
- It archives **deepest first**, so each call takes the smallest subtree it can.
- It checks the returned `archivedThreadIds` **after every call, before the
  next one**, and stops at the first id it did not check.
- It **puts back** what it should not have taken: every unexpected id goes
  through `threads.unarchive` right away.
- It leaves alone anything bb had **already archived before settle ran**.
  Those ids appear in an archive-all response too, and unarchiving one would
  undo somebody else's archive. `settle` gathers them up front (an
  `archived: true`, `includeHidden`, paged walk of the same tree) and never
  treats them as compensation targets. When that walk cannot be completed,
  `settle` refuses with `settle: could not enumerate already-archived
  descendants` rather than risk unarchiving the wrong thread.

**A settle report names every affected thread id.** Nothing is summarised away
— a report that hides ids is a report nobody can act on. Short lists sit on the
heading line; longer ones get one id per line:

```
settle thr_crew: stopped — archiving thr_child also took 12 unchecked thread(s).
Unchecked:
  thr_surprise_0
  thr_surprise_1
  …
Unarchived: none
Still archived:
  thr_surprise_0
  …
Archived as intended: thr_child
Not archived: thr_crew
```

A thread that could not be put back is listed under `Still archived` and is
kept out of `Archived as intended`, so the two headings never overlap.

When an archive call fails part-way through a tree, the error names the ids
already archived, the id that failed, and the ids not archived:

```
settle thr_crew: archiving thr_child failed (host is offline).
Archived: thr_grandchild
Failed: thr_child
Not archived: thr_crew
```

Only free text — an error message — is ever truncated. Id lists are not.

`--force-archive` is not implemented in v1. The command says so and exits
non-zero, so nobody builds a habit on it.

### Known limit: the window between checking and archiving

bb has no transactional archive. A Crew thread can dirty its worktree or open a
pull request in the moment between `settle` reading its state and the archive
call that takes it, and nothing here can prevent that. Because each call
archives a subtree rather than one thread, the window is per subtree, not per
thread: the deepest-first order and the per-call check keep it as small as the
API allows, and the unarchive compensation undoes what it can, but neither
closes it. Settle Crew that has stopped working.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `commanderProjectIds` | `proj_s9vk5k4c9u` | Projects whose threads act as Commanders. One project id per line, or separated by commas. |

A Commander is a root thread in one of these projects. Its Crew are its child
threads. A Commander can therefore dispatch a Survey Mission inside its own
Base project and still get the relays.

## Develop

```bash
npm install
npm run typecheck
npm test
npm run build
```
