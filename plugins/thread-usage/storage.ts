import type Database from "better-sqlite3";
import { fields, type Totals, type ThreadUsage, type DailyUsage } from "./contract";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const hourStart = (time: number) => Math.floor(time / HOUR) * HOUR;
export function localDay(time: number): string {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export const zero = (): Totals => Object.fromEntries(fields.map((f) => [f, 0])) as Totals;
const columns = fields.join(", ");
const definitions = fields.map((f) => `${f} INTEGER NOT NULL DEFAULT 0`).join(", ");
export const migrations = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE thread_usage (
    thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, provider_id TEXT NOT NULL,
    model TEXT NOT NULL, title TEXT, provider_thread_id TEXT NOT NULL, last_seq INTEGER NOT NULL,
    ${fields.map((f) => `cursor_${f} INTEGER NOT NULL DEFAULT 0, counted_${f} INTEGER NOT NULL DEFAULT 0`).join(", ")},
    baseline INTEGER NOT NULL, first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
  )`,
  `CREATE TABLE hourly_usage (
    hour_start_utc INTEGER NOT NULL, thread_id TEXT NOT NULL, project_id TEXT NOT NULL,
    model TEXT NOT NULL, ${definitions}, PRIMARY KEY (hour_start_utc, thread_id, model)
  )`,
  `CREATE TABLE daily_usage (
    day TEXT NOT NULL, project_id TEXT NOT NULL, model TEXT NOT NULL, ${definitions},
    PRIMARY KEY (day, project_id, model)
  )`,
  `CREATE INDEX hourly_usage_thread ON hourly_usage (thread_id, hour_start_utc)`,
];
export interface ThreadInfo {
  id: string; projectId: string; providerId: string; title: string | null;
  createdAt: number; updatedAt: number; archivedAt: number | null;
}
export interface UsageEvent {
  seq: number; createdAt: number;
  data: { providerThreadId: string; tokenUsage: { total: Partial<Totals> } };
}
type Row = Record<string, string | number | null>;
function totals(row: Row, prefix = ""): Totals {
  return Object.fromEntries(fields.map((f) => [f, Number(row[`${prefix}${f}`] ?? 0)])) as Totals;
}
function add(a: Totals, b: Totals) { for (const f of fields) a[f] += b[f]; }
const increments = fields.map((f) => `${f} = ${f} + excluded.${f}`).join(", ");
const values = (t: Totals) => fields.map((f) => t[f]);

export class UsageStore {
  readonly installedAt: number;
  constructor(readonly db: Database.Database, readonly now = Date.now) {
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('installed_at', ?)").run(String(now()));
    this.installedAt = Number(this.getMeta("installed_at"));
  }
  getMeta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }
  setMeta(key: string, value: string) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
  cursor(id: string): number {
    return Number((this.db.prepare("SELECT last_seq FROM thread_usage WHERE thread_id = ?").get(id) as Row | undefined)?.last_seq ?? 0);
  }
  apply(thread: ThreadInfo, event: UsageEvent) {
    this.db.transaction(() => {
      const old = this.db.prepare("SELECT * FROM thread_usage WHERE thread_id = ?").get(thread.id) as Row | undefined;
      if (old && event.seq <= Number(old.last_seq)) return;
      const total = Object.fromEntries(fields.map((f) => [f, event.data.tokenUsage.total[f] ?? 0])) as Totals;
      const baseline = !old && thread.createdAt < this.installedAt;
      const previous = old ? totals(old, "cursor_") : zero();
      const sameSession = old?.provider_thread_id === event.data.providerThreadId && fields.every((f) => total[f] >= previous[f]);
      const delta = Object.fromEntries(fields.map((f) => [f, baseline ? 0 : total[f] - (sameSession ? previous[f] : 0)])) as Totals;
      const counted = old ? totals(old, "counted_") : zero();
      add(counted, delta);
      // ThreadResponse has no model field in bb 0.49.0.
      const model = "unknown";
      const names = ["thread_id", "project_id", "provider_id", "model", "title", "provider_thread_id", "last_seq",
        ...fields.map((f) => `cursor_${f}`), ...fields.map((f) => `counted_${f}`),
        "baseline", "first_seen_at", "updated_at", "archived_at"];
      const args = [thread.id, thread.projectId, thread.providerId, model, thread.title,
        event.data.providerThreadId, event.seq, ...values(total), ...values(counted),
        old?.baseline ?? Number(baseline), old?.first_seen_at ?? this.now(), this.now(), thread.archivedAt];
      this.db.prepare(`INSERT INTO thread_usage (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})
        ON CONFLICT(thread_id) DO UPDATE SET ${names.slice(1).map((n) => `${n} = excluded.${n}`).join(", ")}`).run(...args);
      if (fields.some((f) => delta[f] !== 0)) {
        this.db.prepare(`INSERT INTO hourly_usage (hour_start_utc, thread_id, project_id, model, ${columns})
          VALUES (?, ?, ?, ?, ${fields.map(() => "?").join(", ")})
          ON CONFLICT(hour_start_utc, thread_id, model) DO UPDATE SET ${increments}`)
          .run(hourStart(event.createdAt), thread.id, thread.projectId, model, ...values(delta));
      }
    })();
  }
  archive(id: string, at: number | null) {
    this.db.prepare("UPDATE thread_usage SET archived_at = ? WHERE thread_id = ?").run(at, id);
  }
  private fold(where: string, args: (number | string)[]) {
    this.db.prepare(`INSERT INTO daily_usage (day, project_id, model, ${columns})
      SELECT date(hour_start_utc / 1000, 'unixepoch', 'localtime'), project_id, model,
        ${fields.map((f) => `SUM(${f})`).join(", ")}
      FROM hourly_usage WHERE ${where}
      GROUP BY date(hour_start_utc / 1000, 'unixepoch', 'localtime'), project_id, model
      ON CONFLICT(day, project_id, model) DO UPDATE SET ${increments}`).run(...args);
    this.db.prepare(`DELETE FROM hourly_usage WHERE ${where}`).run(...args);
  }
  deleteThread(id: string) {
    this.db.transaction(() => {
      this.fold("thread_id = ?", [id]);
      this.db.prepare("DELETE FROM thread_usage WHERE thread_id = ?").run(id);
    })();
  }
  rollup(retentionDays: number) {
    this.db.transaction(() => this.fold("hour_start_utc < ?", [hourStart(this.now() - retentionDays * DAY)]))();
    this.db.pragma("incremental_vacuum");
  }
  getThreadUsage(id: string): ThreadUsage | null {
    const r = this.db.prepare("SELECT * FROM thread_usage WHERE thread_id = ?").get(id) as Row | undefined;
    return r ? {
      threadId: String(r.thread_id), projectId: String(r.project_id), providerId: String(r.provider_id),
      model: String(r.model), title: r.title as string | null, baseline: Boolean(r.baseline),
      firstSeenAt: Number(r.first_seen_at), updatedAt: Number(r.updated_at),
      archivedAt: r.archived_at === null ? null : Number(r.archived_at), totals: totals(r, "counted_"),
    } : null;
  }
  getDailyUsage(days: number): DailyUsage {
    const start = new Date(this.now());
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - days + 1);
    const from = localDay(start.getTime());
    const to = localDay(this.now());
    const grouped = new Map<string, DailyUsage["rows"][number]>();
    const rows = [
      ...this.db.prepare("SELECT * FROM daily_usage WHERE day >= ? AND day <= ?").all(from, to) as Row[],
      ...this.db.prepare("SELECT * FROM hourly_usage WHERE hour_start_utc >= ? AND hour_start_utc <= ?").all(start.getTime(), this.now()) as Row[],
    ];
    for (const r of rows) {
      const day = r.day === undefined ? localDay(Number(r.hour_start_utc)) : String(r.day);
      const key = JSON.stringify([day, r.project_id, r.model]);
      const group = grouped.get(key) ?? { day, projectId: String(r.project_id), model: String(r.model), totals: zero() };
      add(group.totals, totals(r));
      grouped.set(key, group);
    }
    return { days, rows: [...grouped.values()].sort((a, b) => a.day.localeCompare(b.day) || a.projectId.localeCompare(b.projectId) || a.model.localeCompare(b.model)) };
  }
  getThreads(since: number, retentionDays: number, project?: string, limit = 20) {
    const retentionStart = hourStart(this.now() - retentionDays * DAY);
    const rows = this.db.prepare(`SELECT h.thread_id, h.project_id, h.model, t.title,
      ${fields.map((f) => `SUM(h.${f}) AS ${f}`).join(", ")}
      FROM hourly_usage h LEFT JOIN thread_usage t ON t.thread_id = h.thread_id
      WHERE h.hour_start_utc >= ? ${project ? "AND h.project_id = ?" : ""}
      GROUP BY h.thread_id, h.project_id, h.model ORDER BY totalTokens DESC, h.thread_id, h.model LIMIT ?`)
      .all(...[Math.max(hourStart(since), retentionStart), ...(project ? [project] : []), limit]) as Row[];
    return { since, retentionStart, truncated: since < retentionStart,
      rows: rows.map((r) => ({ threadId: String(r.thread_id), projectId: String(r.project_id), model: String(r.model), title: r.title, totals: totals(r) })) };
  }
  getHours(since: number, retentionDays: number) {
    const retentionStart = hourStart(this.now() - retentionDays * DAY);
    const rows = this.db.prepare(`SELECT hour_start_utc, model, ${fields.map((f) => `SUM(${f}) AS ${f}`).join(", ")}
      FROM hourly_usage WHERE hour_start_utc >= ? GROUP BY hour_start_utc, model ORDER BY hour_start_utc, model`)
      .all(Math.max(hourStart(since), retentionStart)) as Row[];
    return { since, retentionStart, truncated: since < retentionStart,
      rows: rows.map((r) => ({ hourStartUtc: Number(r.hour_start_utc), model: String(r.model), totals: totals(r) })) };
  }
}
