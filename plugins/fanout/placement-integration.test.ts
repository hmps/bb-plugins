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
