// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { DailyUsage, ThreadUsage, ThreadsUsage, Totals } from "./contract";
import { dayKey } from "./lib/format";

const app = await loadPluginApp(() => import("./app"));
afterEach(() => cleanup());

const totals = (totalTokens: number, part = 0): Totals => ({
  totalTokens, inputTokens: part, cachedInputTokens: 0, cacheReadInputTokens: part,
  cacheWriteInputTokens: part, outputTokens: part, reasoningOutputTokens: 0,
});
const usage = (over: Partial<ThreadUsage> = {}): ThreadUsage => ({
  threadId: "thr_a", projectId: "proj_a", providerId: "codex", model: "gpt-5.5", title: "A",
  firstSeenAt: Date.now() - 60_000, updatedAt: Date.now(), archivedAt: null, baseline: false,
  totals: totals(18_239_216, 1_234), ...over,
});
const props = { threadId: "thr_a", projectId: "proj_a", environment: null };

describe("Tokens info row", () => {
  const row = () => app.threadInfoRows[0]!;

  it("shows the compact total and model, and the exact breakdown on select", async () => {
    renderSlot(row(), props, { rpc: { getThreadUsage: () => usage() } });
    const toggle = await screen.findByRole("button", { expanded: false });
    expect(toggle.textContent).toContain("18.2M");
    expect(toggle.textContent).toContain("gpt-5.5");
    expect(screen.getByText(/^Since /)).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("18,239,216")).toBeTruthy();
    expect(screen.getAllByText("1,234")).toHaveLength(4);
  });

  it("says when tracking started for a baseline thread", async () => {
    renderSlot(row(), props, { rpc: { getThreadUsage: () => usage({ baseline: true }) } });
    expect(await screen.findByText(/^Tracking started /)).toBeTruthy();
  });

  it.each([["no row", null], ["zero totals", usage({ totals: totals(0) })]])("is quiet with %s", async (_, value) => {
    renderSlot(row(), props, { rpc: { getThreadUsage: () => value } });
    expect(await screen.findByText("No usage tracked yet")).toBeTruthy();
  });

  it("refreshes when the server invalidates the thread tag", async () => {
    let total = 1_000;
    const view = renderSlot(row(), props, { rpc: { getThreadUsage: () => usage({ totals: totals(total) }) } });
    await screen.findByText("1k");
    total = 2_500;
    await view.behavior.experimental_invalidateRpc(["thread:thr_a"]);
    expect(await screen.findByText("2.5k")).toBeTruthy();
  });
});

describe("Thread usage page", () => {
  const today = dayKey(Date.now());
  const daily: DailyUsage = { days: 14, rows: [
    { day: today, projectId: "proj_a", model: "claude-opus-5-5", totals: totals(1_200_000) },
    { day: today, projectId: "proj_b", model: "gpt-5.5", totals: totals(340_000) },
  ] };
  const threads: ThreadsUsage = { since: 0, retentionStart: 0, truncated: false, rows: [
    { threadId: "thr_a", projectId: "proj_a", model: "claude-opus-5-5", title: "Build the UI", totals: totals(900_000) },
    { threadId: "thr_b", projectId: "proj_b", model: "gpt-5.5", title: null, totals: totals(340_000) },
  ] };

  it("shows daily totals by model and opens a top thread", async () => {
    const view = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { getDailyUsage: () => daily, getThreads: () => threads } });
    expect(await screen.findByText("Build the UI")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Models" }).textContent).toContain("claude-opus-5-5");
    expect(screen.getAllByText("1.5M").length).toBeGreaterThan(0);
    expect(screen.getByText("thr_b")).toBeTruthy();
    fireEvent.click(screen.getByText("Build the UI"));
    expect(view.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_a", options: { split: false } }]);
    expect(view.inspection.rpcCalls.map((c) => c.method).sort()).toEqual(["getDailyUsage", "getThreads"]);
  });

  it("requests a server-relative 24-hour window after invalidation", async () => {
    const view = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { getDailyUsage: () => daily, getThreads: () => threads } });
    await screen.findByText("Build the UI");
    expect(view.inspection.rpcCalls.find((call) => call.method === "getThreads")?.input)
      .toEqual({ hours: 24, limit: 100 });
    await view.behavior.experimental_invalidateRpc(["totals"]);
    const calls = view.inspection.rpcCalls.filter((call) => call.method === "getThreads");
    expect(calls).toHaveLength(2);
    expect(calls[1].input).toEqual({ hours: 24, limit: 100 });
  });

  it("shows empty states", async () => {
    renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: { getDailyUsage: () => ({ days: 14, rows: [] }), getThreads: () => ({ ...threads, rows: [] }) },
    });
    expect(await screen.findByText("No usage tracked in the last 14 days.")).toBeTruthy();
    expect(await screen.findByText("No thread used tokens in the last 24 hours.")).toBeTruthy();
  });
});
