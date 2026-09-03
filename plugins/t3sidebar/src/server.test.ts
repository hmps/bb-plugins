import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "./server";

type LifecycleRow = {
  threadId: string;
  settledAt: number | null;
  snoozedUntil: number | null;
  snoozedAt: number | null;
};

type LifecycleHandlers = Record<
  string,
  (input: Record<string, number | string>) => Promise<unknown>
>;

function setup(
  archive: (threadId: string) => Promise<unknown> = async () => ({}),
) {
  const rows = new Map<string, LifecycleRow>();
  const archiveCalls: string[] = [];
  let handlers: LifecycleHandlers = {};

  const db = {
    prepare(sql: string) {
      if (sql.includes("SELECT")) {
        return {
          all: () =>
            [...rows.values()].map((row) => ({
              thread_id: row.threadId,
              settled_at: row.settledAt,
              snoozed_until: row.snoozedUntil,
              snoozed_at: row.snoozedAt,
            })),
        };
      }
      if (sql.includes("DELETE")) {
        return { run: (threadId: string) => rows.delete(threadId) };
      }
      return {
        run: (
          threadId: string,
          settledAt: number | null,
          snoozedUntil: number | null,
          snoozedAt: number | null,
        ) => rows.set(threadId, { threadId, settledAt, snoozedUntil, snoozedAt }),
      };
    },
  };

  const bb = {
    settings: { define: () => {} },
    storage: { database: () => db, migrate: () => {} },
    realtime: { publish: () => {} },
    sdk: {
      threads: {
        archiveAll: async ({ threadId }: { threadId: string }) => {
          archiveCalls.push(threadId);
          return await archive(threadId);
        },
        queuedMessages: { list: async () => [] },
      },
      subscribe: () => () => {},
    },
    onDispose: () => {},
    rpc: {
      register: (_contract: unknown, registered: LifecycleHandlers) => {
        handlers = registered;
      },
    },
    events: { on: () => {} },
    log: { debug: () => {} },
  } as unknown as BbPluginApi;

  plugin(bb);
  return {
    archiveCalls,
    call: async (method: string, input: Record<string, number | string>) =>
      await handlers[method]!(input),
  };
}

describe("settleAndArchive", () => {
  it("settles, clears a snooze, and archives the thread", async () => {
    const host = setup();

    await host.call("snooze", {
      threadId: "thr_1",
      snoozedUntil: 1_700_000_000_000,
    });
    await expect(host.call("settleAndArchive", { threadId: "thr_1" })).resolves.toEqual({
      ok: true,
    });

    expect(host.archiveCalls).toEqual(["thr_1"]);
    await expect(host.call("listLifecycle", {})).resolves.toMatchObject({
      rows: [
        {
          threadId: "thr_1",
          settledAt: expect.any(Number),
          snoozedUntil: null,
          snoozedAt: null,
        },
      ],
    });
  });

  it("keeps the settlement when archive fails", async () => {
    const host = setup(async () => {
      throw new Error("archive unavailable");
    });

    await expect(host.call("settleAndArchive", { threadId: "thr_1" })).rejects.toThrow(
      "archive unavailable",
    );
    await expect(host.call("listLifecycle", {})).resolves.toMatchObject({
      rows: [{ threadId: "thr_1", settledAt: expect.any(Number) }],
    });
  });

  it("keeps normal settle separate from archive", async () => {
    const host = setup();

    await expect(host.call("settle", { threadId: "thr_1" })).resolves.toEqual({ ok: true });
    expect(host.archiveCalls).toHaveLength(0);
  });
});
