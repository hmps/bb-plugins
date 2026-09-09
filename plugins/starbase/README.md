# Starbase — the Sentinel

Starbase is an orchestration model for bb. The Governor talks to one Commander
thread per project. The Commander dispatches Crew threads into the target
projects. Each Crew thread keeps a parent link back to the Commander.

bb already pushes a Crew thread's completion message to its parent, so a
finished Mission needs no plugin. This plugin, the Sentinel, fills the two gaps
that the push does not cover, and adds two commands.

## What it does

**Relays a raised hand.** When a Crew thread waits for an interaction, the
Sentinel sends the Commander one line:

```
SENTINEL interaction · thr_crew · approval/command · rm -rf build · resolve: bb thread interactions approve int_1 thr_crew
```

**Relays a failure.** When a Crew thread lands in `error`, the Commander gets:

```
SENTINEL failed · thr_crew · the build broke
```

Each event relays exactly once. The Sentinel writes every event to its own
SQLite database under a unique key, and a repeated event finds the key taken.

The Sentinel never relays a Commander's own events, and it never relays
`thread.idle` — bb's completion push already covers that. It still records an
idle Crew thread, so a SITREP can name the last thing that happened.

The Sentinel polls nothing. Every relay runs from a bb lifecycle event.

## Commands

### `bb starbase sitrep [--commander <thread-id>] [--json]`

Report every Crew thread under a Commander, one line each:

```
thr_crew · Build the Sentinel · active · pr:https://github.com/hmps/bb-plugins/pull/9 open · worktree:clean · interactions:1 · last:idle
```

- `pr` — `none`, or the pull request URL and its state.
- `worktree` — `clean`, `dirty`, or `n/a` when the thread has no git
  environment.
- `interactions` — how many interactions are pending right now.
- `last` — the kind of the last mission event the Sentinel recorded.

Without `--commander`, the command uses the thread it runs in. It refuses a
thread that does not run in a Commander project.

`--json` prints the same rows as JSON.

### `bb starbase settle <thread-id>`

Archive a Crew thread and its children once the work is really done.

The command refuses, with one line and a non-zero exit code, when:

- the thread's worktree has uncommitted changes, or
- the thread's pull request is still open or still a draft.

`--force-archive` is not implemented in v1. The command says so and exits
non-zero, so nobody builds a habit on it.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `commanderProjectIds` | `proj_s9vk5k4c9u` | Projects whose threads act as Commanders. One project id per line, or separated by commas. |

A thread is a Commander when its project is in this list. A thread is Crew when
its parent is a Commander.

## Develop

```bash
npm install
npm run typecheck
npm test
npm run build
```
