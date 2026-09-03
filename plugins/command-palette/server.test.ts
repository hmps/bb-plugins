import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

interface SetupOptions {
  /** Whether t3sidebar answers, or an error to simulate it being absent. */
  lifecycle?: "available" | "unavailable";
}

const thread = makeThreadResponse({ id: "th_new", title: "Newest" });

function setup(options: SetupOptions = {}) {
  const lifecycle = options.lifecycle ?? "available";
  return createFakePluginHost({
    pluginId: "command-palette",
    sdk: {
      threads: {
        pin: async () => thread,
        unpin: async () => thread,
        archive: async () => ({ archivedThreadIds: ["th_new"] }),
        markRead: async () => thread,
        markUnread: async () => thread,
      },
      plugins: {
        callRpc: async ({ method }: { method: string }) => {
          if (method === "listLifecycle") {
            if (lifecycle === "unavailable") {
              throw new Error("plugin t3sidebar is not loaded");
            }
            return { rows: [] };
          }
          return { ok: true };
        },
      },
    },
  });
}

describe("lifecycleAvailable", () => {
  it("reports true when t3sidebar answers", async () => {
    const { bb, harness } = setup();
    await plugin(bb);

    expect(await harness.behavior.callRpc("lifecycleAvailable", null)).toEqual({
      available: true,
    });
  });

  it("reports false when t3sidebar is not there", async () => {
    const { bb, harness } = setup({ lifecycle: "unavailable" });
    await plugin(bb);

    expect(await harness.behavior.callRpc("lifecycleAvailable", null)).toEqual({
      available: false,
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

    for (const action of ["settle", "settleAndArchive", "unsettle", "unsnooze"]) {
      expect(
        await harness.behavior.callRpc("threadAction", { threadId: "th_new", action }),
      ).toEqual({ ok: true });
    }
    expect(
      harness.inspection.sdk
        .callsTo("plugins.callRpc")
        .map((args) => (args[0] as { method: string }).method),
    ).toEqual(["settle", "settleAndArchive", "unsettle", "unsnooze"]);
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
