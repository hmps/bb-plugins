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
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** How often the background service refreshes the snapshot. */
const SAMPLE_INTERVAL_MS = 15_000;

/** Page size for `threads.list`; the account can hold thousands of threads. */
const THREAD_PAGE_SIZE = 500;

/** Safety valve so a runaway account cannot make one sample loop forever. */
const THREAD_PAGE_LIMIT = 40;

/**
 * A target must beat the current machine by this much saturation before we
 * advise a move. Without it, a machine at 81% would advise a move to one at
 * 79%, which is noise rather than relief.
 */
const MIN_IMPROVEMENT = 0.2;

/**
 * Thread statuses that consume machine resources right now.
 *
 * `error` is deliberately excluded. An errored thread is dead, not busy, and
 * counting it overstates a long-lived machine by everything that ever failed
 * on it. `idle` is excluded too — see the README note on resident runtimes.
 */
const RUNNING_STATUSES = new Set(["active", "pending"]);

export type ThreadRow = {
  id: string;
  projectId: string;
  status: string;
  environmentHostId: string | null;
  archivedAt: number | null;
  deletedAt: number | null;
};

export type HostRow = {
  id: string;
  name: string;
  status: "connected" | "disconnected";
};

/** One machine's standing in the snapshot. */
export type MachineStat = {
  hostId: string;
  name: string;
  connected: boolean;
  /** Threads currently `active` or `pending` on this machine. */
  running: number;
  /** Configured ceiling, or null when the machine is not a fan-out target. */
  capacity: number | null;
  /** `running / capacity`, or null when there is no capacity to divide by. */
  saturation: number | null;
};

export type Snapshot = {
  machines: MachineStat[];
  /** threadId -> hostId, so a synchronous caller can locate a thread. */
  threadHost: Map<string, string>;
  /** projectId -> machines that hold a source for it. */
  projectHosts: Map<string, Set<string>>;
  sampledAt: number;
};

export const EMPTY_SNAPSHOT: Snapshot = {
  machines: [],
  threadHost: new Map(),
  projectHosts: new Map(),
  sampledAt: 0,
};

/**
 * Parse the capacity setting.
 *
 * The setting doubles as the eligibility list: a machine that is not named
 * here is never advised as a target. That is how the user's laptop stays out
 * of the fan-out pool without a second list to keep in sync.
 *
 * The schema rejects bad input at the settings boundary, but the parse still
 * falls back to a safe value rather than throwing: a value stored before the
 * schema existed must not take the plugin down.
 */
function parseCapacityOrNull(raw: string): Record<string, number> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      return null;
    }
    out[name] = value;
  }
  return out;
}

/** Parse the capacity setting, falling back to an empty map on bad input. */
export function parseCapacity(raw: string): Record<string, number> {
  return parseCapacityOrNull(raw) ?? {};
}

/** Default used when the threshold setting is missing or unparseable. */
export const DEFAULT_THRESHOLD_PERCENT = 80;

/**
 * Parse the threshold setting. An out-of-range or non-numeric value falls back
 * to the default: a threshold of 0 would advise a move from an idle machine,
 * and a negative one would never fire.
 */
export function parseThresholdPercent(raw: number | string | undefined): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1 || value > 100) {
    return DEFAULT_THRESHOLD_PERCENT;
  }
  return value;
}

export function isRunning(status: string): boolean {
  return RUNNING_STATUSES.has(status);
}

/** Count running threads per machine, ignoring archived and deleted rows. */
export function countRunningByHost(threads: ThreadRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    if (thread.archivedAt || thread.deletedAt) continue;
    if (!isRunning(thread.status)) continue;
    const hostId = thread.environmentHostId;
    if (!hostId) continue;
    counts.set(hostId, (counts.get(hostId) ?? 0) + 1);
  }
  return counts;
}

export function buildSnapshot(args: {
  threads: ThreadRow[];
  hosts: HostRow[];
  projectHosts: Map<string, Set<string>>;
  capacity: Record<string, number>;
  now: number;
}): Snapshot {
  const running = countRunningByHost(args.threads);

  const threadHost = new Map<string, string>();
  for (const thread of args.threads) {
    if (thread.environmentHostId) {
      threadHost.set(thread.id, thread.environmentHostId);
    }
  }

  const machines = args.hosts.map<MachineStat>((host) => {
    const capacity = args.capacity[host.name] ?? null;
    const count = running.get(host.id) ?? 0;
    return {
      hostId: host.id,
      name: host.name,
      connected: host.status === "connected",
      running: count,
      capacity,
      saturation: capacity === null ? null : count / capacity,
    };
  });

  return {
    machines,
    threadHost,
    projectHosts: args.projectHosts,
    sampledAt: args.now,
  };
}

export type Advice = {
  current: MachineStat;
  target: MachineStat;
};

/**
 * Decide whether to advise a move, and where to.
 *
 * Returns null — advise nothing — whenever the answer is not both true and
 * actionable. Staying quiet is the common case by design: an instruction that
 * fires on every thread stops being read.
 */
export function pickTarget(args: {
  snapshot: Snapshot;
  currentHostId: string | null;
  projectId: string;
  thresholdPercent: number;
}): Advice | null {
  const { snapshot, currentHostId, projectId } = args;
  if (!currentHostId) return null;

  const threshold = args.thresholdPercent / 100;
  const current = snapshot.machines.find((m) => m.hostId === currentHostId);

  // An unlisted machine has no capacity, so we cannot say it is overloaded.
  // This is also what keeps threads on the user's laptop out of the scheme.
  if (!current || current.saturation === null) return null;
  if (current.saturation < threshold) return null;

  // A machine can only run a project it holds a source for. Advising one that
  // cannot check the code out would produce a command that fails.
  const eligibleHosts = snapshot.projectHosts.get(projectId);
  if (!eligibleHosts) return null;

  const candidates = snapshot.machines.filter(
    (m) =>
      m.hostId !== current.hostId &&
      m.connected &&
      m.saturation !== null &&
      m.saturation < threshold &&
      eligibleHosts.has(m.hostId),
  );
  if (candidates.length === 0) return null;

  const best = candidates.reduce((a, b) =>
    (a.saturation ?? 1) <= (b.saturation ?? 1) ? a : b,
  );
  if ((best.saturation ?? 1) > current.saturation - MIN_IMPROVEMENT) {
    return null;
  }

  return { current, target: best };
}

function formatMachine(machine: MachineStat): string {
  if (machine.capacity === null || machine.saturation === null) {
    return `${machine.name} (${machine.running} running, not a fan-out target)`;
  }
  const percent = Math.round(machine.saturation * 100);
  return `${machine.name} (${machine.running}/${machine.capacity} running, ${percent}%)`;
}

/** The instruction block injected into an overloaded machine's threads. */
export function renderAdvice(advice: Advice): string {
  return [
    `Machine load: ${formatMachine(advice.current)} is at or over its offload threshold.`,
    `${formatMachine(advice.target)} has room and can run this project.`,
    "",
    `Spawn child threads on ${advice.target.name} instead of this machine:`,
    `  bb thread spawn --machine ${advice.target.name} --parent-self --permission-mode full --prompt "..."`,
    "",
    "The child stays linked to this thread, so bb thread wait, tell, and output all still work.",
    "This is advice, not a rule. Keep work here when it needs this machine's local state.",
  ].join("\n");
}

/** Shared rendering for `pick_machine` and `bb fanout status`. */
export function renderStatus(
  snapshot: Snapshot,
  projectId: string | null,
): string {
  if (snapshot.machines.length === 0) {
    return "No machines sampled yet.";
  }
  const eligibleHosts = projectId
    ? snapshot.projectHosts.get(projectId)
    : undefined;

  const lines = snapshot.machines
    .slice()
    .sort((a, b) => (a.saturation ?? 2) - (b.saturation ?? 2))
    .map((machine) => {
      // `formatMachine` already says when a machine is not a target, so only
      // the reasons it does not repeat belong here.
      const notes: string[] = [];
      if (!machine.connected) notes.push("disconnected");
      if (eligibleHosts && !eligibleHosts.has(machine.hostId)) {
        notes.push("no source for this project");
      }
      const suffix = notes.length > 0 ? `  [${notes.join("; ")}]` : "";
      return `  ${formatMachine(machine)}${suffix}`;
    });

  const age = snapshot.sampledAt
    ? `${Math.round((Date.now() - snapshot.sampledAt) / 1000)}s ago`
    : "never";
  return [`Machine load (sampled ${age}):`, ...lines].join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    capacity: {
      type: "string",
      label: "Machine capacity",
      description:
        "JSON map of machine name to the maximum number of concurrently running threads. Only machines listed here are offered as fan-out targets.",
      experimental_multiline: true,
      experimental_schema: z
        .string()
        .refine((raw) => parseCapacityOrNull(raw) !== null, {
          message:
            'Capacity must be a JSON object of machine name to positive integer, e.g. {"MSI": 12}',
        }),
      default: '{\n  "Ethereal-Titan": 8,\n  "MSI": 12\n}',
    },
    thresholdPercent: {
      type: "number",
      label: "Offload threshold (%)",
      description:
        "Advise offloading once a machine reaches this share of its capacity.",
      experimental_schema: z.number().int().min(1).max(100),
      default: DEFAULT_THRESHOLD_PERCENT,
    },
  });

  // The snapshot the synchronous instruction hook reads. Replaced wholesale by
  // the sampler so a reader never sees a half-updated view.
  let snapshot: Snapshot = EMPTY_SNAPSHOT;

  // `contributeInstructions` must be synchronous, but reading settings is
  // async. Mirror the threshold here and keep the mirror current.
  let thresholdPercent = parseThresholdPercent((await settings.get()).thresholdPercent);
  settings.onChange((next) => {
    thresholdPercent = parseThresholdPercent(next.thresholdPercent);
  });

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

  async function sample(signal?: AbortSignal): Promise<Snapshot> {
    const raw = await settings.get();
    thresholdPercent = parseThresholdPercent(raw.thresholdPercent);
    const capacity = parseCapacity(raw.capacity);

    const [threads, hosts] = await Promise.all([
      listAllThreads(signal),
      bb.sdk.hosts.list({ signal }),
    ]);

    // A machine can only run a project it holds a source for, so resolve the
    // source hosts of every project that currently has threads.
    const projectIds = new Set(threads.map((t) => t.projectId).filter(Boolean));
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
          // A project that cannot be read simply gets no advice.
          bb.log.warn(
            `could not read project ${projectId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }),
    );

    return buildSnapshot({
      threads,
      hosts: hosts as unknown as HostRow[],
      projectHosts,
      capacity,
      now: Date.now(),
    });
  }

  bb.background.service("sample", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          snapshot = await sample(signal);
        } catch (error) {
          // A failed sample keeps the previous snapshot. Advice made from
          // slightly stale counts beats no advice, and beats crash-looping.
          bb.log.warn(
            `sample failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
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
  // snapshot only — never the SDK. A thread created since the last sample is
  // absent from `threadHost` and correctly gets no advice.
  bb.agents.contributeInstructions(({ threadId, projectId }) => {
    const advice = pickTarget({
      snapshot,
      currentHostId: snapshot.threadHost.get(threadId) ?? null,
      projectId,
      thresholdPercent,
    });
    return advice ? renderAdvice(advice) : null;
  });

  bb.agents.registerTool({
    name: "pick_machine",
    description:
      "Report how loaded each BB machine is and which one has room to run a child thread for a project. Advisory only: it does not spawn anything.",
    instructions:
      "Before spawning several child threads, call pick_machine and pass the winning name to `bb thread spawn --machine`.",
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
      const fresh = await sample(ctx.signal).catch(() => snapshot);
      snapshot = fresh;

      const targetProject = projectId ?? ctx.projectId ?? null;
      const advice = pickTarget({
        snapshot: fresh,
        currentHostId: fresh.threadHost.get(ctx.threadId) ?? null,
        projectId: targetProject ?? "",
        thresholdPercent,
      });

      const recommendation = advice
        ? `Recommended: --machine ${advice.target.name}`
        : "Recommended: stay on the current machine. Nothing is over threshold, or no eligible machine has room and a source for this project.";

      return [
        renderStatus(fresh, targetProject),
        "",
        recommendation,
        "Placement is advisory — you still write the spawn command.",
      ].join("\n");
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
    ],
    async run(argv, ctx) {
      if (argv[0] !== "status") {
        return {
          exitCode: 1,
          stderr: "usage: bb fanout status [--project <id>]\n",
        };
      }
      const flagIndex = argv.indexOf("--project");
      const projectId =
        flagIndex >= 0 ? (argv[flagIndex + 1] ?? null) : (ctx.projectId ?? null);

      const fresh = await sample(ctx.signal).catch(() => snapshot);
      snapshot = fresh;
      return { exitCode: 0, stdout: `${renderStatus(fresh, projectId)}\n` };
    },
  });
}
