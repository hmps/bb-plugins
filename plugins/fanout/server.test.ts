import { describe, expect, it } from "vitest";

import {
  buildSnapshot,
  countRunningByHost,
  isRunning,
  DEFAULT_CAPACITY,
  enabledCapacities,
  mergeMachineConfig,
  parseMachineConfig,
  parseThresholdPercent,
  renderMachines,
  pickTarget,
  renderAdvice,
  renderStatus,
  type HostRow,
  type Snapshot,
  type ThreadRow,
} from "./server";

const TITAN = "host_titan";
const MSI = "host_msi";
const LAPTOP = "host_laptop";
const PROJECT = "proj_vaam";

function thread(over: Partial<ThreadRow> & { id: string }): ThreadRow {
  return {
    projectId: PROJECT,
    status: "idle",
    environmentHostId: TITAN,
    archivedAt: null,
    deletedAt: null,
    ...over,
  };
}

const HOSTS: HostRow[] = [
  { id: TITAN, name: "Ethereal-Titan", status: "connected" },
  { id: MSI, name: "MSI", status: "connected" },
  { id: LAPTOP, name: "Silicon Knight", status: "connected" },
];

/** Capacity is keyed by host id, and only enabled machines appear. */
const CAPACITY = { [TITAN]: 8, [MSI]: 12 };

function snapshotOf(threads: ThreadRow[], hosts: HostRow[] = HOSTS): Snapshot {
  return buildSnapshot({
    threads,
    hosts,
    projectHosts: new Map([[PROJECT, new Set([TITAN, MSI, LAPTOP])]]),
    capacity: CAPACITY,
    now: Date.now(),
  });
}

/** Titan busy enough to trip an 80% threshold: 7 of 8. */
function busyTitan(): ThreadRow[] {
  return Array.from({ length: 7 }, (_, i) =>
    thread({ id: `t${i}`, status: "active" }),
  );
}

describe("isRunning", () => {
  it("counts active and pending", () => {
    expect(isRunning("active")).toBe(true);
    expect(isRunning("pending")).toBe(true);
  });

  it("does not count errored threads as busy", () => {
    // An errored thread is dead, not running. Counting it overstates a
    // long-lived machine by everything that ever failed on it.
    expect(isRunning("error")).toBe(false);
    expect(isRunning("idle")).toBe(false);
  });
});

describe("countRunningByHost", () => {
  it("ignores errored, idle, archived, and deleted threads", () => {
    const counts = countRunningByHost([
      thread({ id: "a", status: "active" }),
      thread({ id: "b", status: "pending" }),
      thread({ id: "c", status: "error" }),
      thread({ id: "d", status: "idle" }),
      thread({ id: "e", status: "active", archivedAt: 1 }),
      thread({ id: "f", status: "active", deletedAt: 1 }),
      thread({ id: "g", status: "active", environmentHostId: MSI }),
    ]);
    expect(counts.get(TITAN)).toBe(2);
    expect(counts.get(MSI)).toBe(1);
  });

  it("skips threads with no machine", () => {
    const counts = countRunningByHost([
      thread({ id: "a", status: "active", environmentHostId: null }),
    ]);
    expect(counts.size).toBe(0);
  });
});

describe("parseMachineConfig", () => {
  it("parses a valid record", () => {
    expect(
      parseMachineConfig({
        [MSI]: { name: "MSI", capacity: 12, enabled: true },
      }),
    ).toEqual({ [MSI]: { name: "MSI", capacity: 12, enabled: true } });
  });

  it("treats a missing enabled flag as disabled", () => {
    // Enabling a machine sends real work to it, so anything short of an
    // explicit true must read as disabled.
    const parsed = parseMachineConfig({
      [MSI]: { name: "MSI", capacity: 12 },
    });
    expect(parsed[MSI]?.enabled).toBe(false);
  });

  it("drops malformed records rather than throwing", () => {
    expect(parseMachineConfig(null)).toEqual({});
    expect(parseMachineConfig("nope")).toEqual({});
    expect(parseMachineConfig([1, 2])).toEqual({});
    expect(parseMachineConfig({ [MSI]: { capacity: 0 } })).toEqual({});
    expect(parseMachineConfig({ [MSI]: { capacity: 1.5 } })).toEqual({});
    expect(parseMachineConfig({ [MSI]: { capacity: "big" } })).toEqual({});
  });
});

describe("mergeMachineConfig", () => {
  it("lists every machine bb knows about", () => {
    const merged = mergeMachineConfig({}, HOSTS);
    expect(Object.keys(merged).sort()).toEqual([TITAN, MSI, LAPTOP].sort());
  });

  it("defaults an unconfigured machine to disabled", () => {
    // A newly enrolled machine must not start receiving work on its own.
    const merged = mergeMachineConfig({}, HOSTS);
    expect(merged[MSI]).toEqual({
      name: "MSI",
      capacity: DEFAULT_CAPACITY,
      enabled: false,
    });
  });

  it("keeps stored settings and refreshes the display name", () => {
    const merged = mergeMachineConfig(
      { [MSI]: { name: "Old name", capacity: 12, enabled: true } },
      HOSTS,
    );
    expect(merged[MSI]).toEqual({ name: "MSI", capacity: 12, enabled: true });
  });
});

describe("enabledCapacities", () => {
  it("includes only enabled machines", () => {
    expect(
      enabledCapacities({
        [TITAN]: { name: "Ethereal-Titan", capacity: 8, enabled: true },
        [LAPTOP]: { name: "Silicon Knight", capacity: 10, enabled: false },
      }),
    ).toEqual({ [TITAN]: 8 });
  });
});

describe("renderMachines", () => {
  it("shows a disabled machine as a decision, not an omission", () => {
    const text = renderMachines([
      { hostId: TITAN, name: "Ethereal-Titan", connected: true, running: 4, capacity: 8, enabled: true },
      { hostId: LAPTOP, name: "Silicon Knight", connected: true, running: 1, capacity: 10, enabled: false },
    ]);
    expect(text).toContain("Ethereal-Titan  enabled  4/8");
    expect(text).toContain("Silicon Knight  disabled");
  });

  it("warns when nothing is enabled", () => {
    const text = renderMachines([
      { hostId: MSI, name: "MSI", connected: true, running: 0, capacity: 12, enabled: false },
    ]);
    expect(text).toContain("No machine is enabled");
  });

  it("flags a disconnected machine", () => {
    const text = renderMachines([
      { hostId: MSI, name: "MSI", connected: false, running: 0, capacity: 12, enabled: true },
    ]);
    expect(text).toContain("(disconnected)");
  });
});

describe("parseThresholdPercent", () => {
  it("accepts an in-range value", () => {
    expect(parseThresholdPercent("70")).toBe(70);
    expect(parseThresholdPercent("100")).toBe(100);
  });

  it("falls back to the default rather than throwing", () => {
    // A threshold of 0 would advise a move away from an idle machine, and a
    // missing setting must not take the plugin down.
    expect(parseThresholdPercent("0")).toBe(80);
    expect(parseThresholdPercent("-5")).toBe(80);
    expect(parseThresholdPercent("101")).toBe(80);
    expect(parseThresholdPercent("many")).toBe(80);
    expect(parseThresholdPercent(undefined)).toBe(80);
  });
});

describe("buildSnapshot", () => {
  it("leaves capacity and saturation null for disabled machines", () => {
    const snapshot = snapshotOf([]);
    const laptop = snapshot.machines.find((m) => m.hostId === LAPTOP);
    expect(laptop?.capacity).toBeNull();
    expect(laptop?.saturation).toBeNull();
  });

  it("computes saturation against configured capacity", () => {
    const snapshot = snapshotOf(busyTitan());
    const titan = snapshot.machines.find((m) => m.hostId === TITAN);
    expect(titan?.running).toBe(7);
    expect(titan?.saturation).toBeCloseTo(7 / 8);
  });
});

describe("pickTarget", () => {
  const base = { projectId: PROJECT, thresholdPercent: 80 };

  it("advises MSI when Titan is over threshold", () => {
    const advice = pickTarget({
      ...base,
      snapshot: snapshotOf(busyTitan()),
      currentHostId: TITAN,
    });
    expect(advice?.target.name).toBe("MSI");
  });

  it("stays quiet below the threshold", () => {
    const threads = Array.from({ length: 6 }, (_, i) =>
      thread({ id: `t${i}`, status: "active" }),
    );
    // 6/8 = 75%, under 80%.
    expect(
      pickTarget({ ...base, snapshot: snapshotOf(threads), currentHostId: TITAN }),
    ).toBeNull();
  });

  it("never advises a disabled machine", () => {
    // Silicon Knight is the user's laptop. It must never receive work, even
    // though it is connected and holds a source for the project.
    const advice = pickTarget({
      ...base,
      snapshot: snapshotOf(busyTitan(), [
        { id: TITAN, name: "Ethereal-Titan", status: "connected" },
        { id: LAPTOP, name: "Silicon Knight", status: "connected" },
      ]),
      currentHostId: TITAN,
    });
    expect(advice).toBeNull();
  });

  it("stays quiet for a thread running on a disabled machine", () => {
    expect(
      pickTarget({
        ...base,
        snapshot: snapshotOf(busyTitan()),
        currentHostId: LAPTOP,
      }),
    ).toBeNull();
  });

  it("never advises a disconnected machine", () => {
    const advice = pickTarget({
      ...base,
      snapshot: snapshotOf(busyTitan(), [
        { id: TITAN, name: "Ethereal-Titan", status: "connected" },
        { id: MSI, name: "MSI", status: "disconnected" },
      ]),
      currentHostId: TITAN,
    });
    expect(advice).toBeNull();
  });

  it("never advises a machine with no source for the project", () => {
    const snapshot = buildSnapshot({
      threads: busyTitan(),
      hosts: HOSTS,
      // bb-plugins-style project: Titan only.
      projectHosts: new Map([[PROJECT, new Set([TITAN])]]),
      capacity: CAPACITY,
      now: Date.now(),
    });
    expect(
      pickTarget({ ...base, snapshot, currentHostId: TITAN }),
    ).toBeNull();
  });

  it("stays quiet when the target is barely better", () => {
    const threads = [
      ...busyTitan(),
      // MSI at 9/12 = 75%: under threshold, but not enough relief.
      ...Array.from({ length: 9 }, (_, i) =>
        thread({ id: `m${i}`, status: "active", environmentHostId: MSI }),
      ),
    ];
    expect(
      pickTarget({ ...base, snapshot: snapshotOf(threads), currentHostId: TITAN }),
    ).toBeNull();
  });

  it("stays quiet for a thread the sampler has not seen", () => {
    expect(
      pickTarget({ ...base, snapshot: snapshotOf(busyTitan()), currentHostId: null }),
    ).toBeNull();
  });

  it("stays quiet for an unknown project", () => {
    expect(
      pickTarget({
        ...base,
        snapshot: snapshotOf(busyTitan()),
        currentHostId: TITAN,
        projectId: "proj_unknown",
      }),
    ).toBeNull();
  });
});

describe("renderAdvice", () => {
  it("names the target and gives a runnable command", () => {
    const advice = pickTarget({
      snapshot: snapshotOf(busyTitan()),
      currentHostId: TITAN,
      projectId: PROJECT,
      thresholdPercent: 80,
    });
    const text = renderAdvice(advice!);
    expect(text).toContain("Ethereal-Titan (7/8 running, 88%)");
    expect(text).toContain("MSI (0/12 running, 0%)");
    expect(text).toContain("bb thread spawn --machine MSI --parent-self");
  });
});

describe("renderStatus", () => {
  it("flags why a machine is not a candidate", () => {
    const snapshot = buildSnapshot({
      threads: [
        ...busyTitan(),
        thread({ id: "l0", status: "active", environmentHostId: LAPTOP }),
      ],
      hosts: HOSTS,
      projectHosts: new Map([[PROJECT, new Set([TITAN, MSI])]]),
      capacity: CAPACITY,
      now: Date.now(),
    });
    const text = renderStatus(snapshot, PROJECT);
    expect(text).toContain("no source for this project");
    // The "not a fan-out target" reason belongs to the machine line itself and
    // must not also be repeated in the bracketed notes.
    expect(text).toContain("Silicon Knight (1 running, disabled)");
    expect(text).not.toContain("[disabled]");
  });

  it("reports honestly before the first sample", () => {
    expect(renderStatus({ ...snapshotOf([]), machines: [] }, null)).toBe(
      "No machines sampled yet.",
    );
  });
});
