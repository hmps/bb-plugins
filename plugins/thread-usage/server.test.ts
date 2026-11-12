import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { dailyUsageSchema, threadUsageSchema, threadsUsageSchema } from "./contract";
import { UsageStore, DAY } from "./storage";
import { event, turn, thread, NOW } from "./test-fixtures";

type Host = ReturnType<typeof createFakePluginHost>;
const hosts: Host[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.harness.lifecycle.dispose();
  vi.useRealTimers();
});
function fixture(installedAt = NOW) {
  vi.useFakeTimers();
  vi.setSystemTime(installedAt);
  const events = vi.fn<BbPluginApi["sdk"]["threads"]["events"]["list"]>(async () => [event(1, 10)]);
  const host = createFakePluginHost({ pluginId: "thread-usage", sdk: {
    threads: { events: { list: events }, list: async () => [] },
  } });
  hosts.push(host);
  plugin(host.bb);
  vi.setSystemTime(NOW);
  return { ...host, events, store: new UsageStore(host.bb.storage.database()) };
}

it("serializes two triggers and reads pages after the stored cursor", async () => {
  const { harness, events, store } = fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let active = 0;
  let maxActive = 0;
  events.mockImplementation(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await blocked;
    active--;
    return [event(1, 10)];
  });
  const first = harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 });
  const second = harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 });
  await Promise.resolve();
  release();
  await Promise.all([first, second]);
  expect(maxActive).toBe(1);
  expect(store.getThreadUsage(thread.id)?.totals.totalTokens).toBe(10);
  expect(events.mock.calls[1][0]).toMatchObject({ afterSeq: "1", types: ["client/turn/requested", "thread/tokenUsage/updated"], order: "asc" });
});

it("pages event results oldest first", async () => {
  const { harness, events, store } = fixture();
  events.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => event(i + 1, i + 1)))
    .mockResolvedValueOnce([event(101, 103)]);
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 101 });
  expect(store.getThreadUsage(thread.id)?.totals.totalTokens).toBe(103);
  expect(events.mock.calls[1][0]).toMatchObject({ afterSeq: "100" });
});

it("catches up updated threads serially and persists last_run_at", async () => {
  const { harness, events, store } = fixture();
  store.setMeta("last_run_at", String(NOW - DAY));
  // threads.list has a larger DTO than lifecycle events. Only these fields are read.
  const listed = { ...thread, updatedAt: NOW };
  harness.sdk.stub("threads.list", async ({ archived }) => archived ? [] : [listed]);
  await harness.behavior.runService("catch-up").done;
  expect(events).toHaveBeenCalledTimes(1);
  expect(store.getMeta("last_run_at")).toBe(String(NOW));
});

it("handles archive, unarchive, delete, and late usage triggers", async () => {
  const { harness, store } = fixture();
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 });
  await harness.behavior.emitThreadEvent("thread.archived", { thread: { ...thread, archivedAt: NOW } });
  expect(store.getThreadUsage(thread.id)?.archivedAt).toBe(NOW);
  await harness.behavior.emitThreadEvent("thread.unarchived", { thread });
  expect(store.getThreadUsage(thread.id)?.archivedAt).toBeNull();
  await harness.behavior.emitThreadEvent("thread.deleted", { thread });
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 });
  expect(store.getThreadUsage(thread.id)).toBeNull();
  expect(store.getDailyUsage(1).rows[0].totals.totalTokens).toBe(10);
});

it("serves stable RPC results and validates settings and RPC input", async () => {
  const { harness, store } = fixture();
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 });
  const usage = await harness.behavior.callRpc("getThreadUsage", { threadId: thread.id });
  expect(threadUsageSchema.parse(usage)).toEqual(store.getThreadUsage(thread.id));
  const days = await harness.behavior.callRpc("getDailyUsage", { days: 7 });
  expect(dailyUsageSchema.parse(days)).toEqual(store.getDailyUsage(7));
  await expect(harness.behavior.callRpc("getDailyUsage", { days: -1 })).rejects.toThrow();
  await expect(harness.behavior.setSettings({ retentionDays: 0 })).rejects.toThrow();
});

it("serves getThreads with the CLI threads JSON shape and defaults", async () => {
  const { harness } = fixture();
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 });
  const rpc = threadsUsageSchema.parse(await harness.behavior.callRpc("getThreads", {}));
  const cli = await harness.behavior.runCli(["threads", "--json"]);
  expect(rpc).toEqual(JSON.parse(String(cli.stdout)));
  expect(rpc.rows[0]).toMatchObject({ threadId: thread.id, title: "Usage test" });
  const since = NOW - DAY;
  expect(await harness.behavior.callRpc("getThreads", { since, limit: 1 })).toMatchObject({ since, rows: [{ threadId: thread.id }] });
  await expect(harness.behavior.callRpc("getThreads", { limit: 0 })).rejects.toThrow();
});

it("invalidates thread and totals reads only when usage changes", async () => {
  const { harness, events } = fixture();
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 });
  expect(harness.inspection.experimental_rpcInvalidations).toEqual([[`thread:${thread.id}`, "totals"]]);
  events.mockResolvedValueOnce([]);
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 });
  expect(harness.inspection.experimental_rpcInvalidations).toHaveLength(1);
});

it.each(["thread", "threads", "days"])("CLI %s returns plain and stable JSON output", async (command) => {
  const { harness, store } = fixture();
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 });
  const argv = command === "thread" ? [command, thread.id] : [command];
  const plain = await harness.behavior.runCli(argv);
  expect(plain.exitCode).toBe(0);
  expect(plain.stdout).toContain("totalTokens");
  expect(plain.stdout).toContain("unknown");
  expect(plain.stdout).toContain("10\t10\t10\t10\t10\t10\t10");
  const json = await harness.behavior.runCli([...argv, "--json"]);
  expect(json.exitCode).toBe(0);
  const actual = JSON.parse(json.stdout);
  const expected = command === "thread" ? store.getThreadUsage(thread.id)
    : command === "days" ? store.getDailyUsage(7) : store.getThreads(NOW - 7 * DAY, 7);
  expect(actual).toEqual(expected);
});

it("CLI hours, help, filters, retention warning, and errors", async () => {
  const { harness } = fixture();
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 });
  expect((await harness.behavior.runCli(["--help"])).stdout).toContain("Usage: bb thread-usage");
  const hours = await harness.behavior.runCli(["hours", "--json"]);
  expect(JSON.parse(hours.stdout).rows[0].totals.totalTokens).toBe(10);
  expect((await harness.behavior.runCli(["hours"])).stdout).toContain("hourStartUtc");
  expect((await harness.behavior.runCli(["threads", "--since", "2026-01-01"])).stdout).toContain("exceeds retention");
  expect(JSON.parse((await harness.behavior.runCli(["threads", "--project", "missing", "--limit", "1", "--json"])).stdout).rows).toEqual([]);
  for (const argv of [["days", "--days", "0"], ["threads", "--limit"], ["thread"], ["hours", "--since", "bad"], ["days", "--oops"]]) {
    expect((await harness.behavior.runCli(argv)).exitCode).toBe(1);
  }
});

it("runs scheduled rollup without changing thread totals", async () => {
  const { harness, store } = fixture(NOW - 10 * DAY);
  store.apply({ ...thread, createdAt: NOW - 10 * DAY + 1 }, { ...event(1, 10), createdAt: NOW - 8 * DAY });
  await harness.behavior.runSchedule("rollup");
  expect(store.db.prepare("SELECT COUNT(*) AS n FROM hourly_usage").get()).toEqual({ n: 0 });
  expect(store.getDailyUsage(9).rows[0].totals.totalTokens).toBe(10);
});

it("splits hourly usage by model and ignores replayed turns and usage", async () => {
  const { harness, events, store } = fixture();
  const batch = [turn(1, "model-a"), event(2, 10), turn(3, "model-b"), event(4, 25)];
  events.mockResolvedValue(batch);
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 4 });
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 4 });
  expect(store.getThreadUsage(thread.id)).toMatchObject({ model: "model-b", totals: { totalTokens: 25 } });
  expect(store.getHours(NOW - DAY, 7).rows.map((r) => [r.model, r.totals.totalTokens]))
    .toEqual([["model-a", 10], ["model-b", 15]]);
  expect(store.cursor(thread.id)).toBe(4);
});

it("advances the cursor across full pages containing only turn events", async () => {
  const { harness, events, store } = fixture();
  events.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => turn(i + 1, "model-a")))
    .mockResolvedValueOnce([]);
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 100 });
  expect(events.mock.calls[1][0]).toMatchObject({ afterSeq: "100" });
  expect(store.cursor(thread.id)).toBe(100);
  expect(store.getThreadUsage(thread.id)).toMatchObject({ model: "model-a", totals: { totalTokens: 0 } });
  expect(store.getHours(NOW - DAY, 7).rows).toEqual([]);
  events.mockResolvedValueOnce([turn(1, "stale-model")]);
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 100 });
  expect(store.cursor(thread.id)).toBe(100);
  expect(store.getThreadUsage(thread.id)?.model).toBe("model-a");
});

it("scans pending token usage before deleting a thread", async () => {
  const { harness, events, store } = fixture();
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 });
  events.mockResolvedValueOnce([event(2, 25)]);
  await harness.behavior.emitThreadEvent("thread.deleted", { thread: { ...thread, deletedAt: NOW } });
  expect(store.getThreadUsage(thread.id)).toBeNull();
  expect(store.getDailyUsage(1).rows[0].totals.totalTokens).toBe(25);
  expect(events.mock.calls[1][0]).toMatchObject({ threadId: thread.id, afterSeq: "1" });
  await harness.behavior.emitThreadEvent("thread.deleted", { thread: { ...thread, deletedAt: NOW } });
  expect(events).toHaveBeenCalledTimes(2);
  expect(store.getDailyUsage(1).rows[0].totals.totalTokens).toBe(25);
});

it("deletes and preserves counted totals when final event reads return 404", async () => {
  const { harness, events, store } = fixture();
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 });
  events.mockRejectedValueOnce(Object.assign(new Error("Thread not found"), { status: 404 }));
  await harness.behavior.emitThreadEvent("thread.deleted", { thread: { ...thread, deletedAt: NOW } });
  expect(events).toHaveBeenCalledTimes(2);
  expect(store.getThreadUsage(thread.id)).toBeNull();
  expect(store.getDailyUsage(1).rows[0].totals.totalTokens).toBe(10);
});

it("computes relative thread hours on every server read with the CLI JSON shape", async () => {
  const { harness } = fixture();
  const first = threadsUsageSchema.parse(await harness.behavior.callRpc("getThreads", { hours: 24 }));
  expect(first.since).toBe(NOW - DAY);
  vi.setSystemTime(NOW + 2 * 3_600_000 + 15 * 60_000);
  const next = threadsUsageSchema.parse(await harness.behavior.callRpc("getThreads", { hours: 24 }));
  expect(next.since).toBe(NOW + 2 * 3_600_000 - DAY);
  const cli = await harness.behavior.runCli(["threads", "--since", new Date(next.since).toISOString(), "--json"]);
  expect(next).toEqual(JSON.parse(String(cli.stdout)));
});
