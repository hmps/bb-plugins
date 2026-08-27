// bb-plugin-t3sidebar backend — the settled / snoozed store.
//
// This state lives in the plugin's own SQLite database, never on bb's thread.
// Putting it on the thread would mean a schema change, a wire change, and a
// HOST_DAEMON_PROTOCOL_VERSION bump for something only this sidebar
// understands. Here, uninstalling the plugin removes its state with it.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  ATTENTION_FIRST_SETTING,
  QUEUE_CHANNEL,
  WORKING_SHELF_SETTING,
  type QueueCountSignal,
} from "./inbox";

const migrations = [
  `CREATE TABLE IF NOT EXISTS thread_lifecycle (
     thread_id      TEXT PRIMARY KEY,
     settled_at     INTEGER,
     snoozed_until  INTEGER,
     snoozed_at     INTEGER
   )`,
];

export interface StoredLifecycleRow {
  threadId: string;
  settledAt: number | null;
  snoozedUntil: number | null;
  snoozedAt: number | null;
}

interface LifecycleDbRow {
  thread_id: string;
  settled_at: number | null;
  snoozed_until: number | null;
  snoozed_at: number | null;
}

const threadIdSchema = z.object({ threadId: z.string().trim().min(1) });

export const t3sidebarRpcContract = defineRpcContract({
  listLifecycle: {
    input: z.object({}),
    output: z.object({
      rows: z.array(
        z.object({
          threadId: z.string(),
          settledAt: z.number().nullable(),
          snoozedUntil: z.number().nullable(),
          snoozedAt: z.number().nullable(),
        }),
      ),
    }),
  },
  settle: { input: threadIdSchema, output: z.object({ ok: z.boolean() }) },
  unsettle: { input: threadIdSchema, output: z.object({ ok: z.boolean() }) },
  snooze: {
    input: z.object({
      threadId: z.string().trim().min(1),
      // Absolute wake time, so a snooze means the same thing on every device.
      snoozedUntil: z.number().int().positive(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  unsnooze: { input: threadIdSchema, output: z.object({ ok: z.boolean() }) },
  /**
   * Queued-message counts for a set of threads. The sidebar's thread view
   * carries no queue field, so the server reads the queue over the SDK and
   * caches the count per thread.
   */
  queueCounts: {
    input: z.object({ threadIds: z.array(z.string().trim().min(1)).max(500) }),
    output: z.object({
      counts: z.array(z.object({ threadId: z.string(), count: z.number() })),
    }),
  },
});

/** Channel the frontend re-reads on. */
export const LIFECYCLE_CHANNEL = "lifecycle";

export default function plugin(bb: BbPluginApi) {
  // The one exception to the static order, and off by default: with it on,
  // each shelf sorts by urgency — a raised hand, then an unread result, then
  // live work, then the rest. The frontend reads the value through `useSettings`.
  bb.settings.define({
    [ATTENTION_FIRST_SETTING]: {
      type: "boolean",
      label: "Needs attention first",
      description:
        "Sort each shelf by urgency: waiting for input, then unread, then working, then the rest.",
      default: false,
    },
    // Live work rarely needs the user, so by default it leaves the inbox for
    // a collapsed shelf and comes back the moment it finishes or asks.
    [WORKING_SHELF_SETTING]: {
      type: "boolean",
      label: "Working shelf",
      description:
        "Move threads that are working to a collapsed Working shelf. They return when they finish or ask.",
      default: true,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);

  const readAll = (): StoredLifecycleRow[] =>
    (
      db
        .prepare(
          `SELECT thread_id, settled_at, snoozed_until, snoozed_at
             FROM thread_lifecycle`,
        )
        .all() as LifecycleDbRow[]
    ).map((row) => ({
      threadId: row.thread_id,
      settledAt: row.settled_at,
      snoozedUntil: row.snoozed_until,
      snoozedAt: row.snoozed_at,
    }));

  const write = (row: StoredLifecycleRow): void => {
    db.prepare(
      `INSERT INTO thread_lifecycle
         (thread_id, settled_at, snoozed_until, snoozed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         settled_at = excluded.settled_at,
         snoozed_until = excluded.snoozed_until,
         snoozed_at = excluded.snoozed_at`,
    ).run(row.threadId, row.settledAt, row.snoozedUntil, row.snoozedAt);
    bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId: row.threadId });
  };

  const clear = (threadId: string): void => {
    db.prepare(`DELETE FROM thread_lifecycle WHERE thread_id = ?`).run(
      threadId,
    );
    bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId });
  };

  // Queue counts, cached per thread. The sidebar has no queue field, and
  // one list call per visible thread on every render would be far too many,
  // so a thread is read once and then only again when bb reports a change.
  const queueCounts = new Map<string, number>();
  const readQueueCount = async (threadId: string): Promise<number> => {
    try {
      const queued = await bb.sdk.threads.queuedMessages.list({ threadId });
      return queued.length;
    } catch (error) {
      // A deleted or unreachable thread has nothing queued that we can show.
      bb.log.debug(`queue read failed for ${threadId}: ${String(error)}`);
      return 0;
    }
  };
  const unsubscribeQueue = bb.sdk.subscribe({
    event: "thread:changed",
    callback: (event) => {
      if (!event.changes.includes("queue-changed")) return;
      const threadId = event.id;
      if (!threadId) return;
      void readQueueCount(threadId).then((count) => {
        if (queueCounts.get(threadId) === count) return;
        queueCounts.set(threadId, count);
        const signal: QueueCountSignal = { threadId, count };
        bb.realtime.publish(QUEUE_CHANNEL, signal);
      });
    },
  });
  bb.onDispose(() => unsubscribeQueue());

  bb.rpc.register(t3sidebarRpcContract, {
    async listLifecycle() {
      return { rows: readAll() };
    },
    async queueCounts({ threadIds }) {
      const counts = await Promise.all(
        threadIds.map(async (threadId) => {
          let count = queueCounts.get(threadId);
          if (count === undefined) {
            count = await readQueueCount(threadId);
            queueCounts.set(threadId, count);
          }
          return { threadId, count };
        }),
      );
      return { counts };
    },
    async settle({ threadId }) {
      // Settling clears any snooze: they are two answers to the same
      // question, and holding both would make the shelf order ambiguous.
      write({
        threadId,
        settledAt: Date.now(),
        snoozedUntil: null,
        snoozedAt: null,
      });
      return { ok: true };
    },
    async unsettle({ threadId }) {
      clear(threadId);
      return { ok: true };
    },
    async snooze({ threadId, snoozedUntil }) {
      const now = Date.now();
      write({
        threadId,
        settledAt: null,
        snoozedUntil,
        snoozedAt: now,
      });
      return { ok: true };
    },
    async unsnooze({ threadId }) {
      clear(threadId);
      return { ok: true };
    },
  });

  // A deleted thread must not leave a row behind that would park a future
  // thread reusing the id, and stale rows accumulate otherwise.
  bb.events.on("thread.deleted", ({ thread }) => {
    clear(thread.id);
    queueCounts.delete(thread.id);
  });
}
