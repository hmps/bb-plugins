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
 * One machine's fan-out configuration, keyed by host id.
 *
 * Keyed by id rather than name so renaming a machine in bb does not silently
 * drop its configuration. The name is stored alongside purely so the raw
 * record stays readable when inspected outside the UI.
 */
export type MachineConfig = {
  name: string;
  /** Maximum concurrently running threads before the machine is "full". */
  capacity: number;
  /**
   * Whether this machine takes part in fan-out at all.
   *
   * A disabled machine is invisible to the advice logic in both directions: it
   * is never offered as a target, and threads running on it are never told to
   * move. That is how a laptop stays out of the scheme while still appearing
   * in the settings list.
   */
  enabled: boolean;
  /** Optional on legacy callers; normalized to 100 in committed state. */
  priority?: number;
};

export type MachineConfigMap = Record<string, MachineConfig>;

/** Capacity suggested for a machine the user has not configured yet. */
export const DEFAULT_CAPACITY = 8;

/**
 * Parse the stored machine configuration.
 *
 * Persisted values are untrusted: they may predate a schema change or have
 * been edited by hand. Every record is validated field by field and anything
 * malformed is dropped rather than throwing, because a bad stored value must
 * not take the plugin down.
 */
export function parseMachineConfig(raw: unknown): MachineConfigMap {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: MachineConfigMap = {};
  for (const [hostId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    const capacity = record.capacity;
    if (
      typeof capacity !== "number" ||
      !Number.isInteger(capacity) ||
      capacity < 1
    ) {
      continue;
    }
    out[hostId] = {
      name: typeof record.name === "string" ? record.name : hostId,
      capacity,
      enabled: record.enabled === true,
      priority: parsePriority(record.priority),
    };
  }
  return out;
}

/**
 * Fill in every machine bb knows about, so the settings list shows all of
 * them and a new machine appears without any migration step.
 *
 * An unconfigured machine defaults to DISABLED. Enabling a machine means
 * sending real work to it, so that has to be a decision the user makes rather
 * than something that happens by default when a machine is enrolled.
 */
export function mergeMachineConfig(
  stored: MachineConfigMap,
  hosts: HostRow[],
): MachineConfigMap {
  const out: MachineConfigMap = {};
  for (const host of hosts) {
    const existing = stored[host.id];
    out[host.id] = existing
      ? { ...existing, name: host.name, priority: parsePriority(existing.priority) }
      : { name: host.name, capacity: DEFAULT_CAPACITY, enabled: false, priority: 100 };
  }
  return out;
}

/** The capacity lookup the snapshot uses: enabled machines only. */
export function enabledCapacities(config: MachineConfigMap): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [hostId, record] of Object.entries(config)) {
    if (record.enabled) out[hostId] = record.capacity;
  }
  return out;
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
  /** Capacity per host id; only enabled machines appear. */
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
    const capacity = args.capacity[host.id] ?? null;
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
  // Compatibility adapter for the existing pure API. Runtime callers use the
  // committed snapshot directly through selectPlacement.
  const config = Object.fromEntries(args.snapshot.machines.map(m => [m.hostId, {
    name: m.name, capacity: m.capacity ?? DEFAULT_CAPACITY, enabled: m.capacity !== null, priority: 100,
  }]));
  const result = selectPlacement({
    ...args.snapshot, snapshotVersion: "legacy", configRevision: 0, sampleRevision: 0,
    sampleConfigRevision: 0, sampleStartedAt: args.snapshot.sampledAt, sampleStartedMono: 0,
    placementPolicy: "offload", thresholdPercent: args.thresholdPercent, config, pending: false, failure: null,
  }, { currentHostId: args.currentHostId, projectId: args.projectId, now: 0 });
  const current = args.snapshot.machines.find(m => m.hostId === args.currentHostId);
  return current && result.winner ? { current, target: result.winner } : null;
}

function formatMachine(machine: MachineStat): string {
  if (machine.capacity === null || machine.saturation === null) {
    return `${machine.name} (${machine.running} running, disabled)`;
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
  snapshot: Snapshot | SelectionSnapshot,
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
      // `formatMachine` already says when a machine is disabled, so only the
      // reasons it does not repeat belong here.
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


export type PlacementPolicy = "offload" | "priority";
export const ADVICE_LIFETIME_MS = 30_000;
export const REFRESH_DEADLINE_MS = 5_000;

export function parsePlacementPolicy(raw: unknown): PlacementPolicy {
  return raw === "priority" ? "priority" : "offload";
}

export function parsePriority(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 1000
    ? raw : 100;
}

export type PlacementConfig = {
  placementPolicy: PlacementPolicy;
  machines: MachineConfigMap;
};

/** Read the atomic record, or migrate the legacy machines value in memory. */
export function parsePlacementConfig(raw: unknown, legacy?: unknown): PlacementConfig {
  const record = typeof raw === "object" && raw !== null
    ? raw as Record<string, unknown> : {};
  return {
    placementPolicy: parsePlacementPolicy(record.placementPolicy),
    machines: parseMachineConfig(record.machines ?? legacy),
  };
}

export type SelectionSnapshot = Omit<Snapshot, "machines" | "threadHost" | "projectHosts"> & {
  readonly machines: readonly Readonly<MachineStat>[];
  readonly threadHost: ReadonlyMap<string, string>;
  readonly projectHosts: ReadonlyMap<string, ReadonlySet<string>>;
  readonly snapshotVersion: string;
  readonly configRevision: number;
  readonly sampleRevision: number;
  readonly sampleConfigRevision: number | null;
  readonly sampleStartedAt: number | null;
  readonly sampleStartedMono: number | null;
  readonly placementPolicy: PlacementPolicy;
  readonly thresholdPercent: number;
  readonly config: Readonly<Record<string, Readonly<MachineConfig>>>;
  readonly pending: boolean;
  readonly failure: string | null;
};

export type PlacementContext = {
  currentHostId: string | null;
  projectId: string | null;
  sideChat?: boolean;
  /** Monotonic server-session time, supplied by the caller. */
  now: number;
};

export type PlacementResult = {
  policy: PlacementPolicy;
  thresholdPercent: number;
  snapshotVersion: string;
  configRevision: number;
  sampleRevision: number;
  originHostId: string | null;
  projectId: string | null;
  sampleAgeMs: number | null;
  observedAt: number | null;
  expiresAt: number | null;
  configuredOrder: string[];
  eligibleOrder: string[];
  exclusions: Record<string, string>;
  kind: "local" | "remote" | "no eligible capacity" | "unavailable data" | "suppressed advice";
  winner: MachineStat | null;
  reason: string;
};

/** All placement projections use only this snapshot and explicit context. */
export function selectPlacement(snapshot: SelectionSnapshot, context: PlacementContext): PlacementResult {
  const ordered = [...snapshot.machines].sort((a, b) =>
    parsePriority(snapshot.config[a.hostId]?.priority) - parsePriority(snapshot.config[b.hostId]?.priority)
    || (a.hostId < b.hostId ? -1 : a.hostId > b.hostId ? 1 : 0));
  const age = snapshot.sampleStartedMono === null ? null : Math.max(0, context.now - snapshot.sampleStartedMono);
  const result: PlacementResult = {
    policy: snapshot.placementPolicy, thresholdPercent: snapshot.thresholdPercent,
    snapshotVersion: snapshot.snapshotVersion, configRevision: snapshot.configRevision,
    sampleRevision: snapshot.sampleRevision, originHostId: context.currentHostId,
    projectId: context.projectId, sampleAgeMs: age,
    observedAt: snapshot.sampleStartedAt,
    expiresAt: snapshot.sampleStartedAt === null ? null : snapshot.sampleStartedAt + ADVICE_LIFETIME_MS,
    configuredOrder: ordered.map(m => m.hostId), eligibleOrder: [], exclusions: {},
    kind: "unavailable data", winner: null, reason: "origin/project context required",
  };
  if (context.sideChat) return { ...result, kind: "suppressed advice", reason: "side chat" };
  const current = snapshot.machines.find(m => m.hostId === context.currentHostId);
  const sources = context.projectId ? snapshot.projectHosts.get(context.projectId) : undefined;
  if (!current) return result;
  if (snapshot.config[current.hostId]?.enabled !== true) {
    return { ...result, kind: "suppressed advice", reason: "origin disabled" };
  }
  if (snapshot.placementPolicy === "priority") {
    const reason = snapshot.pending ? "configuration refresh pending"
      : snapshot.failure ?? (snapshot.sampleConfigRevision !== snapshot.configRevision ? "matching sample required"
      : age === null || age >= ADVICE_LIFETIME_MS ? "observations expired; refresh required" : null);
    if (reason) return { ...result, reason };
  }
  if (!sources) return result;
  const threshold = snapshot.thresholdPercent / 100;
  const candidates = (snapshot.placementPolicy === "priority" ? ordered : [...snapshot.machines])
    .filter(m => {
      const reason = !m.connected ? "disconnected"
        : m.saturation === null ? "disabled"
        : !sources.has(m.hostId) ? "no source for this project"
        : m.saturation >= threshold ? "at or above threshold"
        : snapshot.placementPolicy === "offload" && m.hostId === current.hostId ? "origin" : null;
      if (reason) result.exclusions[m.hostId] = reason;
      return !reason;
    });
  if (snapshot.placementPolicy === "offload") {
    candidates.sort((a, b) => a.saturation! - b.saturation!);
    if (current.saturation === null || current.saturation < threshold) {
      return { ...result, kind: "suppressed advice", reason: "origin below offload threshold" };
    }
    if (candidates[0] && candidates[0].saturation! > current.saturation - MIN_IMPROVEMENT) {
      return { ...result, kind: "suppressed advice", reason: "insufficient improvement" };
    }
  }
  result.eligibleOrder = candidates.map(m => m.hostId);
  const winner = candidates[0] ?? null;
  return { ...result, winner, kind: winner ? winner.hostId === current.hostId ? "local" : "remote" : "no eligible capacity",
    reason: winner ? snapshot.placementPolicy === "priority" ? "first eligible priority" : "least saturated eligible remote"
      : "no eligible machine has room and a project source" };
}

/** The same selection summary is used by RPC, UI, CLI, tools, and instructions. */
export function renderSelection(result: PlacementResult): string {
  return [
    `Placement policy: ${result.policy}; threshold: ${result.thresholdPercent}%; snapshot: ${result.snapshotVersion}.`,
    `Configured order${result.policy === "offload" ? " (priority configuration)" : ""}: ${result.configuredOrder.join(", ") || "none"}. Eligible order: ${result.kind === "unavailable data" ? `unavailable: ${result.reason}` : result.eligibleOrder.join(", ") || "none"}.`,
    `Observed at: ${result.observedAt ?? "never"}; expires at: ${result.expiresAt ?? "unavailable"}; age: ${result.sampleAgeMs ?? "unknown"}ms.`,
    ...Object.entries(result.exclusions).map(([host, reason]) => `Excluded ${host}: ${reason}.`),
    result.winner ? `Recommended: --machine ${result.winner.name} (${result.kind}). Reason: ${result.reason}.`
      : `${result.kind}: ${result.reason}. Defer the spawn; inspect status or retry.`,
  ].join("\n");
}

export const REMOTE_WRITE_HANDOFF = [
  "Placement advice does not authorize remote writes. Read-only work needs no write handoff.",
  "Before remote writes, the parent supplies repository identity, expected full base commit, target host ID, exact checkout/worktree path, intended branch or detached-HEAD state, bounded file scope, and one named write owner.",
  "Use the task's accepted base commit, not a branch name or an assumed remote default.",
  "Before the first write, the named worker checks repository identity, target host, exact path, HEAD against the expected base, branch state, and tracked plus untracked local changes.",
  "Report these observations to the parent. The parent must confirm that no other writer owns the checkout.",
  "Only a verified handoff permits writes. Stop before writing on a wrong base, unexpected local changes, shared write ownership, or any unverified state.",
  "Report the mismatch and request a corrected handoff. Do not reset, clean, stash, checkout, merge, or otherwise repair Git state automatically.",
  "The parent resolves the mismatch or supplies a verified separate worktree and a new handoff. Repeat all checks after any handoff change.",
].join("\n");

export function renderPriorityAdvice(result: PlacementResult): string {
  return [
    renderSelection(result),
    "Call pick_machine immediately before each child spawn, including a single child. Use each answer for one spawn only.",
    "Check expiry before spawning. Refresh after expiry or any intervening configuration change.",
    "Capacity can change before expiry and cause contention, delay, or start failure. Advice does not reserve capacity.",
    "Thirty seconds bounds observation age; it is an accepted advisory exposure, not a capacity guarantee or measured safety limit.",
    "Check each spawn result and child progress. On capacity-related failure or contention, defer further placement and request fresh advice.",
    REMOTE_WRITE_HANDOFF,
  ].join("\n");
}
