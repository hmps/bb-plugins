// bb-plugin-fanout — tells agents which machine has room for a child thread.
//
// The problem it solves: one machine ends up carrying every agent because
// nothing tells an agent that another machine is idle. `bb thread spawn`
// already accepts `--machine`, and a child spawned that way keeps its parent
// link, so the capability exists. Only the signal was missing.
//
// The signal here is deliberately bb-native: a periodic count of RUNNING
// threads per machine. No OS probing, no remote terminals. See README for the
// blind spot this accepts.
//
// Placement stays advisory. This plugin never spawns and never rewrites a
// spawn target; it only reports.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export * from "./placement";
import {
  DEFAULT_CAPACITY, DEFAULT_THRESHOLD_PERCENT, parseThresholdPercent,
  mergeMachineConfig, countRunningByHost, buildSnapshot,
  enabledCapacities, renderAdvice, renderStatus, selectPlacement,
  renderPriorityAdvice, parsePlacementConfig, parsePriority,
  type PlacementConfig, type PlacementPolicy, type HostRow, type ThreadRow, type MachineConfigMap,
} from "./placement";
import { PLACEMENT_KEY, PlacementState } from "./placement-state";

const SAMPLE_INTERVAL_MS = 15_000;
const THREAD_PAGE_SIZE = 500;
const THREAD_PAGE_LIMIT = 40;

/** One row of the settings machine list. */
const machineRowSchema = z.object({
  hostId: z.string(),
  name: z.string(),
  connected: z.boolean(),
  /** Threads running on this machine right now. */
  running: z.number().int().min(0),
  capacity: z.number().int().min(1),
  enabled: z.boolean(),
  priority: z.number().int().min(1).max(1000),
});

export type MachineRow = z.infer<typeof machineRowSchema>;

export const rpcContract = defineRpcContract({
  listMachines: {
    input: z.null(),
    output: z.object({ placementPolicy: z.enum(["offload", "priority"]), configRevision: z.number().int().min(0), pendingSelection: z.boolean(), machines: z.array(machineRowSchema) }),
  },
  saveMachines: {
    input: z.object({
      placementPolicy: z.enum(["offload", "priority"]).optional(),
      machines: z.array(
        z.object({
          hostId: z.string().trim().min(1),
          capacity: z.number().int().min(1).max(1000),
          enabled: z.boolean(),
          priority: z.number().int().min(1).max(1000).optional(),
        }),
      ),
    }),
    output: z.object({ placementPolicy: z.enum(["offload", "priority"]), configRevision: z.number().int().min(0), pendingSelection: z.boolean(), machines: z.array(machineRowSchema) }),
  },
});

/** Render the machine list shown by `bb fanout machines`. */
export function renderMachines(rows: MachineRow[]): string {
  if (rows.length === 0) return "bb knows about no machines.";

  const width = Math.max(...rows.map((row) => row.name.length));
  const lines = rows.map((row) => {
    const name = row.name.padEnd(width);
    const state = row.enabled ? `enabled  ${row.running}/${row.capacity}` : "disabled";
    const link = row.connected ? "" : "  (disconnected)";
    return `  ${name}  ${state}${link}`;
  });

  const enabled = rows.filter((row) => row.enabled).length;
  const footer =
    enabled === 0
      ? "\nNo machine is enabled, so no advice is ever given. Enable one with `bb fanout enable <machine>`."
      : "";
  return `Machines:\n${lines.join("\n")}${footer}`;
}

export default async function plugin(bb: BbPluginApi) {
  const lifetime = new AbortController();
  bb.onDispose(() => lifetime.abort());
  const settings = bb.settings.define({
    thresholdPercent: {
      type: "number",
      label: "Offload threshold (%)",
      description:
        "Advise offloading once a machine reaches this share of its capacity.",
      experimental_schema: z.number().int().min(1).max(100),
      default: DEFAULT_THRESHOLD_PERCENT,
    },
  });

  // Per-machine configuration lives in plugin storage rather than in a
  // declarative setting: the host renders declarative settings as a form, and
  // a machine list needs the live host list to render at all.
  const MACHINES_KEY = "machines";

  const [stored, legacy, initialSettings] = await Promise.all([
    bb.storage.kv.get(PLACEMENT_KEY), bb.storage.kv.get(MACHINES_KEY), settings.get(),
  ]);
  const state = new PlacementState(
    parsePlacementConfig(stored, legacy), parseThresholdPercent(initialSettings.thresholdPercent),
    async config => { await bb.storage.kv.set(PLACEMENT_KEY, config); },
  );
  settings.onChange(next => {
    // thresholdChanged installs its invalidation barrier before this callback returns.
    void state.thresholdChanged(next.thresholdPercent).then(changed => {
      if (changed) void sample().catch(logSampleFailure);
    });
  });
  function logSampleFailure(error: unknown) {
    if (lifetime.signal.aborted) return;
    bb.log.warn(`sample failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  async function listAllThreads(signal?: AbortSignal): Promise<ThreadRow[]> {
    const rows: ThreadRow[] = [];
    for (let page = 0; page < THREAD_PAGE_LIMIT; page += 1) {
      const batch = await bb.sdk.threads.list({
        archived: false,
        includeHidden: true,
        limit: THREAD_PAGE_SIZE,
        offset: page * THREAD_PAGE_SIZE,
        signal,
      });
      rows.push(...(batch as unknown as ThreadRow[]));
      if (batch.length < THREAD_PAGE_SIZE) break;
    }
    return rows;
  }

  async function collect(config: PlacementConfig, requestSignal?: AbortSignal, requestedProject?: string | null) {
    const signal = requestSignal ? AbortSignal.any([requestSignal, lifetime.signal]) : lifetime.signal;
    signal.throwIfAborted();
    const [threads, hosts] = await Promise.all([
      listAllThreads(signal),
      bb.sdk.hosts.list({ signal }) as Promise<unknown> as Promise<HostRow[]>,
    ]);
    const capacity = enabledCapacities(mergeMachineConfig(config.machines, hosts));

    // A machine can only run a project it holds a source for, so resolve the
    // source hosts of every project that currently has threads.
    const projectIds = new Set(threads.map((t) => t.projectId).filter(Boolean));
    if (requestedProject) projectIds.add(requestedProject);
    const projectHosts = new Map<string, Set<string>>();
    await Promise.all(
      [...projectIds].map(async (projectId) => {
        try {
          const project = await bb.sdk.projects.get({ projectId, signal });
          const hostIds = (project.sources ?? [])
            .map((source) => source.hostId)
            .filter((hostId): hostId is string => Boolean(hostId));
          projectHosts.set(projectId, new Set(hostIds));
        } catch (error) {
          if (signal.aborted) throw error;
          // A project that cannot be read simply gets no advice.
          bb.log.warn(
            `could not read project ${projectId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }),
    );

    signal.throwIfAborted();
    return { hosts, snapshot: buildSnapshot({
      threads,
      hosts,
      projectHosts,
      capacity,
      now: Date.now(),
    }) };
  }

  async function sample(signal?: AbortSignal) {
    await state.refresh((config, refreshSignal) => collect(config, refreshSignal), signal);
    return state.snapshot;
  }

  bb.background.service("sample", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await sample(signal);
        } catch (error) {
          // Offload retains cached observations; priority suppresses failed refreshes.
          logSampleFailure(error);
        }
        if (signal.aborted) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SAMPLE_INTERVAL_MS);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });

  // Synchronous and on the thread-start path, so this reads the cached
  // snapshot only — never the SDK.
  //
  // `configure` rather than `contributeInstructions`: its context names the
  // thread's host directly. The other hook only passes a thread id, which had
  // to be looked up in the snapshot — and a thread spawned since the last
  // sample was not in it yet, so exactly the new threads got no advice.
  bb.agents.configure((context) => {
    // `tools` is a selection, not an addition: omitting pick_machine here
    // would remove it from every session.
    const selection = { tools: ["pick_machine"], skills: [] };

    // A side chat is a quick question about its parent, not a place that
    // spawns child threads.
    if (context.origin.pluginId === "side-chat") return selection;

    const snapshot = state.snapshot;
    const result = selectPlacement(snapshot, {
      currentHostId: context.host.id, projectId: context.project.id, now: state.now(),
    });
    if (result.policy === "priority") return { ...selection, instructions: renderPriorityAdvice(result) };
    const current = snapshot.machines.find(m => m.hostId === context.host.id);
    return current && result.winner
      ? { ...selection, instructions: renderAdvice({ current, target: result.winner }) } : selection;
  });

  /**
   * Build the settings rows: every machine bb knows about, with its stored
   * configuration and its current running count.
   */
  async function machineRows(signal?: AbortSignal): Promise<MachineRow[]> {
    const [hosts, stored] = await Promise.all([
      bb.sdk.hosts.list({ signal }) as Promise<unknown> as Promise<HostRow[]>,
      Promise.resolve(state.config.machines),
    ]);
    const config = mergeMachineConfig(stored, hosts);
    const running = countRunningByHost(await listAllThreads(signal));

    return hosts.map((host) => ({
      hostId: host.id,
      name: host.name,
      connected: host.status === "connected",
      running: running.get(host.id) ?? 0,
      capacity: config[host.id]?.capacity ?? DEFAULT_CAPACITY,
      enabled: config[host.id]?.enabled ?? false,
      priority: parsePriority(config[host.id]?.priority),
    }));
  }

  async function controlState(signal?: AbortSignal) {
    return { placementPolicy: state.config.placementPolicy, configRevision: state.snapshot.configRevision,
      pendingSelection: state.snapshot.pending, machines: await machineRows(signal) };
  }

  function resolveMachine(rows: MachineRow[], query: string, exactName = true): MachineRow | null | "ambiguous" {
    const matches = rows.filter(row =>
      row.hostId === query || (exactName ? row.name === query : row.name.toLowerCase() === query.toLowerCase()));
    return matches.length === 1 ? matches[0]! : matches.length === 0 ? null : "ambiguous";
  }

  bb.rpc.register(rpcContract, {
    async listMachines() {
      return controlState();
    },

    async saveMachines({ placementPolicy, machines }) {
      const hosts = (await bb.sdk.hosts.list()) as unknown as HostRow[];
      const byId = new Map(hosts.map((host) => [host.id, host]));
      await state.save(current => {
        const next: MachineConfigMap = { ...current.machines };
        for (const row of machines) {
          const host = byId.get(row.hostId);
          if (!host) continue;
          next[row.hostId] = {
            ...next[row.hostId], name: host.name, capacity: row.capacity, enabled: row.enabled,
            priority: row.priority ?? next[row.hostId]?.priority,
          };
        }
        return { placementPolicy: placementPolicy ?? current.placementPolicy, machines: next };
      });
      void sample().catch(logSampleFailure);
      return controlState();
    },
  });

  bb.agents.registerTool({
    name: "pick_machine",
    description:
      "Report how loaded each BB machine is and which one has room to run a child thread for a project. Advisory only: it does not spawn anything.",
    instructions:
      "In priority mode, call pick_machine immediately before each child spawn, including a single child. Use each answer once. Defer when no winner is available. In offload mode, call before spawning several children.",
    presentation: {
      label: {
        pending: "Checking machine load",
        completed: "Checked machine load",
      },
    },
    parameters: z.object({
      projectId: z
        .string()
        .optional()
        .describe(
          "Project the child thread will run in. Defaults to the current thread's project.",
        ),
    }),
    async execute({ projectId }, ctx) {
      const targetProject = projectId ?? ctx.projectId ?? null;
      const priority = state.snapshot.placementPolicy === "priority";
      let failure: string | null = null;
      if (priority) {
        failure = await state.refreshForTool((config, signal) => collect(config, signal, targetProject), ctx.signal);
      } else {
        await state.refresh((config, signal) => collect(config, signal, targetProject), ctx.signal).catch(logSampleFailure);
      }
      const fresh = state.snapshot;
      let result = selectPlacement(fresh, {
        currentHostId: fresh.threadHost.get(ctx.threadId) ?? null,
        projectId: targetProject, now: state.now(),
      });
      if (failure) result = { ...result, winner: null, eligibleOrder: [], kind: "unavailable data", reason: failure };
      if (result.policy === "priority") return renderPriorityAdvice(result);
      const recommendation = result.winner
        ? `Recommended: --machine ${result.winner.name}`
        : "Recommended: stay on the current machine. Nothing is over threshold, or no eligible machine has room and a source for this project.";
      return [renderStatus(fresh, targetProject), "", recommendation,
        "Placement is advisory — you still write the spawn command."].join("\n");
    },
  });

  bb.cli.register({
    name: "fanout",
    summary: "Machine load and fan-out advice",
    commands: [
      {
        name: "status",
        summary: "Show running threads and spare capacity per machine",
        usage: "bb fanout status [--project <id>]",
      },
      {
        name: "machines",
        summary: "List every machine with its fan-out setting",
        usage: "bb fanout machines",
      },
      {
        name: "enable",
        summary: "Enable a machine as a fan-out target, optionally setting its capacity",
        usage: "bb fanout enable <machine> [capacity]",
      },
      {
        name: "disable",
        summary: "Stop offering a machine as a fan-out target",
        usage: "bb fanout disable <machine>",
      },
      {
        name: "policy",
        summary: "Show or set the fan-out placement policy",
        usage: "bb fanout policy [offload|priority]",
      },
      {
        name: "priority",
        summary: "Set a machine priority for priority placement",
        usage: "bb fanout priority <machine> <1-1000>",
      },
    ],
    async run(argv, ctx) {
      const [command, ...rest] = argv;

      if (command === "status") {
        const flagIndex = rest.indexOf("--project");
        const projectId =
          flagIndex >= 0 ? (rest[flagIndex + 1] ?? null) : (ctx.projectId ?? null);
        const fresh = await sample(ctx.signal).catch(() => state.snapshot);
        return { exitCode: 0, stdout: `${renderStatus(fresh, projectId)}\n` };
      }

      if (command === "machines") {
        const rows = await machineRows(ctx.signal);
        return { exitCode: 0, stdout: `${renderMachines(rows)}\n` };
      }

      if (command === "policy") {
        if (rest.length === 0) {
          return { exitCode: 0, stdout: `Placement policy: ${state.config.placementPolicy} (configuration revision ${state.snapshot.configRevision})\n` };
        }
        if (rest.length !== 1 || (rest[0] !== "offload" && rest[0] !== "priority")) {
          return { exitCode: 1, stderr: "Policy must be offload or priority.\n" };
        }
        const policy: PlacementPolicy = rest[0];
        await state.save(current => ({ ...current, placementPolicy: policy }));
        void sample(ctx.signal).catch(logSampleFailure);
        return { exitCode: 0, stdout: `Placement policy saved: ${state.config.placementPolicy} (configuration revision ${state.snapshot.configRevision}).\n` };
      }

      if (command === "priority") {
        const [query, rawPriority, ...extra] = rest;
        if (!query || rawPriority === undefined || extra.length > 0) {
          return { exitCode: 1, stderr: "usage: bb fanout priority <machine> <1-1000>\n" };
        }
        const priority = Number(rawPriority);
        if (!Number.isInteger(priority) || priority < 1 || priority > 1000) {
          return { exitCode: 1, stderr: "Priority must be a whole number between 1 and 1000.\n" };
        }
        const match = resolveMachine(await machineRows(ctx.signal), query);
        if (match === null) {
          return { exitCode: 1, stderr: `No machine matches "${query}". Run \`bb fanout machines\`.\n` };
        }
        if (match === "ambiguous") {
          return { exitCode: 1, stderr: `"${query}" matches more than one machine; use the host id.\n` };
        }
        await state.save(current => ({ ...current, machines: { ...current.machines, [match.hostId]: {
          ...current.machines[match.hostId], name: match.name, capacity: match.capacity,
          enabled: match.enabled, priority,
        } } }));
        void sample(ctx.signal).catch(logSampleFailure);
        return { exitCode: 0, stdout: `Priority saved: ${match.name} = ${priority} (configuration revision ${state.snapshot.configRevision}).\n` };
      }

      if (command === "enable" || command === "disable") {
        const query = rest[0];
        if (!query) {
          return {
            exitCode: 1,
            stderr: `usage: bb fanout ${command} <machine>\n`,
          };
        }

        const match = resolveMachine(await machineRows(ctx.signal), query, false);
        if (match === null) {
          return {
            exitCode: 1,
            stderr: `No machine matches "${query}". Run \`bb fanout machines\`.\n`,
          };
        }
        if (match === "ambiguous") {
          return {
            exitCode: 1,
            stderr: `"${query}" matches more than one machine; use the host id.\n`,
          };
        }
        const row = match;

        let capacity = row.capacity;
        if (command === "enable" && rest[1] !== undefined) {
          const parsed = Number(rest[1]);
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
            return {
              exitCode: 1,
              stderr: "Capacity must be a whole number between 1 and 1000.\n",
            };
          }
          capacity = parsed;
        }

        await state.save(current => ({
          ...current,
          machines: { ...current.machines, [row.hostId]: {
            ...current.machines[row.hostId], name: row.name, capacity, enabled: command === "enable",
          } },
        }));
        void sample(ctx.signal).catch(logSampleFailure);

        return {
          exitCode: 0,
          stdout: `${renderMachines(await machineRows(ctx.signal))}\n`,
        };
      }

      return {
        exitCode: 1,
        stderr:
          "usage: bb fanout <status|machines|enable|disable|policy|priority> [...]\n",
      };
    },
  });
}
