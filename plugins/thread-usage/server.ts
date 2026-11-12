import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { runCli } from "./cli";
import { TOTALS_TAG, threadTag, usageRpcContract } from "./contract";
import { DAY, hourStart } from "./storage";
import { migrations, UsageStore, type ThreadInfo } from "./storage";

/** All event reads and lifecycle changes for one thread share one queue. */
export class ThreadQueue {
  private readonly pending = new Map<string, Promise<void>>();
  enqueue(id: string, work: () => void | Promise<void>): Promise<void> {
    const next = (this.pending.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    this.pending.set(id, next);
    void next.finally(() => { if (this.pending.get(id) === next) this.pending.delete(id); }).catch(() => {});
    return next;
  }
  async drain() { await Promise.allSettled([...this.pending.values()]); }
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    retentionDays: {
      type: "number", label: "Hourly retention (days)", default: 7,
      description: "Keep hourly thread usage for this many days. Daily totals remain stored.",
      experimental_schema: z.number().int().min(1),
    },
  });
  const db = bb.storage.database();
  // Set this before migrations create tables, so incremental_vacuum can reclaim pages.
  db.pragma("auto_vacuum = INCREMENTAL");
  bb.storage.migrate(db, migrations);
  const store = new UsageStore(db);
  const queue = new ThreadQueue();
  const deleted = new Set<string>();
  const controller = new AbortController();
  let stopped = false;
  const changed = (id: string) => bb.rpc.experimental_invalidate([threadTag(id), TOTALS_TAG]);
  const scan = (thread: ThreadInfo) => queue.enqueue(thread.id, async () => {
    if (stopped || deleted.has(thread.id)) return;
    let after = store.cursor(thread.id);
    let seen = 0;
    while (!stopped) {
      const events = await bb.sdk.threads.events.list({
        threadId: thread.id, afterSeq: String(after), types: ["client/turn/requested", "thread/tokenUsage/updated"],
        order: "asc", limit: "100", signal: controller.signal,
      });
      let last = after;
      seen += events.length;
      for (const event of events) {
        if (event.type === "client/turn/requested") store.applyTurn(thread, event);
        if (event.type === "thread/tokenUsage/updated") store.apply(thread, event);
        last = Math.max(last, event.seq);
      }
      if (events.length < 100) break;
      if (last <= after) throw new Error(`Token event page did not advance for ${thread.id}.`);
      after = last;
    }
    if (!stopped) store.archive(thread.id, thread.archivedAt);
    if (seen > 0) changed(thread.id);
  });
  bb.events.on("experimental_thread.events", async ({ thread }) => {
    if (thread.deletedAt !== null) return;
    await scan(thread);
  });
  for (const name of ["thread.archived", "thread.unarchived"] as const) {
    bb.events.on(name, ({ thread }) => queue.enqueue(thread.id, () => {
      store.archive(thread.id, name === "thread.archived" ? thread.archivedAt ?? Date.now() : null);
      changed(thread.id);
    }));
  }
  bb.events.on("thread.deleted", ({ thread }) => {
    deleted.add(thread.id);
    return queue.enqueue(thread.id, () => {
      store.deleteThread(thread.id);
      changed(thread.id);
    });
  });
  bb.background.service("catch-up", {
    async start(signal) {
      const started = Date.now();
      const lastRun = Number(store.getMeta("last_run_at") ?? store.installedAt);
      // No updated-since SDK filter exists. Read at most 20,000 rows per archive state.
      for (const archived of [false, true]) {
        let complete = false;
        for (let page = 0; page < 100; page++) {
          if (signal.aborted || stopped) return;
          const threads = await bb.sdk.threads.list({ archived, includeHidden: true, limit: 200, offset: page * 200, signal });
          for (const thread of threads) {
            if (signal.aborted || stopped) return;
            if (thread.updatedAt >= lastRun) await scan(thread);
          }
          if (threads.length < 200) { complete = true; break; }
        }
        if (!complete) {
          bb.log.warn("Catch-up reached its 20,000-thread bound; last_run_at remains unchanged.");
          return;
        }
      }
      if (!signal.aborted && !stopped) store.setMeta("last_run_at", String(started));
    },
  });
  bb.background.schedule("rollup", "15 3 * * *", async () => {
    store.rollup((await settings.get()).retentionDays);
    bb.rpc.experimental_invalidate([TOTALS_TAG]);
  });
  bb.rpc.register(usageRpcContract, {
    getThreadUsage: ({ threadId }) => store.getThreadUsage(threadId),
    getDailyUsage: ({ days }) => store.getDailyUsage(days),
    // Same defaults and shape as `bb thread-usage threads --json`.
    getThreads: async ({ since, project, limit }) => {
      const { retentionDays } = await settings.get();
      return store.getThreads(since ?? hourStart(store.now() - retentionDays * DAY), retentionDays, project, limit);
    },
  });
  bb.cli.register({
    name: "thread-usage", summary: "Token totals per thread, hour, and day",
    commands: [
      { name: "thread", summary: "Tracked totals for a thread", usage: "bb thread-usage thread <id> [--json]" },
      { name: "threads", summary: "Top threads inside retention", usage: "bb thread-usage threads [--since <ISO|YYYY-MM-DD>] [--project <id>] [--limit <n>] [--json]" },
      { name: "days", summary: "Daily totals by model", usage: "bb thread-usage days [--days <n>] [--json]" },
      { name: "hours", summary: "Hourly totals inside retention", usage: "bb thread-usage hours [--since <ISO|YYYY-MM-DD>] [--json]" },
    ],
    async run(argv) { return runCli(store, argv, (await settings.get()).retentionDays); },
  });
  bb.onDispose(async () => {
    stopped = true;
    controller.abort();
    await queue.drain();
  });
}
