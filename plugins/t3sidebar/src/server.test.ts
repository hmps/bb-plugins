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

const quietThread = (overrides: Record<string, unknown> = {}) => ({
  archivedAt: null,
  deletedAt: null,
  latestAttentionAt: 0,
  hasPendingInteraction: false,
  status: "idle",
  activity: {
    activeBackgroundAgentCount: 0,
    activeBackgroundCommandCount: 0,
    activeGoalCount: 0,
    activePlanModeCount: 0,
    activeWorkflowCount: 0,
  },
  ...overrides,
});

function setup(
  archive: (threadId: string) => Promise<unknown> = async () => ({}),
) {
  const rows = new Map<string, LifecycleRow>();
  const archiveCalls: string[] = [];
  const threadById = new Map<string, Record<string, unknown>>();
  const errors: string[] = [];
  let scheduledSweep: (() => Promise<void>) | null = null;
  let scheduleName: string | null = null;
  let scheduleCron: string | null = null;
  let handlers: LifecycleHandlers = {};

  const db = {
    prepare(sql: string) {
      if (sql.includes("SELECT")) {
        return {
          all: (cutoff?: number) =>
            [...rows.values()]
              .filter(
                (row) =>
                  !sql.includes("settled_at IS NOT NULL") ||
                  (row.settledAt !== null && row.settledAt < (cutoff ?? Infinity)),
              )
              .map((row) => ({
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
        list: async () =>
          [...threadById.entries()].map(([id, thread]) => ({
            id,
            ...quietThread(thread),
          })),
        queuedMessages: { list: async () => [] },
      },
      subscribe: () => () => {},
    },
    background: {
      schedule: (name: string, cron: string, fn: () => Promise<void>) => {
        scheduleName = name;
        scheduleCron = cron;
        scheduledSweep = fn;
      },
    },
    onDispose: () => {},
    rpc: {
      register: (_contract: unknown, registered: LifecycleHandlers) => {
        handlers = registered;
      },
    },
    events: { on: () => {} },
    log: { debug: () => {}, error: (message: string) => errors.push(message) },
  } as unknown as BbPluginApi;

  plugin(bb);
  return {
    archiveCalls,
    rows,
    threadById,
    errors,
    schedule: () => ({ name: scheduleName, cron: scheduleCron }),
    runSweep: async () => await scheduledSweep?.(),
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

describe("settled sweep", () => {
  const old = () => Date.now() - 11 * 24 * 60 * 60 * 1_000;

  it("registers a daily schedule and archives eligible idle and error threads", async () => {
    const host = setup();
    const settledAt = old();
    for (const threadId of ["thr_idle", "thr_error"]) {
      await host.call("settle", { threadId });
      host.rows.get(threadId)!.settledAt = settledAt;
    }
    host.threadById.set("thr_idle", quietThread({ latestAttentionAt: settledAt }));
    host.threadById.set(
      "thr_error",
      quietThread({ latestAttentionAt: settledAt, status: "error" }),
    );

    expect(host.schedule()).toEqual({ name: "settled-sweep", cron: "15 3 * * *" });
    await host.runSweep();

    expect(host.archiveCalls).toEqual(["thr_idle", "thr_error"]);
    expect(host.rows.size).toBe(0);
  });

  it("keeps rows that have newer attention, interaction, live status, or activity", async () => {
    const host = setup();
    const blocked = [
      quietThread({ latestAttentionAt: Date.now() }),
      quietThread({ hasPendingInteraction: true }),
      quietThread({ status: "active" }),
      quietThread({ status: "starting" }),
      quietThread({ status: "stopping" }),
      quietThread({ activity: { ...quietThread().activity, activeWorkflowCount: 1 } }),
    ];
    for (const [index, thread] of blocked.entries()) {
      const threadId = `thr_blocked_${index}`;
      await host.call("settle", { threadId });
      host.rows.get(threadId)!.settledAt = old();
      host.threadById.set(threadId, thread);
    }

    await host.runSweep();

    expect(host.archiveCalls).toEqual([]);
    expect(host.rows.size).toBe(blocked.length);
  });

  it("archives eligible rows and logs and keeps a failed archive", async () => {
    const host = setup(async (threadId) => {
      if (threadId === "thr_failure") throw new Error("archive unavailable");
    });
    for (const threadId of ["thr_archived", "thr_missing", "thr_failure"]) {
      await host.call("settle", { threadId });
      host.rows.get(threadId)!.settledAt = old();
    }
    host.threadById.set("thr_archived", quietThread({ archivedAt: old() }));
    host.threadById.set("thr_failure", quietThread({ latestAttentionAt: old() }));

    await host.runSweep();

    expect(host.archiveCalls).toEqual(["thr_failure"]);
    expect(host.rows.has("thr_archived")).toBe(true);
    expect(host.rows.has("thr_missing")).toBe(true);
    expect(host.rows.has("thr_failure")).toBe(true);
    expect(host.errors).toContain("settled sweep archive failed for thr_failure: Error: archive unavailable");
  });
});
