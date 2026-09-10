// Better Sidebar (bb-plugin-t3sidebar) backend — the settled / snoozed store.
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
import {
  isProjectColorId,
  NEUTRAL_COLOR_ID,
  PROJECT_COLOR_CHANNEL,
  type ProjectColorSignal,
} from "./project-colors";

const migrations = [
  `CREATE TABLE IF NOT EXISTS thread_lifecycle (
     thread_id      TEXT PRIMARY KEY,
     settled_at     INTEGER,
     snoozed_until  INTEGER,
     snoozed_at     INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS project_color (
     project_id TEXT PRIMARY KEY,
     color_id   TEXT NOT NULL
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

interface ProjectColorDbRow {
  project_id: string;
  color_id: string;
}

/** One row of the project-colour settings list. */
export interface ProjectColorRow {
  projectId: string;
  name: string;
  colorId: string;
}

interface SweepThread {
  id: string;
  archivedAt: number | null;
  latestAttentionAt: number;
  hasPendingInteraction: boolean;
  status: string;
  activity: Record<string, number>;
}

const threadIdSchema = z.object({ threadId: z.string().trim().min(1) });
const SETTLED_SWEEP_CRON = "15 3 * * *";
const SETTLED_RETENTION_MS = 10 * 24 * 60 * 60 * 1_000;

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
  settleAndArchive: {
    input: threadIdSchema,
    output: z.object({ ok: z.boolean() }),
  },
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
   * Every project bb knows about, with its stored colour. The settings
   * section shows all of them, so a project with no colour is a choice the
   * user can see rather than a row that is missing.
   */
  listProjectColors: {
    input: z.object({}),
    output: z.object({
      projects: z.array(
        z.object({
          projectId: z.string(),
          name: z.string(),
          colorId: z.string(),
        }),
      ),
    }),
  },
  setProjectColor: {
    input: z.object({
      projectId: z.string().trim().min(1),
      // Neutral is stored like any other colour; `null` is not a value here,
      // so the frontend has one way to say "no colour".
      colorId: z.string().trim().min(1),
    }),
    output: z.object({ ok: z.boolean() }),
  },
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

  const readSettledBefore = (cutoff: number): StoredLifecycleRow[] =>
    (
      db
        .prepare(
          `SELECT thread_id, settled_at, snoozed_until, snoozed_at
             FROM thread_lifecycle
            WHERE settled_at IS NOT NULL AND settled_at < ?`,
        )
        .all(cutoff) as LifecycleDbRow[]
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

  const readProjectColors = (): Map<string, string> =>
    new Map(
      (
        db
          .prepare(`SELECT project_id, color_id FROM project_color`)
          .all() as ProjectColorDbRow[]
      ).map((row) => [row.project_id, row.color_id]),
    );

  const writeProjectColor = (projectId: string, colorId: string): void => {
    // Neutral is the absence of a colour, so it is stored as no row at all.
    // The store then holds only what the user actually chose.
    if (colorId === NEUTRAL_COLOR_ID) {
      db.prepare(`DELETE FROM project_color WHERE project_id = ?`).run(
        projectId,
      );
    } else {
      db.prepare(
        `INSERT INTO project_color (project_id, color_id)
         VALUES (?, ?)
         ON CONFLICT(project_id) DO UPDATE SET color_id = excluded.color_id`,
      ).run(projectId, colorId);
    }
    const signal: ProjectColorSignal = {
      projectId,
      colorId: colorId === NEUTRAL_COLOR_ID ? null : colorId,
    };
    bb.realtime.publish(PROJECT_COLOR_CHANNEL, signal);
  };

  const runSettledSweep = async (): Promise<void> => {
    const threads: SweepThread[] = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const page = (await bb.sdk.threads.list({
        archived: false,
        includeHidden: true,
        limit: pageSize,
        offset,
      })) as SweepThread[];
      threads.push(...page);
      if (page.length < pageSize) break;
    }
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    for (const row of readSettledBefore(Date.now() - SETTLED_RETENTION_MS)) {
      const thread = byId.get(row.threadId);
      if (thread === undefined || row.settledAt === null) continue;
      if (
        thread.archivedAt !== null ||
        thread.latestAttentionAt > row.settledAt ||
        thread.hasPendingInteraction ||
        (thread.status !== "idle" && thread.status !== "error") ||
        Object.values(thread.activity).some((count) => count > 0)
      ) continue;
      try {
        await bb.sdk.threads.archiveAll({ threadId: row.threadId });
        clear(row.threadId);
      } catch (error) {
        bb.log.error(
          `settled sweep archive failed for ${row.threadId}: ${String(error)}`,
        );
      }
    }
  };

  bb.background.schedule("settled-sweep", SETTLED_SWEEP_CRON, runSettledSweep);

  const settle = (threadId: string): void => {
    // Settling clears any snooze: they are two answers to the same question,
    // and holding both would make the shelf order ambiguous.
    write({
      threadId,
      settledAt: Date.now(),
      snoozedUntil: null,
      snoozedAt: null,
    });
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
    async listProjectColors() {
      const stored = readProjectColors();
      const projects = (await bb.sdk.projects.list({
        includePersonal: true,
      })) as Array<{ id: string; name: string }>;
      return {
        projects: projects.map((project) => ({
          projectId: project.id,
          name: project.name,
          colorId: stored.get(project.id) ?? NEUTRAL_COLOR_ID,
        })),
      };
    },
    async setProjectColor({ projectId, colorId }) {
      // The palette is the contract: an unknown id would draw as neutral
      // anyway, so reject it here instead of storing a value nothing renders.
      if (!isProjectColorId(colorId)) {
        throw new Error(`Unknown project colour: ${colorId}`);
      }
      writeProjectColor(projectId, colorId);
      return { ok: true };
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
      settle(threadId);
      return { ok: true };
    },
    async settleAndArchive({ threadId }) {
      settle(threadId);
      // The lifecycle store and BB's thread store cannot share a transaction.
      // If this fails, keep the settlement and reject so the caller can retry.
      await bb.sdk.threads.archiveAll({ threadId });
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
