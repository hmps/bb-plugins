# Fanout

Fanout names a machine for child threads. It does not spawn threads or reserve capacity.

## Placement

- `priority` selects the eligible machine with the lowest priority number, then the lowest load share (`running / capacity`). Host ID breaks ties.
- `offload` is the default. It selects the least loaded remote machine after the origin reaches its threshold. The target must reduce load share by 20 percentage points.

A target must be enabled, connected, below the threshold, and have a source for the project. The default threshold is 80%.
A disabled machine is never a target. Threads on disabled machines still get advice.
Offload skips the origin load checks when the origin is disabled, because it has no load share.

For shared load, give Iron Phoenix and MSI priority 1. Give Ethereal-Titan a higher number to keep it as backup.
Keep Silicon Knight disabled unless the user asks to use it. Each child works in its own new environment.

Agents receive these instructions:

> Call pick_machine before you spawn each child.
> Spawn on the machine it names with --machine.
> If it names no machine, wait a short time and call again.
> Never spawn on Silicon Knight unless the user asks for it.
> Give each child its own new environment.

Priority advice expires after 30 seconds. Configuration changes, failed refreshes, missing context, or stale samples prevent a target recommendation.
Side chats receive no injected advice. Offload keeps its cached observations if a refresh fails.
Use `bb fanout status` for sample details, load counts, selection order, and exclusion reasons.
Configured order uses priority and host ID. Eligible priority order also uses load share.

## Configuration

Use Fanout settings to set the policy, enabled machines, capacities, and priorities. Save applies the edits together.
Priorities range from 1 to 1000. Lower numbers win first. New machines default to disabled, capacity 8, and priority 100.
Missing or invalid policies use `offload`. Missing machine settings mean disabled.

```bash
bb fanout machines
bb fanout policy
bb fanout policy priority
bb fanout policy offload
bb fanout priority <machine-or-host-id> <1-1000>
bb fanout enable <machine-or-host-id>
bb fanout disable <machine-or-host-id>
bb fanout status --project <project-id> --origin <host-id>
bb plugin config fanout set thresholdPercent 80
```

The priority command accepts an exact host ID or one unique exact machine name.
Invalid values, unknown machines, and ambiguous names fail without a write.
The threshold range is 1 through 100. A machine at the threshold cannot be a target.

## Development

Fanout stores policy and machines in `bb.storage.kv` under `placement`. Startup uses the legacy `machines` key as a fallback.
`placement.ts` selects targets. `placement-state.ts` manages configuration and samples. `server.ts` connects the SDK, CLI, tools, and instructions.
Load counts include active and pending threads. They exclude idle, errored, archived, and deleted threads.
These counts do not measure CPU, memory, or idle resident runtimes.

Run from `plugins/fanout`:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm run build
```
