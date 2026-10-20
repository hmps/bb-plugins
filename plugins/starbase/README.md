# Starbase — the Sentinel and the board

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

## The Mission Queue board

The plugin also shows the Mission Queue as a read-only board. Open it in two
places:

- **Starbase** in the sidebar. It shows all projects. Pick one project in the
  picker; the pick is part of the URL.
- **Starbase board** in a thread's side panel. It shows the thread's Command
  project:
  - A Crew thread uses its Commander's project.
  - A Commander uses the project you last picked on it. The plugin saves that
    pick in its own database.
  - A Commander with no saved pick uses the most common `project:` label among
    the beads that name one of its Crew threads, live or archived. With no
    Crew either, the panel asks you to pick a project.
  - Any other thread uses the posture whose `project_id` is the thread's
    project.

  The picker is always there. A pick on a Commander is saved for it.

A card is one mission: a bead labelled `project:<slug>` and `mission:build` or
`mission:survey`. Every other bead is not shown and not counted.

The board reads the newest Commander record on a mission. That is the last line
in the notes that starts with `decision=`, or the last reconciliation line with
`disposition=<word>`. The first rule that matches puts a card in a column:

| Column | Rule |
| --- | --- |
| Done | The bead closed in the last 7 days. Older closed beads are not shown. |
| Waiting on you | The Crew thread has a pending interaction; or the newest record is a `decision=` that is not `none`; or it is `disposition=governor_decision`. |
| Blocked | The Crew thread failed; or the newest record is `disposition=external_blocker`. |
| In progress | The Crew thread is active or starting; or the bead is `in_progress`; or the newest record is `disposition=progressing`. |
| Commander review | The bead names a Crew thread and no rule above matched; or the newest record is a `disposition=` that starts with `complete`, or `preserve_state`. |
| Awaiting deploy | Only a mission state v1 row goes here: lifecycle `source-ready` or `ready-for-deploy`. The notes rules above never use it. |
| Queued | The bead is open and names no Crew thread. |

A live pending interaction and a failed Crew thread beat the newest record. A
thread that bb no longer has, could not read, or archived does not count as
live. Its card keeps a small flag.

The wide board shows the columns from Queued to Done. A narrow panel stacks
them: Waiting on you, Blocked, In progress, Commander review, Awaiting deploy,
Queued, Done.
Queued and Done start collapsed there; click the header to open them.

A card shows the mission id, build or survey, the title, the project (in the
all-projects view), the age, one status line, and the PR state when bb knows
it. The status line is the pending decision, "Blocked on <owner>", or the
`state=` of the newest disposition, else the latest `outcome=`. The icon on a
card opens the Crew thread. Click a card to see the latest `outcome=`, hand
note, and the newest Commander record.

The notes are read as the Starbase scripts write them. `thread=` and `env=` are
the latest token anywhere in the notes. `outcome=` is the latest line that
starts with the key. The note is the latest line that is not a `key=value` line
or a reconciliation line.

The board answers from a warm snapshot, so the panel opens fast:

- The first board call after the plugin loads reads the snapshot and waits for
  it. Every later call answers at once from the snapshot.
- When the snapshot is older than 30 seconds, or a Crew thread on the board
  changed (active, idle, failed, archived, deleted, or a pending interaction),
  the next call answers from the old snapshot and reads a new one behind it.
  The board then shows "Updating…" and asks again shortly.
- While somebody used the board in the last 10 minutes, the snapshot is read
  again every 30 seconds. Only one read runs at a time.
- Refresh reads a new snapshot and waits for it.
- The thread panel gets its scope and its board in one call. A Commander's
  inferred project is cached for 5 minutes; a pick clears it.

The board only reads:

- It runs `bd --readonly list --all --json --limit 0` in the Base root.
- It reads the Dolt password from `~/.config/beads/credentials`, section
  `[100.85.132.50:3307]`, for each `bd` run. The password goes only into the
  `bd` process environment as `BEADS_DOLT_PASSWORD`. It is never stored,
  logged, or sent to the panel.
- It reads the Crew thread of each open mission through the bb SDK, 8 at a
  time: the thread, its interactions, and its PR. It does not read the threads
  of closed missions, so a Done card shows no PR.
- It reads `projects/*/posture.toml` for the project list and `project_id`.

It never writes a bead, never runs a `bd` write command, and never runs a
Starbase script. Each column sends at most 150 cards and the full count.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `commanderProjectIds` | `proj_s9vk5k4c9u` | Projects whose threads act as Commanders. One project id per line, or separated by commas. |
| `baseRoot` | `/Users/hmps/dev/starbase` | The Starbase checkout. The board runs `bd` here and reads `projects/*/posture.toml`. |
| `bdPath` | `bd` | The `bd` executable. A bare name is looked up on PATH, then in the usual install locations (mise shims, `~/.local/bin`, `~/go/bin`, Homebrew). |

A Commander is a root thread in one of these projects. Its Crew are its child
threads. A Commander can therefore dispatch a Survey Mission inside its own
Base project and still get the relays.

## Develop

```bash
npm install --legacy-peer-deps
npm run typecheck
npm test
npm run build
```

A plain `npm install` fails in npm 10 on vitest's optional peers, so use
`--legacy-peer-deps`.

The live smoke runs the real `bd` and reads real threads through the `bb` CLI.
It only reads, and it prints the column counts:

```bash
STARBASE_LIVE=1 npx vitest run board.live
```
