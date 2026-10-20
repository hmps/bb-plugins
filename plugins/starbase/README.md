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
  - A Commander with no saved pick uses the most common project among the
    missions that name one of its Crew threads, live or archived. With no
    Crew either, the panel asks you to pick a project.
  - Any other thread uses the posture whose `project_id` is the thread's
    project.

  The picker is always there. A pick on a Commander is saved for it.

### Where the board reads from

The board is a view of the Starbase SITREP, mission state contract v1. It
derives no mission state of its own. The server runs this command in the
Base root:

```bash
bash scripts/sitrep.sh --project all --commander <sitrepCommander> --recent-closed 50 --json
```

The SITREP prints one JSON row per mission: every open mission bead, the 50
most recent closed ones, and each Crew thread under the Commander that no
mission bead claims. Each row has `contract_version: 1` and a `mission_state`
that the core projects. The board copies the next action, the owner, and the
pending attention from that state. The contract is pinned in
[`fixtures/mission-state-v1/`](fixtures/mission-state-v1/SOURCE.md).

The Base must carry the v1 SITREP. An older SITREP prints rows with no
`contract_version`. The board shows each such row as "Pre-v1 row" in
Commander review.

### Columns

The first rule that matches puts a card in a column:

| Order | Rule | Column |
| --- | --- | --- |
| 1 | The record integrity is not `valid` (`legacy`, `invalid`, or `conflict`), or the row has no readable v1 state. | Commander review |
| 2 | The pending attention has a `decision`. | Waiting on you |
| 3 | The pending attention has a `blocker` or a `verification-failed`. | Blocked |
| 4 | The lifecycle is `active`. | In progress |
| 4 | The lifecycle is `awaiting-decision`. | Waiting on you |
| 4 | The lifecycle is `blocked`. | Blocked |
| 4 | The lifecycle is `source-ready` or `ready-for-deploy`. | Awaiting deploy |
| 4 | The lifecycle is `complete` or `cancelled`. | Done |
| 4 | The lifecycle is `unverified`. | Commander review |

Rules 2 and 3 apply also to a mission marked complete. Merged code thus waits
in Awaiting deploy, and a survey that needs a decision waits in Waiting on
you. A legacy mission that no checked update adopted is `unverified`, so it
stays in Commander review with a "Legacy record" badge. A direct root
discussion has the Commander as its owner and shows under it.

No v1 lifecycle means "queued", so the Queued column is always empty. It
stays to keep the layout.

The wide board shows the columns from Queued to Done. A narrow panel stacks
them: Waiting on you, Blocked, In progress, Commander review, Awaiting deploy,
Queued, Done.
Queued and Done start collapsed there; click the header to open them.

A card shows:

- the mission id (or the thread id), build or survey, the project, and the
  title;
- the stage, with a dot for the tone;
- "Next:" and the next action;
- "Owner:" and the owner role and thread, with "idle" when the owner thread
  is idle;
- each pending attention event, with "seen" when the Commander surfaced it;
- an integrity badge when the board cannot trust the record, the PR state,
  and the SITREP flags.

The "Open thread" button opens the thread. Click a card to see the problems,
the latest outcome and note, and the bb thread status.

Only the pending attention and the lifecycle make a card ask for the user's
eye. Report problems show as text on the card. The board sends no
notification.

### When a source fails

The board header says how far to trust the cards:

| Source | When | The board shows |
| --- | --- | --- |
| current | The SITREP exits 0 with a row array. | The cards, "Updated <time>". |
| partial | The SITREP exits 1 with a row array: a source failed during the run. | The cards, with a notice and the SITREP's error. A card that the failure touched can carry `source-error`. |
| stale | The run failed, but an earlier run gave rows. | The last good cards, "Last good read <time>", and the error. |
| unavailable | No run has given rows yet. | No columns. A notice says the missions are unknown, not empty. |

A run fails when the SITREP exits with any other code, prints no row array,
times out after 60 seconds, or prints a row with an unsupported
`contract_version`. One such row fails the whole run.

### Warm snapshot

The board answers from a warm snapshot, so the panel opens fast:

- The first board call after the plugin loads reads the snapshot and waits for
  it. Every later call answers at once from the snapshot.
- When the snapshot is older than 30 seconds, or a thread on the board
  changed (active, idle, failed, archived, deleted, or a pending interaction),
  the next call answers from the old snapshot and reads a new one behind it.
  The board then shows "Updating…" and asks again shortly.
- While somebody used the board in the last 10 minutes, the snapshot is read
  again every 30 seconds. Only one read runs at a time.
- Refresh reads a new snapshot and waits for it.
- The thread panel gets its scope and its board in one call. A Commander's
  inferred project is cached for 5 minutes; a pick clears it.

### The board only reads

- It runs the SITREP command above. The SITREP itself only reads: it runs
  `bd` read-only, reads bb threads, and reads the forge. It needs `bash`,
  `bd`, `bb`, `jq`, and `python3` on the plugin server's PATH. The directory
  of `bdPath` goes first on that PATH.
- It reads the Dolt password from `~/.config/beads/credentials`, section
  `[100.85.132.50:3307]`, for each run. The password goes only into the
  SITREP process environment as `BEADS_DOLT_PASSWORD`. It is never stored or
  sent to the panel, and the board removes it from the error text.
- It reads `projects/*/posture.toml` for the project list and `project_id`.
- It reads no thread through the bb SDK for the board.

It never writes a bead, never runs a `bd` write command, and has no board
action that writes. Each column sends at most 150 cards and the full count.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `commanderProjectIds` | `proj_s9vk5k4c9u` | Projects whose threads act as Commanders. One project id per line, or separated by commas. |
| `baseRoot` | `/Users/hmps/dev/starbase` | The Starbase checkout. The board runs `scripts/sitrep.sh` here and reads `projects/*/posture.toml`. |
| `sitrepCommander` | `thr_9mhukyfy2t` | The Commander thread the SITREP reads (`--commander`). Its Crew threads that no mission bead claims show as their own cards. Must be a thread id. |
| `bdPath` | `bd` | The `bd` executable the SITREP uses. A bare name is looked up on PATH, then in the usual install locations (mise shims, `~/.local/bin`, `~/go/bin`, Homebrew). Its directory goes first on the SITREP's PATH. |

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

The board tests run a synthetic SITREP. Its rows come from the pinned core
full rows in `fixtures/mission-state-v1/full-rows/`.

The live smoke runs the real SITREP in a Base that you name, and reads real
threads through the local bb API. It only reads, and it prints the column
counts. It fails when the Base SITREP is older than v1:

```bash
STARBASE_LIVE=1 STARBASE_LIVE_BASE=/path/to/starbase npx vitest run board.live
```
