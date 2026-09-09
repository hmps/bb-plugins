import { describe, expect, it } from "vitest";

import {
  buildSnapshot,
  countRunningByHost,
  isRunning,
  parseCapacity,
  parseThresholdPercent,
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

const CAPACITY = { "Ethereal-Titan": 8, MSI: 12 };

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

describe("parseCapacity", () => {
  it("parses a valid map", () => {
    expect(parseCapacity('{"MSI": 12}')).toEqual({ MSI: 12 });
  });

  it("rejects bad shapes rather than throwing", () => {
    expect(parseCapacity("not json")).toEqual({});
    expect(parseCapacity("[1,2]")).toEqual({});
    expect(parseCapacity('{"MSI": 0}')).toEqual({});
    expect(parseCapacity('{"MSI": -1}')).toEqual({});
    expect(parseCapacity('{"MSI": 1.5}')).toEqual({});
    expect(parseCapacity('{"MSI": "big"}')).toEqual({});
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
  it("leaves capacity and saturation null for unlisted machines", () => {
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

  it("never advises a machine that is absent from the capacity map", () => {
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

  it("stays quiet for a thread running on an unlisted machine", () => {
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
    expect(text).toContain("Silicon Knight (1 running, not a fan-out target)");
    expect(text).not.toContain("[not a fan-out target]");
  });

  it("reports honestly before the first sample", () => {
    expect(renderStatus({ ...snapshotOf([]), machines: [] }, null)).toBe(
      "No machines sampled yet.",
    );
  });
});
