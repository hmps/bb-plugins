import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { PLACEMENT_KEY } from "./placement-state";

const machines = {
  titan: { name: "Titan", capacity: 10, enabled: true, priority: 20 },
  msi: { name: "MSI", capacity: 10, enabled: true, priority: 1 },
};
const hosts = [
  { id: "titan", name: "Titan", status: "connected" },
  { id: "msi", name: "MSI", status: "connected" },
];
const threads = [{ id: "caller", projectId: "project", status: "idle", environmentHostId: "titan", archivedAt: null, deletedAt: null }];
const cleanups: Array<() => Promise<void>> = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function setup(policy: unknown = "priority", legacy = false) {
  const host = createFakePluginHost({ pluginId: "fanout", settings: { thresholdPercent: 80 }, sdk: {
    hosts: { list: async () => hosts }, threads: { list: async () => threads },
    projects: { get: async () => ({ sources: [{ hostId: "titan" }, { hostId: "msi" }] }) },
  } });
  cleanups.push(() => host.harness.lifecycle.dispose());
  await host.bb.storage.kv.set(legacy ? "machines" : PLACEMENT_KEY, legacy ? machines : { placementPolicy: policy, machines });
  await plugin(host.bb);
  const tool = (projectId = "project") => host.harness.behavior.callAgentTool("pick_machine", { projectId }, { threadId: "caller", projectId: "project" });
  const instructions = (sideChat = false) => host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    host: { id: "titan", name: "Titan" }, project: { id: "project" },
    ...(sideChat ? { origin: { pluginId: "side-chat" } } : {}),
  }));
  return { ...host, tool, instructions };
}
afterEach(async () => { for (const dispose of cleanups.splice(0)) await dispose(); vi.useRealTimers(); });

describe("E01 offload_legacy_policy_and_exclusions", () => {
  it.each(["absent", "malformed"])("preserves the overload gate for %s policy", async kind => {
    const h = await setup(kind === "absent" ? undefined : "bogus", kind === "absent");
    expect(String(await h.tool())).toContain("stay on the current machine");
    expect((await h.instructions()).instructions).toBeNull();
    h.harness.inspection.sdk.stub("threads.list", async () => [...threads,
      ...Array.from({ length: 8 }, (_, i) => ({ ...threads[0], id: `busy${i}`, status: "active" })),
    ]);
    expect(String(await h.tool())).toContain("Recommended: --machine MSI");
    expect((await h.instructions()).instructions).toContain("at or over its offload threshold");
    expect((await h.instructions(true)).instructions).toBeNull();
    h.harness.inspection.sdk.stub("hosts.list", async () => { throw new Error("offline"); });
    expect(String(await h.tool())).toContain("Recommended: --machine MSI");
  });
});

describe("E05/E06/E07 registered server boundary", () => {
  it("loads persisted priority, refreshes the tool, and gives matching cached instructions", async () => {
    vi.useFakeTimers({ toFake: ["performance", "Date", "setTimeout", "clearTimeout"] });
    const h = await setup();
    expect((await h.instructions()).instructions).not.toContain("Recommended:");
    const text = String(await h.tool());
    expect(text).toContain("Recommended: --machine MSI");
    expect(text).toContain("including a single child");
    expect((await h.instructions()).instructions).toBe(text);
    expect((await h.instructions(true)).instructions).toBeNull();
    const version = text.match(/snapshot: ([^.]+)\./)![1];
    const restarted = await h.harness.lifecycle.reload(plugin);
    cleanups.push(() => restarted.harness.lifecycle.dispose());
    const afterRestart = await restarted.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ host: { id: "titan" }, project: { id: "project" } }));
    expect(afterRestart.instructions).not.toContain("Recommended:");
    expect(afterRestart.instructions).not.toContain(version);
  });
  it("uses the requested project even when no existing thread belongs to it", async () => {
    const h = await setup(); expect(String(await h.tool("new-project"))).toContain("Recommended: --machine MSI");
    expect(h.harness.inspection.sdk.callsTo("projects.get").length).toBe(2);
  });
  it("returns no old winner after a failed current refresh", async () => {
    const h = await setup(); await h.tool();
    h.harness.inspection.sdk.stub("threads.list", async () => { throw new Error("collector offline"); });
    const text = String(await h.tool()); expect(text).not.toContain("Recommended:");
    expect(text).toContain("collector offline"); expect(text).toContain("Defer the spawn");
    expect((await h.instructions()).instructions).not.toContain("Recommended:");
  });
  it("bounds the registered tool at five seconds", async () => {
    vi.useFakeTimers(); const h = await setup(); await h.tool();
    const gate = deferred<typeof threads>();
    h.harness.inspection.sdk.stub("threads.list", () => gate.promise);
    const answer = h.tool(); await vi.advanceTimersByTimeAsync(5000);
    const text = String(await answer); expect(text).not.toContain("Recommended:"); expect(text).toContain("five seconds");
    gate.resolve(threads); await vi.advanceTimersByTimeAsync(0);
    expect((await h.instructions()).instructions).not.toContain("Recommended:");
  });
  it("suppresses advice immediately on a settings notification and restores it after matching collection", async () => {
    const h = await setup(); await h.tool();
    const gate = deferred<typeof threads>();
    h.harness.inspection.sdk.stub("threads.list", () => gate.promise);
    await h.harness.behavior.setSettings({ thresholdPercent: 70 });
    const pending = (await h.instructions()).instructions;
    expect(pending).not.toContain("Recommended:"); expect(pending).toContain("refresh pending");
    gate.resolve(threads);
    // The tool may supersede the scheduled collection; only its current result can win.
    expect(String(await h.tool())).toContain("threshold: 70%");
    expect((await h.instructions()).instructions).toContain("Recommended: --machine MSI");
  });
  it("preserves committed state after a rejected threshold write", async () => {
    const h = await setup(); await h.tool();
    const before = (await h.instructions()).instructions;
    await expect(h.harness.behavior.setSettings({ thresholdPercent: "wrong-type" })).rejects.toThrow();
    // Age can advance, so compare the committed version and threshold.
    const after = (await h.instructions()).instructions;
    expect(after?.match(/snapshot: ([^.]+)\./)?.[1]).toBe(before?.match(/snapshot: ([^.]+)\./)?.[1]);
    expect(after).toContain("threshold: 80%"); expect(after).toContain("Recommended: --machine MSI");
  });
  it("expires instructions at the strict boundary without extending age on a duplicate setting", async () => {
    vi.useFakeTimers({ toFake: ["performance", "Date", "setTimeout", "clearTimeout"] });
    const h = await setup(); await h.tool();
    await vi.advanceTimersByTimeAsync(29_999); expect((await h.instructions()).instructions).toContain("Recommended:");
    await h.harness.behavior.setSettings({ thresholdPercent: 80 });
    await vi.advanceTimersByTimeAsync(1); expect((await h.instructions()).instructions).not.toContain("Recommended:");
  });
  it("persists legacy machine edits in the atomic record and retains policy and priority", async () => {
    const h = await setup(); await h.tool();
    await h.harness.behavior.callRpc("saveMachines", { machines: [{ hostId: "msi", enabled: false, capacity: 12 }] });
    expect(await h.bb.storage.kv.get(PLACEMENT_KEY)).toEqual({ placementPolicy: "priority", machines: {
      ...machines, msi: { ...machines.msi, enabled: false, capacity: 12 },
    } });
    expect(String(await h.tool())).toContain("Recommended: --machine Titan");
  });
});

describe("E08 settings_legacy_partial_save_roundtrip", () => {
  it("retains omitted policy, priority, and hosts across legacy and partial RPC saves", async () => {
    const h = await setup();
    const before = await h.harness.behavior.callRpc("listMachines", null) as { placementPolicy: string; machines: Array<{ hostId: string; priority: number }> };
    expect(before.placementPolicy).toBe("priority");
    expect(before.machines.find(row => row.hostId === "msi")?.priority).toBe(1);
    const saved = await h.harness.behavior.callRpc("saveMachines", {
      machines: [{ hostId: "titan", enabled: false, capacity: 12 }],
    }) as { placementPolicy: string; configRevision: number; machines: Array<{ hostId: string; enabled: boolean; priority: number }> };
    expect(saved.placementPolicy).toBe("priority");
    expect(saved.configRevision).toBe(1);
    expect(saved.machines).toEqual(expect.arrayContaining([
      expect.objectContaining({ hostId: "titan", enabled: false, priority: 20 }),
      expect.objectContaining({ hostId: "msi", enabled: true, priority: 1 }),
    ]));
    const restarted = await h.harness.lifecycle.reload(plugin);
    cleanups.push(() => restarted.harness.lifecycle.dispose());
    expect(await restarted.bb.storage.kv.get(PLACEMENT_KEY)).toEqual({ placementPolicy: "priority", machines: {
      titan: { ...machines.titan, enabled: false, capacity: 12 }, msi: machines.msi,
    } });
  });
});

describe("E09 cli_policy_priority_validation", () => {
  it("reads and saves controls, then rejects invalid writes without persistence", async () => {
    const h = await setup();
    expect(await h.harness.behavior.runCli(["policy"])).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("priority") });
    expect(await h.harness.behavior.runCli(["policy", "offload"])).toMatchObject({ exitCode: 0,
      stdout: expect.stringContaining("cached offload selection remains available") });
    expect(await h.harness.behavior.runCli(["priority", "MSI", "7"])).toMatchObject({ exitCode: 0,
      stdout: expect.stringContaining("cached offload selection remains available") });
    const saved = await h.bb.storage.kv.get(PLACEMENT_KEY);
    for (const argv of [["policy", "other"], ["priority", "missing", "1"], ["priority", "MSI", "1.5"], ["priority", "MSI", "1001"]]) {
      expect((await h.harness.behavior.runCli(argv)).exitCode).toBe(1);
      expect(await h.bb.storage.kv.get(PLACEMENT_KEY)).toEqual(saved);
    }
  });

  it("preserves a concurrent RPC capacity and enabled update during a priority edit", async () => {
    const h = await setup();
    const gate = deferred<typeof hosts>();
    let hostReads = 0;
    h.harness.inspection.sdk.stub("hosts.list", () => ++hostReads === 1 ? gate.promise : hosts);
    const priority = h.harness.behavior.runCli(["priority", "MSI", "7"]);
    await Promise.resolve();
    await h.harness.behavior.callRpc("saveMachines", {
      machines: [{ hostId: "msi", enabled: false, capacity: 12 }],
    });
    gate.resolve(hosts);
    await expect(priority).resolves.toMatchObject({ exitCode: 0 });
    expect(await h.bb.storage.kv.get(PLACEMENT_KEY)).toEqual({ placementPolicy: "priority", machines: {
      ...machines, msi: { ...machines.msi, enabled: false, capacity: 12, priority: 7 },
    } });
  });

  it("waits for a replacement sample only for priority", async () => {
    const h = await setup();
    expect(await h.harness.behavior.runCli(["priority", "MSI", "7"])).toMatchObject({ exitCode: 0,
      stdout: expect.stringContaining("priority selection is unavailable") });
  });

  it("rejects an ambiguous exact name without a write", async () => {
    const h = await setup();
    h.harness.inspection.sdk.stub("hosts.list", async () => [
      ...hosts, { id: "msi-2", name: "MSI", status: "connected" },
    ]);
    const saved = await h.bb.storage.kv.get(PLACEMENT_KEY);
    expect(await h.harness.behavior.runCli(["priority", "MSI", "7"])).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("more than one") });
    expect(await h.bb.storage.kv.get(PLACEMENT_KEY)).toEqual(saved);
  });

  it("retains priority through CLI disable and enable round trips", async () => {
    const h = await setup();
    await h.harness.behavior.runCli(["priority", "MSI", "7"]);
    expect(await h.harness.behavior.runCli(["disable", "MSI"])).toMatchObject({ exitCode: 0 });
    expect(await h.harness.behavior.runCli(["enable", "MSI"])).toMatchObject({ exitCode: 0 });
    expect(await h.bb.storage.kv.get(PLACEMENT_KEY)).toEqual({ placementPolicy: "priority", machines: {
      ...machines, msi: { ...machines.msi, enabled: true, priority: 7 },
    } });
    const listed = await h.harness.behavior.callRpc("listMachines", null) as { machines: Array<{ hostId: string; priority: number }> };
    expect(listed.machines.find(row => row.hostId === "msi")?.priority).toBe(7);
  });
});

// Status reads the committed sample. Only the tool requests fresh advice.
async function status(h: Awaited<ReturnType<typeof setup>>, originHostId: string | null = "titan", projectId: string | null = "project") {
  return await h.harness.behavior.callRpc("listMachines", { originHostId, projectId }) as {
    statusText: string; configRevision: number;
    selection: import("./placement").PlacementResult;
  };
}

describe("E11 surface_policy_order_reason_parity", () => {
  it("uses the same version/context for RPC, CLI, tool, and instructions; UI receives no-context status", async () => {
    vi.useFakeTimers({ toFake: ["performance", "Date", "setTimeout", "clearTimeout"] });
    const h = await setup();
    h.harness.inspection.sdk.stub("hosts.list", async () => [...hosts, { id: "away", name: "Away", status: "disconnected" }]);
    const tool = String(await h.tool());
    const rpc = await status(h);
    expect(rpc.selection.configuredOrder).toEqual(["msi", "titan", "away"]);
    expect(rpc.selection.eligibleOrder).toEqual(["msi", "titan"]);
    expect(rpc.selection.exclusions.away).toBe("disconnected");
    expect(tool).toContain(rpc.statusText.split("\n\n")[0]);
    expect((await h.instructions()).instructions).toBe(tool);
    expect(await h.harness.behavior.runCli(["status", "--origin", "titan", "--project", "project"]))
      .toMatchObject({ stdout: `${rpc.statusText}\n` });
    const ui = await h.harness.behavior.callRpc("listMachines", null) as typeof rpc;
    expect(ui.selection.winner).toBeNull();
    expect(ui.selection.configuredOrder).toEqual(rpc.selection.configuredOrder);
    expect(ui.statusText).toContain("unavailable: origin/project context required");
    expect((await status(h, "msi")).selection.kind).toBe("local");
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await status(h)).selection.winner).toBeNull();
    expect((await h.harness.behavior.runCli(["status", "--origin", "titan", "--project", "project"])).stdout).toContain("observations expired");
  });

  it.each(["priority", "offload"])("keeps %s callers consistent across threshold commits and pending samples", async policy => {
    vi.useFakeTimers({ toFake: ["performance", "Date", "setTimeout", "clearTimeout"] });
    const h = await setup(policy);
    const busy = [...threads,
      ...Array.from({ length: 10 }, (_, i) => ({ ...threads[0], id: `t${i}`, status: "active" })),
      ...Array.from({ length: 7 }, (_, i) => ({ ...threads[0], id: `m${i}`, environmentHostId: "msi", status: "active" })),
    ];
    h.harness.inspection.sdk.stub("threads.list", async () => busy);
    await h.tool();
    expect((await status(h)).selection.winner?.hostId).toBe("msi");
    const gate = deferred<typeof threads>();
    h.harness.inspection.sdk.stub("threads.list", () => gate.promise);
    await h.harness.behavior.setSettings({ thresholdPercent: 70 });
    const pending = await status(h);
    expect(pending.selection.thresholdPercent).toBe(70);
    expect(pending.selection.winner).toBeNull();
    expect(pending.statusText).toContain(policy === "priority" ? "refresh pending" : "no eligible capacity");
    expect((await h.harness.behavior.runCli(["status", "--origin", "titan", "--project", "project"])).stdout).toBe(`${pending.statusText}\n`);
    expect((await h.instructions()).instructions ?? "").not.toContain("Recommended:");
    gate.resolve(busy);
    const answer = String(await h.tool());
    const fresh = await status(h);
    expect(fresh.selection.thresholdPercent).toBe(70);
    expect(fresh.selection.winner).toBeNull();
    expect(answer).toContain("Defer the spawn");
    expect(fresh.selection.exclusions.msi).toBe("at or above threshold");
    expect(answer).toContain(fresh.statusText.split("\n\n")[0]);
    if (policy === "priority") expect((await h.instructions()).instructions).toBe(answer);
    await h.harness.behavior.setSettings({ thresholdPercent: 80 });
    await h.tool();
    expect((await status(h)).selection.winner?.hostId).toBe("msi");
  });

  it("reports disabled origins and current refresh failure without a winner", async () => {
    const h = await setup(); await h.tool();
    await h.harness.behavior.callRpc("saveMachines", { machines: [{ hostId: "titan", capacity: 10, enabled: false }] });
    await h.tool();
    expect((await status(h)).selection).toMatchObject({ winner: null, reason: "origin disabled" });
    h.harness.inspection.sdk.stub("hosts.list", async () => { throw new Error("offline"); });
    await h.tool();
    expect((await status(h, "msi")).selection).toMatchObject({ winner: null, reason: "refresh failed: offline" });
    expect((await status(h, null, null)).statusText).toContain("Sample state: refresh failed: offline");
  });
});

describe("E12 side_chat_instruction_exclusion", () => {
  it.each(["priority", "offload"])("excludes side chat under %s", async policy => {
    const h = await setup(policy); await h.tool();
    expect((await h.instructions(true)).instructions).toBeNull();
    if (policy === "priority") {
      const text = (await h.instructions()).instructions;
      for (const field of ["Placement policy: priority", "snapshot:", "expires at:", "including a single child", "one spawn only"])
        expect(text).toContain(field);
    }
  });
});

describe("E13 remote_write_handoff_contract_inspection", () => {
  it("publishes the full handoff and stop rules through tool and normal instructions", async () => {
    const h = await setup(); const text = String(await h.tool());
    for (const field of ["repository identity", "expected full base commit", "target host ID", "exact checkout/worktree path",
      "intended branch or detached-HEAD state", "bounded file scope", "one named write owner", "tracked plus untracked",
      "HEAD against the expected base", "parent must confirm", "wrong base", "unexpected local changes", "shared write ownership",
      "any unverified state", "Do not reset, clean, stash, checkout, merge", "Repeat all checks after any handoff change",
      "Read-only work needs no write handoff", "Only a verified handoff permits writes"])
      expect(text).toContain(field);
    expect((await h.instructions()).instructions).toContain("Only a verified handoff permits writes");
  });
});

describe("E14 placement_advice_has_no_side_effects", () => {
  it("allows competing callers to receive the same remaining capacity without acquiring or releasing slots", async () => {
    vi.useFakeTimers({ toFake: ["performance", "Date", "setTimeout", "clearTimeout"] });
    const h = await setup();
    await h.harness.behavior.callRpc("saveMachines", { machines: [{ hostId: "msi", capacity: 1, enabled: true }] });
    const saved = await h.bb.storage.kv.get(PLACEMENT_KEY);
    const answers = await Promise.all([h.tool(), h.tool()]);
    for (const answer of answers) {
      const text = String(answer);
      for (const phrase of ["Recommended: --machine MSI", "contention, delay, or start failure", "does not reserve capacity",
        "accepted advisory exposure", "Check each spawn result and child progress", "defer further placement"])
        expect(text).toContain(phrase);
    }
    expect((await status(h)).selection.winner).toMatchObject({ running: 0, capacity: 1 });
    await h.instructions();
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await status(h)).selection.winner).toBeNull();
    expect(String(await h.tool())).toContain("Recommended: --machine MSI");
    expect(await h.bb.storage.kv.get(PLACEMENT_KEY)).toEqual(saved);
    expect([...new Set(h.harness.inspection.sdk.calls.map(call => call.path))].sort())
      .toEqual(["hosts.list", "projects.get", "threads.list"]);
  });
});
