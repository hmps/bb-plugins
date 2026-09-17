# Fanout

Fanout gives agents advisory placement information before they create child
threads. It does not create a thread, reserve capacity, or rewrite a spawn
target.

## Placement policies

Fanout has two placement policies.

| Policy | Default | Behavior |
| --- | --- | --- |
| `offload` | Yes | Advise a remote target only when the origin reaches its threshold and the target gives at least 20 percentage points of improvement. |
| `priority` | No | Advise the first eligible machine in ascending priority order. The origin can win when it is eligible. |

An invalid or missing stored policy uses `offload`. The placement policy is
separate from a machine enabled state. A missing policy does not enable a
machine.

## Machine configuration

Open the Fanout plugin settings to set the policy, enable machines, set their
maximum running-thread capacity, and set priorities. Save applies all edits as
one configuration change.

Each priority is an integer from 1 through 1000. The default is 100. Lower
numbers run first. Equal priorities sort by host ID. Priority remains stored
when you rename a machine. A newly discovered machine has capacity 8, priority
100, and is disabled.

Machines are disabled by default. A missing machine setting also means
disabled. A disabled machine is not a target, and a thread on it gets no
placement advice. Enable a machine only when it can run fan-out work.

To make MSI the first priority candidate, enable it and set a lower priority:

```bash
bb fanout enable MSI
bb fanout priority MSI 1
bb fanout policy priority
```

Use these commands to inspect or change configuration:

```bash
bb fanout machines
bb fanout policy
bb fanout policy offload
bb fanout policy priority
bb fanout priority <machine-or-host-id> <1-1000>
bb fanout status --project <project-id> --origin <host-id>
```

The `priority` command accepts an exact host ID or one unique exact machine
name. Invalid policies, invalid priorities, unknown machines, and ambiguous
names fail without a write.

## Threshold and order

`thresholdPercent` is a declarative plugin setting. Its default is 80, and its
valid range is 1 through 100. It controls the offload origin threshold and the
strict target threshold for both policies. A machine exactly at the threshold
is not eligible.

Configure the threshold with the normal plugin setting interface. For example:

```bash
bb plugin config fanout set thresholdPercent 80
```

Status shows the configured order and eligible order. Configured order always
sorts known machines by effective priority and host ID. It can include disabled
or disconnected machines. Eligible order contains only candidates for the
current origin and project. In offload mode, the configured order label says
`priority configuration`; selection still uses the legacy least-saturated
offload ranking.

## Advice limits and refresh

Priority advice uses a versioned sample. It expires 30 seconds after the sample
starts. A policy, machine, or threshold change suppresses priority advice until
a matching replacement sample completes. A refresh failure, missing origin or
project context, an expired sample, or no eligible capacity returns no winner.

Call `pick_machine` immediately before every child spawn, including one child.
Use each answer for one spawn only. Refresh after expiry or after a configuration
change. If advice has no winner, defer the spawn and inspect status or retry.

Advice does not reserve capacity. Two callers can receive the same advice, and
capacity can change before expiry. This can cause contention, delay, or a start
failure. Check every spawn result and child progress. On capacity failure or
contention, defer more placement and request fresh advice.

## Remote-write handoff

Placement advice does not authorize remote writes. Read-only work needs no
write handoff. Before remote work, the parent gives the worker the repository
identity, full accepted base commit, target host ID, exact checkout or worktree
path, intended branch or detached state, bounded file scope, and one write
owner.

Before the first write, the worker verifies the repository, host, path, HEAD,
branch state, and tracked and untracked changes. The parent confirms that no
other writer owns the checkout. The worker stops and reports a mismatch or
unverified state. The worker does not reset, clean, stash, checkout, merge, or
repair Git state automatically. A changed handoff requires all checks again.

## Developer notes

Fanout stores the atomic configuration record in `bb.storage.kv` at the key
`placement`. The record contains `placementPolicy` and `machines`, keyed by
host ID. Startup reads the legacy `machines` key only as a fallback. The first
successful save writes the complete `placement` record. Fanout does not use a
file path for this configuration.

`placement.ts` normalizes configuration and performs pure selection.
`placement-state.ts` serializes configuration writes and sample publication.
`server.ts` connects storage, SDK sampling, RPC, CLI, tools, and instructions.
All selection callers read the same immutable snapshot. The snapshot includes
the policy, threshold, configuration revision, sample revision, and sample age.

## Development

Run these commands from `plugins/fanout`:

```bash
pnpm test
pnpm typecheck
pnpm run build
```
