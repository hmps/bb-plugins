// Shapes the RPC rows into what the usage page draws. Pure functions.
import type { DailyUsage, ThreadsUsage } from "../contract";
import { dayKey, parseDayKey } from "./format";

export interface ModelTotal { model: string; total: number }
export interface DayBar { day: string; total: number; models: ModelTotal[] }
export interface DailySeries {
  days: DayBar[];
  /** Series in legend order: the largest models, then "Other" when there are more. */
  models: ModelTotal[];
  total: number;
  max: number;
}

/** The label of the series that collects every model past the largest ones. */
export const OTHER = "Other";

/**
 * Sum `totalTokens` per day and model across projects for the `count` days that
 * end on `today`, oldest first, with empty days kept. The end moves forward when
 * the server's day is ahead of the viewer's. Models past the `series` largest
 * fold into {@link OTHER}.
 */
export function dailySeries(rows: DailyUsage["rows"], count: number, today: string, series = 4): DailySeries {
  const last = rows.reduce((end, r) => (r.day > end ? r.day : end), today);
  const end = parseDayKey(last);
  const keys = Array.from({ length: count }, (_, i) => {
    const d = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (count - 1 - i));
    return dayKey(d.getTime());
  });
  const inRange = new Set(keys);
  const byModel = new Map<string, number>();
  for (const r of rows) {
    if (inRange.has(r.day)) byModel.set(r.model, (byModel.get(r.model) ?? 0) + r.totals.totalTokens);
  }
  const ranked = sortTotals([...byModel].map(([model, total]) => ({ model, total }))).filter((m) => m.total > 0);
  const kept = new Set(ranked.slice(0, ranked.length > series ? series - 1 : series).map((m) => m.model));
  const label = (model: string) => (kept.has(model) ? model : OTHER);
  const models = fold(ranked.map((m) => ({ model: label(m.model), total: m.total })))
    .sort((a, b) => Number(a.model === OTHER) - Number(b.model === OTHER));
  const order = new Map(models.map((m, i) => [m.model, i]));
  const days = keys.map((day) => {
    const parts = fold(rows.filter((r) => r.day === day).map((r) => ({ model: label(r.model), total: r.totals.totalTokens })))
      .filter((m) => m.total > 0)
      .sort((a, b) => (order.get(a.model) ?? 0) - (order.get(b.model) ?? 0));
    return { day, total: parts.reduce((sum, m) => sum + m.total, 0), models: parts };
  });
  return {
    days, models,
    total: days.reduce((sum, d) => sum + d.total, 0),
    max: days.reduce((max, d) => Math.max(max, d.total), 0),
  };
}

export interface TopThread {
  threadId: string;
  projectId: string;
  title: string | null;
  total: number;
  /** Largest first. */
  models: ModelTotal[];
}

/**
 * Merge thread/model rows into one row per thread, largest total first.
 * The RPC ranks thread/model pairs, so ask it for more rows than `limit`.
 */
export function topThreads(rows: ThreadsUsage["rows"], limit: number): TopThread[] {
  const threads = new Map<string, TopThread>();
  for (const r of rows) {
    const t = threads.get(r.threadId) ?? { threadId: r.threadId, projectId: r.projectId, title: r.title, total: 0, models: [] };
    t.total += r.totals.totalTokens;
    t.title ??= r.title;
    t.models = fold([...t.models, { model: r.model, total: r.totals.totalTokens }]);
    threads.set(r.threadId, t);
  }
  return [...threads.values()]
    .filter((t) => t.total > 0)
    .sort((a, b) => b.total - a.total || a.threadId.localeCompare(b.threadId))
    .slice(0, limit);
}

/** Sum entries with the same model, largest first. */
function fold(items: ModelTotal[]): ModelTotal[] {
  const sums = new Map<string, number>();
  for (const { model, total } of items) sums.set(model, (sums.get(model) ?? 0) + total);
  return sortTotals([...sums].map(([model, total]) => ({ model, total })));
}

function sortTotals(items: ModelTotal[]): ModelTotal[] {
  return items.sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
}
