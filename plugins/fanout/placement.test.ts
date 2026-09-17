import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSnapshot, enabledCapacities, mergeMachineConfig, parsePlacementConfig,
  renderPriorityAdvice, selectPlacement, type HostRow, type PlacementConfig,
} from "./placement";
import { PlacementState } from "./placement-state";

const hosts: HostRow[] = [
  { id: "titan", name: "Titan", status: "connected" },
  { id: "msi", name: "MSI", status: "connected" },
  { id: "laptop", name: "Laptop", status: "connected" },
];
const config: PlacementConfig = { placementPolicy: "priority", machines: {
  titan: { name: "Titan", capacity: 10, enabled: true, priority: 20 },
  msi: { name: "MSI", capacity: 10, enabled: true, priority: 1 },
  laptop: { name: "Laptop", capacity: 10, enabled: false, priority: 100 },
} };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(initial = config, persist = vi.fn(async (_: PlacementConfig) => {})) {
  let now = 1000;
  const state = new PlacementState(initial, 80, persist, { wall: () => now + 10_000, mono: () => now });
  const collect = async (settings: PlacementConfig, counts: Record<string, number> = {}, sourceHosts = hosts) => ({
    hosts: sourceHosts,
    snapshot: buildSnapshot({ hosts: sourceHosts, capacity: enabledCapacities(mergeMachineConfig(settings.machines, sourceHosts)),
      projectHosts: new Map([["project", new Set(sourceHosts.map(h => h.id))]]), now: now + 10_000,
      threads: Object.entries(counts).flatMap(([host, count]) => Array.from({ length: count }, (_, i) => ({
        id: `${host}${i}`, projectId: "project", status: "active", environmentHostId: host,
        archivedAt: null, deletedAt: null,
      }))),
    }),
  });
  return { state, collect, persist, advance: (ms: number) => { now += ms; },
    select: (origin: string | null = "titan", project: string | null = "project") =>
      selectPlacement(state.snapshot, { currentHostId: origin, projectId: project, now }),
  };
}
afterEach(() => vi.useRealTimers());

describe("E02 priority_local_remote_and_fallback", () => {
  it("selects first MSI from idle Titan and from MSI itself", async () => {
    const f = fixture(); await f.state.refresh(c => f.collect(c));
    expect(f.select()).toMatchObject({ kind: "remote", winner: { hostId: "msi" }, eligibleOrder: ["msi", "titan"] });
    expect(f.select("msi")).toMatchObject({ kind: "local", winner: { hostId: "msi" } });
  });
  it.each(["disabled", "disconnected", "source-less", "unavailable", "at threshold"])("falls back when MSI is %s", async reason => {
    const f = fixture();
    await f.state.refresh(async c => {
      if (reason === "disabled") c.machines.msi.enabled = false;
      const visible = hosts.filter(h => reason !== "unavailable" || h.id !== "msi")
        .map(h => h.id === "msi" && reason === "disconnected" ? { ...h, status: "disconnected" as const } : h);
      const data = await f.collect(c, reason === "at threshold" ? { msi: 8 } : {}, visible);
      if (reason === "source-less") data.snapshot.projectHosts.get("project")!.delete("msi");
      return data;
    });
    expect(f.select()).toMatchObject({ kind: "local", winner: { hostId: "titan" } });
  });
});

describe("E03 priority_context_and_empty_capacity", () => {
  it("distinguishes unknown context, disabled origin, and no capacity", async () => {
    const f = fixture(); await f.state.refresh(c => f.collect(c, { msi: 8, titan: 10 }));
    expect(f.select()).toMatchObject({ kind: "no eligible capacity", winner: null, eligibleOrder: [] });
    for (const [origin, project] of [[null, "project"], ["missing", "project"], ["titan", null], ["titan", "missing"]]) {
      expect(f.select(origin, project)).toMatchObject({ kind: "unavailable data", winner: null });
    }
    expect(f.select("laptop")).toMatchObject({ kind: "suppressed advice", winner: null });
  });
});

describe("E04 priority_host_identity_defaults_and_ties", () => {
  it.each([undefined, 0, 1001, 1.5, "1", null])("normalizes stored priority %s", priority => {
    const parsed = parsePlacementConfig({ placementPolicy: "wrong", machines: { a: { capacity: 8, enabled: true, priority } } });
    expect(parsed).toMatchObject({ placementPolicy: "offload", machines: { a: { priority: 100 } } });
  });
  it("retains identity through rename and gives new hosts priority 100", async () => {
    const parsed = parsePlacementConfig({ machines: config.machines });
    const merged = mergeMachineConfig(parsed.machines, [...hosts.map(h => ({ ...h, name: "Renamed" })), { id: "new", name: "New", status: "connected" }]);
    expect(merged.msi).toMatchObject({ priority: 1, name: "Renamed" });
    expect(merged.new).toMatchObject({ priority: 100, enabled: false });
    const f = fixture({ placementPolicy: "priority", machines: Object.fromEntries(Object.entries(merged).map(([id, m]) => [id, { ...m, priority: 100 }])) });
    await f.state.refresh(c => f.collect(c));
    expect(f.select().configuredOrder).toEqual(["laptop", "msi", "titan"]);
    expect(f.select().winner?.hostId).toBe("msi");
  });
});

describe("E05 snapshot_atomic_save_sample_ordering", () => {
  it("rejects an old collection after a save and retains observation age", async () => {
    const f = fixture(); await f.state.refresh(c => f.collect(c));
    const old = f.state.snapshot;
    const gate = deferred<Awaited<ReturnType<typeof f.collect>>>();
    const started = deferred<PlacementConfig>();
    const refresh = f.state.refresh(c => { started.resolve(c); return gate.promise; });
    const captured = await started.promise;
    f.advance(1234);
    await f.state.save(c => ({ ...c, machines: { ...c.machines, msi: { ...c.machines.msi, priority: 50 } } }));
    expect(f.state.snapshot).toMatchObject({ configRevision: 1, sampledAt: old.sampledAt,
      sampleStartedMono: old.sampleStartedMono, sampleRevision: old.sampleRevision });
    expect(f.select().winner).toBeNull();
    gate.resolve(await f.collect(captured)); expect(await refresh).toBe(false);
    expect(f.select().winner).toBeNull();
    await f.state.refresh(c => f.collect(c));
    expect(f.select().winner?.hostId).toBe("titan");
    expect(old.config.msi.priority).toBe(1);
    expect(f.persist).toHaveBeenCalledWith(expect.objectContaining({ machines: expect.objectContaining({ msi: expect.objectContaining({ priority: 50 }) }) }));
  });
  it("rejects older completions and publishes fields from only one collection", async () => {
    const f = fixture(); const gate = deferred<Awaited<ReturnType<typeof f.collect>>>();
    const start = deferred<PlacementConfig>();
    const old = f.state.refresh(c => { start.resolve(c); return gate.promise; });
    const captured = await start.promise;
    await f.state.refresh(async c => { const data = await f.collect(c, { msi: 9 }); data.snapshot.projectHosts.set("new", new Set(["titan"])); return data; });
    const accepted = f.state.snapshot;
    gate.resolve(await f.collect(captured, { titan: 9 })); expect(await old).toBe(false);
    expect(f.state.snapshot).toBe(accepted);
    expect(accepted.machines.find(m => m.hostId === "msi")?.running).toBe(9);
    expect(accepted.projectHosts.has("new")).toBe(true);
    expect(accepted.sampleRevision).toBe(2);
    expect((accepted.projectHosts as Map<string, Set<string>>).set).toBeUndefined();
    expect((accepted.projectHosts.get("new") as Set<string>).add).toBeUndefined();
  });
  it("serializes concurrent saves and leaves failed saves unchanged", async () => {
    const gate = deferred<void>(); const entered = deferred<void>();
    const persist = vi.fn(async (_: PlacementConfig) => { entered.resolve(); await gate.promise; });
    const f = fixture(config, persist); await f.state.refresh(c => f.collect(c));
    const old = f.state.snapshot;
    const save = f.state.save(c => ({ ...c, placementPolicy: "offload" }));
    await entered.promise;
    expect(f.state.snapshot).toBe(old);
    gate.reject(new Error("disk full")); await expect(save).rejects.toThrow("disk full");
    expect(f.state.snapshot).toBe(old); expect(f.state.config.placementPolicy).toBe("priority");
    persist.mockImplementation(async () => {});
    await Promise.all([
      f.state.save(c => ({ ...c, machines: { ...c.machines, msi: { ...c.machines.msi, priority: 5 } } })),
      f.state.save(c => ({ ...c, machines: { ...c.machines, titan: { ...c.machines.titan, priority: 6 } } })),
    ]);
    expect(f.state.config.machines).toMatchObject({ msi: { priority: 5 }, titan: { priority: 6 } });
    expect(f.state.snapshot.configRevision).toBe(2);
  });
  it("suppresses synchronously behind a save, commits change-back, and rejects pre-change samples", async () => {
    const gate = deferred<void>(); const entered = deferred<void>();
    const f = fixture(config, vi.fn(async () => { entered.resolve(); await gate.promise; }));
    await f.state.refresh(c => f.collect(c, { msi: 7 }));
    const old = f.state.snapshot;
    const collection = deferred<Awaited<ReturnType<typeof f.collect>>>(); const started = deferred<PlacementConfig>();
    const stale = f.state.refresh(c => { started.resolve(c); return collection.promise; });
    const captured = await started.promise;
    const save = f.state.save(c => c); await entered.promise;
    const first = f.state.thresholdChanged(70);
    expect(f.select().winner).toBeNull();
    expect(f.state.snapshot.thresholdPercent).toBe(80);
    const barrierVersion = f.state.snapshot.snapshotVersion;
    expect(await f.state.thresholdChanged("70")).toBe(false);
    expect(f.state.snapshot.snapshotVersion).toBe(barrierVersion);
    const back = f.state.thresholdChanged(80);
    gate.resolve(); await save; await first; await back;
    expect(f.state.snapshot).toMatchObject({ configRevision: 3, thresholdPercent: 80,
      sampledAt: old.sampledAt, sampleStartedMono: old.sampleStartedMono, sampleRevision: old.sampleRevision });
    collection.resolve(await f.collect(captured)); expect(await stale).toBe(false);
    expect(f.select().winner).toBeNull();
    await f.state.refresh(c => f.collect(c)); expect(f.select().winner?.hostId).toBe("msi");
    const fresh = f.state.snapshot;
    f.advance(999); expect(await f.state.thresholdChanged(80)).toBe(false);
    expect(f.state.snapshot).toBe(fresh); expect(f.select().sampleAgeMs).toBe(999);
    expect(f.select().snapshotVersion).toBe(fresh.snapshotVersion);
    expect(renderPriorityAdvice(f.select())).toContain(fresh.snapshotVersion);
  });
  it("retains legacy offload cached observations through threshold changes and failure", async () => {
    const f = fixture({ ...config, placementPolicy: "offload" });
    await f.state.refresh(c => f.collect(c, { titan: 7 }));
    expect(f.select().winner).toBeNull();
    f.advance(100_000); await f.state.thresholdChanged(70);
    expect(f.select().winner?.hostId).toBe("msi");
    await expect(f.state.refresh(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(f.select().winner?.hostId).toBe("msi");
    await f.state.thresholdChanged(80); expect(f.select().winner).toBeNull();
  });
});

describe("E06 priority_tool_refresh_deadline_and_failure", () => {
  it("waits for current collection and does not mask failure with old success", async () => {
    const f = fixture(); await f.state.refresh(c => f.collect(c));
    const gate = deferred<Awaited<ReturnType<typeof f.collect>>>(); const started = deferred<void>();
    let done = false;
    const refresh = f.state.refreshForTool(() => { started.resolve(); return gate.promise; }).then(result => { done = true; return result; });
    await started.promise; expect(done).toBe(false);
    gate.reject(new Error("offline")); expect(await refresh).toContain("offline");
    expect(f.select()).toMatchObject({ winner: null, kind: "unavailable data" });
  });
  it("times out at five seconds and rejects late success", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.state.refresh(c => f.collect(c));
    const gate = deferred<Awaited<ReturnType<typeof f.collect>>>();
    const refresh = f.state.refreshForTool(() => gate.promise);
    await vi.advanceTimersByTimeAsync(4999);
    let done = false; void refresh.then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await refresh).toContain("five seconds");
    expect(f.select().winner).toBeNull();
    gate.resolve(await f.collect(f.state.config)); await vi.advanceTimersByTimeAsync(0);
    expect(f.select().winner).toBeNull();
  });
  it("retries an obsolete revision within the same deadline", async () => {
    const f = fixture(); const gate = deferred<Awaited<ReturnType<typeof f.collect>>>(); const started = deferred<PlacementConfig>();
    let calls = 0;
    const refresh = f.state.refreshForTool(c => { if (++calls === 1) { started.resolve(c); return gate.promise; } return f.collect(c, { msi: 7 }); });
    const captured = await started.promise; await f.state.thresholdChanged(70);
    gate.resolve(await f.collect(captured)); expect(await refresh).toBeNull(); expect(calls).toBe(2);
    expect(f.select().winner?.hostId).toBe("titan");
  });
  it("does not let an obsolete caller timeout invalidate a newer successful sample", async () => {
    vi.useFakeTimers(); const f = fixture(); const gate = deferred<Awaited<ReturnType<typeof f.collect>>>();
    const slow = f.state.refreshForTool(() => gate.promise); await vi.advanceTimersByTimeAsync(1);
    await f.state.refresh(c => f.collect(c)); const newer = f.state.snapshot;
    await vi.advanceTimersByTimeAsync(5000); expect(await slow).toContain("five seconds");
    expect(f.state.snapshot).toBe(newer);
    gate.resolve(await f.collect(f.state.config)); await vi.advanceTimersByTimeAsync(0);
  });
  it("keeps one deadline while a newer configuration holds the commit boundary", async () => {
    vi.useFakeTimers();
    const persistGate = deferred<void>(); const saving = deferred<void>();
    const f = fixture(config, vi.fn(async () => { saving.resolve(); await persistGate.promise; }));
    await f.state.refresh(c => f.collect(c));
    const save = f.state.save(c => c); await saving.promise;
    const refresh = f.state.refreshForTool(c => f.collect(c));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await refresh).toContain("five seconds"); expect(f.select().winner).toBeNull();
    persistGate.resolve(); await save; await vi.advanceTimersByTimeAsync(0);
    expect(f.select().winner).toBeNull();
    await f.state.refresh(c => f.collect(c)); expect(f.select().winner?.hostId).toBe("msi");
  });
  it("rejects observations whose collection lasts 30 seconds", async () => {
    const f = fixture();
    await f.state.refresh(async c => { f.advance(30_000); return f.collect(c); });
    expect(f.select()).toMatchObject({ winner: null, kind: "unavailable data", sampleAgeMs: 30_000 });
  });
});

describe("E07 priority_advice_expiry_and_single_child", () => {
  it("uses monotonic age, expires at exactly 30 seconds, and invalidates on restart", async () => {
    const f = fixture(); await f.state.refresh(c => f.collect(c));
    f.advance(29_999); expect(f.select().winner?.hostId).toBe("msi");
    f.advance(1); expect(f.select().winner).toBeNull();
    const restart = fixture(); expect(restart.select().winner).toBeNull();
    expect(restart.state.snapshot.snapshotVersion).not.toBe(f.state.snapshot.snapshotVersion);
  });
  it("ignores wall-clock reversal when checking observation expiry", async () => {
    let mono = 100; let wall = 100_000;
    const state = new PlacementState(config, 80, async () => {}, { mono: () => mono, wall: () => wall });
    const f = fixture(); await state.refresh(c => f.collect(c));
    wall -= 90_000; mono += 30_000;
    expect(selectPlacement(state.snapshot, { currentHostId: "titan", projectId: "project", now: state.now() }))
      .toMatchObject({ sampleAgeMs: 30_000, winner: null });
  });
  it("requires refresh for one child and explains advisory capacity risk", async () => {
    const f = fixture(); await f.state.refresh(c => f.collect(c));
    const text = renderPriorityAdvice(f.select());
    for (const phrase of ["including a single child", "one spawn only", "configuration change", "Check expiry", "contention, delay, or start failure", "does not reserve capacity", "accepted advisory exposure", "Check each spawn result and child progress"]) expect(text).toContain(phrase);
    f.advance(30_000); const expired = renderPriorityAdvice(f.select());
    expect(expired).not.toContain("Recommended:"); expect(expired).toContain("Defer the spawn");
  });
});
