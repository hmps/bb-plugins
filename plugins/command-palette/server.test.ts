import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

interface SetupOptions {
  /** Rows t3sidebar reports, or an error to simulate it being absent. */
  lifecycle?: { rows: unknown[] } | "unavailable";
}

const threads = [
  makeThreadResponse({
    id: "th_new",
    title: "Newest",
    projectId: "proj_1",
    updatedAt: 900,
    latestAttentionAt: 900,
    lastReadAt: null,
    pinnedAt: 5,
  }),
  makeThreadResponse({
    id: "th_old",
    title: "Older",
    projectId: "proj_1",
    updatedAt: 100,
    latestAttentionAt: 100,
    lastReadAt: 100,
  }),
  makeThreadResponse({ id: "th_gone", title: "Archived", archivedAt: 1 }),
  makeThreadResponse({ id: "th_hidden", title: "Hidden", visibility: "hidden" }),
];

function setup(options: SetupOptions = {}) {
  const lifecycle = options.lifecycle ?? { rows: [] };
  const host = createFakePluginHost({
    pluginId: "command-palette",
    sdk: {
      threads: {
        list: async () => threads,
        pin: async () => threads[0],
        unpin: async () => threads[0],
        archive: async () => ({ archivedThreadIds: ["th_new"] }),
        markRead: async () => threads[0],
        markUnread: async () => threads[0],
      },
      projects: {
        list: async () => [
          { id: "proj_1", name: "bb-plugins" },
          { id: "proj_2", name: "other" },
        ],
      },
      plugins: {
        callRpc: async ({ method }: { method: string }) => {
          if (method === "listLifecycle") {
            if (lifecycle === "unavailable") {
              throw new Error("plugin t3sidebar is not loaded");
            }
            return lifecycle;
          }
          return { ok: true };
        },
      },
    },
  });
  return host;
}

describe("listThreads", () => {
  it("maps visible threads with their project names and lifecycle rows", async () => {
    const { bb, harness } = setup({
      lifecycle: {
        rows: [
          { threadId: "th_new", settledAt: 7, snoozedUntil: null, snoozedAt: null },
          { threadId: "th_old", settledAt: null, snoozedUntil: 42, snoozedAt: 1 },
        ],
      },
    });
    await plugin(bb);

    const result = await harness.behavior.callRpc("listThreads", null);

    expect(result).toEqual({
      lifecycleAvailable: true,
      threads: [
        {
          id: "th_new",
          title: "Newest",
          projectId: "proj_1",
          projectName: "bb-plugins",
          updatedAt: 900,
          isPinned: true,
          isUnread: true,
          settled: true,
          snoozedUntil: null,
        },
        {
          id: "th_old",
          title: "Older",
          projectId: "proj_1",
          projectName: "bb-plugins",
          updatedAt: 100,
          isPinned: false,
          isUnread: false,
          settled: false,
          snoozedUntil: 42,
        },
      ],
    });
  });

  it("degrades when t3sidebar is not there", async () => {
    const { bb, harness } = setup({ lifecycle: "unavailable" });
    await plugin(bb);

    const result = (await harness.behavior.callRpc("listThreads", null)) as {
      lifecycleAvailable: boolean;
      threads: { settled: boolean; snoozedUntil: number | null }[];
    };

    expect(result.lifecycleAvailable).toBe(false);
    expect(result.threads).toHaveLength(2);
    for (const thread of result.threads) {
      expect(thread.settled).toBe(false);
      expect(thread.snoozedUntil).toBeNull();
    }
  });
});

describe("listProjects", () => {
  it("returns id and name only", async () => {
    const { bb, harness } = setup();
    await plugin(bb);

    expect(await harness.behavior.callRpc("listProjects", null)).toEqual({
      projects: [
        { id: "proj_1", name: "bb-plugins" },
        { id: "proj_2", name: "other" },
      ],
    });
  });
});

describe("threadAction", () => {
  it("routes bb actions to the matching thread method", async () => {
    const { bb, harness } = setup();
    await plugin(bb);

    for (const action of ["pin", "unpin", "archive", "markRead", "markUnread"]) {
      expect(
        await harness.behavior.callRpc("threadAction", { threadId: "th_new", action }),
      ).toEqual({ ok: true });
      expect(harness.inspection.sdk.callsTo(`threads.${action}`)).toHaveLength(1);
    }
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
  });

  it("routes lifecycle actions to t3sidebar", async () => {
    const { bb, harness } = setup();
    await plugin(bb);

    for (const action of ["settle", "unsettle", "unsnooze"]) {
      expect(
        await harness.behavior.callRpc("threadAction", { threadId: "th_new", action }),
      ).toEqual({ ok: true });
    }
    expect(
      harness.inspection.sdk
        .callsTo("plugins.callRpc")
        .map((args) => (args[0] as { method: string }).method),
    ).toEqual(["settle", "unsettle", "unsnooze"]);
  });

  it("rejects an action it does not know", async () => {
    const { bb, harness } = setup();
    await plugin(bb);

    await expect(
      harness.behavior.callRpc("threadAction", { threadId: "th_new", action: "delete" }),
    ).rejects.toThrow();
  });
});

describe("snooze", () => {
  it("proxies the wake time to t3sidebar", async () => {
    const { bb, harness } = setup();
    await plugin(bb);

    expect(
      await harness.behavior.callRpc("snooze", {
        threadId: "th_new",
        snoozedUntil: 1_700_000_000_000,
      }),
    ).toEqual({ ok: true });
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")[0]?.[0]).toMatchObject({
      pluginId: "t3sidebar",
      method: "snooze",
      input: { threadId: "th_new", snoozedUntil: 1_700_000_000_000 },
    });
  });

  it("refuses a wake time that is not a positive integer", async () => {
    const { bb, harness } = setup();
    await plugin(bb);

    await expect(
      harness.behavior.callRpc("snooze", { threadId: "th_new", snoozedUntil: -1 }),
    ).rejects.toThrow();
  });
});
