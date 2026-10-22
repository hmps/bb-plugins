# Starbase — the Sentinel and the board

Starbase is an orchestration model for bb. The Governor talks to one Commander
thread per project. The Commander dispatches Crew threads into the target
projects. Each Crew thread keeps a parent link back to the Commander.

A thread is a Commander when it runs in a project listed in
`commanderProjectIds` and it has no parent. A thread is Crew when its parent is
a Commander, whatever project the Crew thread itself runs in.

bb already pushes a Crew thread's completion message to its parent, so a
finished Mission needs no plugin. This plugin, the Sentinel, covers the two
cases the push does not, adds two commands, and stores the SITREP snapshots
that the Mission Queue board shows.

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

### `bb starbase publish --snapshot <json> [--snapshot <json> ...]`

Store one SITREP snapshot for the Mission Queue board. A Starbase SITREP run
calls this command; see [Publishing a snapshot](#publishing-a-snapshot).

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
    missions that name one of its Crew threads, live or archived, or the
    Commander thread itself (a root discussion). With no such mission, the
    panel asks you to pick a project.
  - Any other thread uses the posture whose `project_id` is the thread's
    project.

  The picker is always there. A pick on a Commander is saved for it.

### Where the board reads from

The board is a view of the Starbase SITREP, mission state contract v1. It
derives no mission state of its own, and it never runs the SITREP. Each SITREP
run, on any machine, publishes one snapshot with `bb starbase publish`. The
plugin stores the newest snapshot for each project, and the board shows it.

A snapshot holds one JSON row per mission: every open mission bead, the most
recent closed ones, and each Crew thread under the Commander that no mission
bead claims. Each row has `contract_version: 1` and a `mission_state` that the
core projects. The board copies the next action, the owner, and the pending
attention from that state. The contract is pinned in
[`fixtures/mission-state-v1/`](fixtures/mission-state-v1/SOURCE.md).

A row with no `contract_version` is from an older SITREP. The board shows each
such row as "Pre-v1 row" in Commander review.

### Publishing a snapshot

A snapshot is one JSON document:

```json
{"version":1,"generated_at":"2026-10-22T08:00:00Z","host":"titan","project":"all","commander":"thr_9mhukyfy2t","exit_code":0,"rows":[...]}
```

| Key | Value |
| --- | --- |
| `version` | `1`. |
| `generated_at` | When the SITREP ran, as an ISO-8601 UTC time. |
| `host` | The hostname of the machine that ran the SITREP. |
| `project` | The project slug the SITREP read, or `all`. |
| `commander` | The Commander thread id the SITREP read (`thr_...`), or `null`. |
| `exit_code` | The SITREP's exit code. |
| `rows` | The SITREP's row array. |

The rules:

- The plugin stores the newest document for each `project`. A document with an
  older `generated_at` is ignored: the command exits 0 and says so. A document
  with an equal or newer `generated_at` replaces the stored one.
- An `exit_code` other than 0 means that a source could not be read, so the
  rows are incomplete. The board shows them as partial, never as current.
- The schema is strict. A document with an unknown top-level key is refused,
  so a document never carries a credential.
- A row with a `contract_version` other than 1 refuses the whole document.
- The command exits 0 when it stores or ignores a valid document. It exits 1
  with a one-line message for invalid input: bad JSON, a wrong `version`, an
  unknown key, a bad value, or more than 8 MiB.

The CLI takes the document in argv, never in a file. Send ASCII JSON
(`jq -ac`) and split it into parts of at most 64 KiB. Pass each part as one
`--snapshot`; the plugin joins the parts in order and parses them as one
document. Linux refuses one argv string over 128 KiB (`E2BIG`); twelve 64 KiB
parts reach the plugin.

```bash
jq -ac --arg host "$(hostname)" '{version: 1, generated_at: (now | todate),
  host: $host, project: "all", commander: null, exit_code: 0, rows: .}' \
  rows.json > snapshot.json
args=()
while IFS= read -r part; do args+=(--snapshot "$part"); done \
  < <(fold -b -w 65536 snapshot.json)
bb starbase publish "${args[@]}"
```

`fold -b` cuts at bytes, and the JSON is ASCII, so no part splits a character.
A small document of one line, at most 16 KiB, can also come on stdin:

```bash
jq -c . snapshot.json | bb starbase publish --snapshot-stdin
```

### Which snapshot a board shows

- The board for a project shows the newer of that project's snapshot and the
  `all` snapshot.
- The "All projects" board shows only the `all` snapshot.
- The picker offers every posture slug, every project with a stored snapshot,
  and every project a stored mission names.

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

The board has no Queued column, because no v1 lifecycle means "queued".

The wide board shows the columns from In progress to Done. A narrow panel
stacks them: Waiting on you, Blocked, In progress, Commander review, Awaiting
deploy, Done.
Done starts collapsed there; click the header to open it.

A card shows:

- the mission id (or the thread id), build or survey, the project, and the
  title;
- the stage, with a dot for the tone;
- "Next:" and the next action, in two lines; an open card shows all of it;
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

### How far to trust the board

The board header shows the snapshot time, its age, and the host that
published it, for example "As of 22/10/2026, 10:00 (5m ago) · titan". Before
the first snapshot, it shows "No snapshot yet".

| Source | When | The board shows |
| --- | --- | --- |
| current | The shown snapshot has `exit_code` 0. | The cards. |
| partial | The shown snapshot has another `exit_code`. | The cards, with a warning that the last SITREP could not read a source and the cards are incomplete, and the exit code. A card that the failure touched can carry `source-error`. |
| unavailable | No snapshot covers the board yet. | No columns. A notice says that no SITREP has published a snapshot yet. |

The board reads the stored snapshots again every 30 seconds while it is open.
Refresh reads them again at once. It never runs a SITREP. The thread panel
gets its scope and its board in one call. A Commander's inferred project is
cached for 5 minutes; a pick clears it.

### The board only reads

- It reads the snapshots stored in its own database.
- It reads `projects/*/posture.toml` for the project list and `project_id`.
- It reads no thread through the bb SDK for the board.

It runs no process, never writes a bead, and has no board action that writes.
Only `bb starbase publish` writes a snapshot. Each column sends at most 150
cards and the full count.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `commanderProjectIds` | `proj_s9vk5k4c9u` | Projects whose threads act as Commanders. One project id per line, or separated by commas. |
| `baseRoot` | `/Users/hmps/dev/starbase` | The Starbase checkout. The board reads `projects/*/posture.toml` here. |

A Commander is a root thread in one of these projects. Its Crew are its child
threads. A Commander can therefore dispatch a Survey Mission inside its own
Base project and still get the relays.

## Develop

```bash
pnpm install --ignore-workspace
pnpm typecheck
pnpm test
pnpm build
```

npm fails on vitest's optional peers, so use pnpm. pnpm 10 can skip the
better-sqlite3 build script. Then run `npx prebuild-install` in
`node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3`.

The board tests publish synthetic snapshots through the `publish` command.
Their rows come from the pinned core full rows in
`fixtures/mission-state-v1/full-rows/`. The panel tests render the app with
the SDK app harness.

The live smoke publishes a real `all` snapshot that you name, and reads real
threads through the local bb API. It only reads, and it prints the column
counts. It fails when the snapshot rows are older than v1:

```bash
STARBASE_LIVE=1 STARBASE_LIVE_BASE=/path/to/starbase \
  STARBASE_LIVE_SNAPSHOT=/path/to/snapshot.json npx vitest run board.live
```
