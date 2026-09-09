# Fanout

Tells agents which machine has room to run a child thread.

## Why

One machine ends up carrying every agent, because nothing tells an agent that
another machine is idle. `bb thread spawn --machine <name> --parent-self`
already runs a child elsewhere and keeps the parent link — the capability
exists. Only the signal was missing. This plugin supplies it.

## What it does

A background service samples every 15 seconds and counts **running** threads
per machine. When a thread's own machine is at or over its offload threshold,
and a better machine is available, the plugin appends a short block to that
thread's instructions naming the machine to spawn on.

It also registers:

- **`pick_machine`** — an agent tool that reports load and recommends a target.
- **`bb fanout status`** — the same report on the command line.

Placement is **advisory**. The plugin never spawns anything and never rewrites
a spawn target. The agent still writes the command.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `capacity` | `{"Ethereal-Titan": 8, "MSI": 12}` | JSON map of machine name to maximum concurrent running threads. |
| `thresholdPercent` | `80` | Advise offloading once a machine reaches this share of capacity. |

`capacity` doubles as the eligibility list. **A machine that is not listed is
never offered as a target**, so leaving a laptop out keeps it out of the
fan-out pool. Threads running on an unlisted machine also get no advice, since
there is no capacity to measure them against.

At the defaults, a machine with capacity 8 advises offloading at 7 concurrent
running threads (88%). To trip at 6 instead, set `thresholdPercent` to `70`.

Configure with `bb plugin config fanout set <key> <value>`, then
`bb plugin reload fanout`.

## When it stays quiet

Silence is the normal state. The plugin advises nothing unless every one of
these holds:

- the thread's machine is at or over the threshold;
- a candidate machine is **connected**;
- the candidate is listed in `capacity` and under the threshold;
- the candidate holds a **source for this project** — a machine cannot run a
  project it has no source for, so advising it would produce a failing command;
- the candidate is at least 20 percentage points less saturated, so a move from
  81% to 79% is never suggested.

A thread created since the last sample is not yet in the snapshot and gets no
advice. Use `pick_machine` or `bb fanout status` for a fresh read.

## What counts as load

A thread is running when its status is `active` or `pending`.

`error` is **not** counted. An errored thread is dead, not busy, and counting
it overstates a long-lived machine by everything that ever failed on it.
Measuring this wrongly is easy: an early count of one machine read 14 busy
threads when only 3 were actually running.

## Known gap: resident idle runtimes

The signal is bb-native by design — no OS probing. It therefore cannot see
memory pressure from **idle** threads.

An idle thread may still hold a loaded agent runtime until `bb thread stop`
releases it. A machine holding hundreds of idle threads can be thrashing while
this plugin reports it as free. Accept this for now; it is the main reason to
add an OS load signal later.

That signal is already known to work. Reading terminal scrollback directly is
unreliable — the session exits first and `bb terminal output` returns HTTP 409
— so write to a file and read it back:

```bash
bb terminal create --machine MSI --command 'uptime > /tmp/probe.txt; nproc >> /tmp/probe.txt; sleep 3'
bb file read /tmp/probe.txt --host <hostId>
```

## Requirement

A project only runs on machines that hold a source for it. Check with
`bb project show <id> --json` and look at `sources[].hostId`. Fan-out to a
machine is impossible until the project has a source there, and the plugin
correctly refuses to advise it.

## Develop

```bash
pnpm install
pnpm test
pnpm typecheck
bb plugin build
```
