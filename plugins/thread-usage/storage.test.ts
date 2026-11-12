import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { fields } from "./test-fixtures";
import { DAY, HOUR, localDay, migrations, UsageStore } from "./storage";
import { event, turn, thread, NOW } from "./test-fixtures";

const databases: Database.Database[] = [];
function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("auto_vacuum = INCREMENTAL");
  for (const sql of migrations) db.exec(sql);
  return new UsageStore(db, () => NOW);
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe("token accounting on real SQLite", () => {
  it("adds normal deltas for all seven counters and ignores repeated sequence numbers", () => {
    const store = fixture();
    store.apply(thread, event(1, 10));
    store.apply(thread, event(2, 15));
    store.apply(thread, event(2, 900));
    expect(store.cursor(thread.id)).toBe(2);
    for (const f of fields) expect(store.getThreadUsage(thread.id)?.totals[f]).toBe(15);
    expect(store.getDailyUsage(1).rows[0].totals.totalTokens).toBe(15);
  });
  it("counts the full total when providerThreadId changes", () => {
    const store = fixture();
    store.apply(thread, event(1, 10));
    store.apply(thread, event(2, 30, "session-b"));
    expect(store.getThreadUsage(thread.id)?.totals.totalTokens).toBe(40);
  });
  it("counts the full total when any counter decreases", () => {
    const store = fixture();
    store.apply(thread, event(1, 10));
    const reset = event(2, 20);
    reset.data.tokenUsage.total.inputTokens = 1;
    store.apply(thread, reset);
    expect(store.getThreadUsage(thread.id)?.totals).toMatchObject({ totalTokens: 30, inputTokens: 11 });
  });
  it("baselines an older thread once, then counts later deltas", () => {
    const store = fixture();
    const old = { ...thread, createdAt: NOW - DAY };
    store.apply(old, event(1, 100));
    expect(store.getThreadUsage(thread.id)).toMatchObject({ baseline: true, totals: { totalTokens: 0 } });
    expect(store.getDailyUsage(1).rows).toEqual([]);
    store.apply(old, event(2, 115));
    expect(store.getThreadUsage(thread.id)).toMatchObject({ baseline: true, totals: { totalTokens: 15 } });
    expect(new UsageStore(store.db, () => NOW + DAY).installedAt).toBe(NOW);
  });
  it("stores missing optional fields as zero", () => {
    const store = fixture();
    const e = event(1, 10);
    delete e.data.tokenUsage.total.cacheReadInputTokens;
    delete e.data.tokenUsage.total.cacheWriteInputTokens;
    store.apply(thread, e);
    expect(store.getThreadUsage(thread.id)?.totals).toMatchObject({ cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });
  });
  it("folds and deletes expired hourly rows exactly once", () => {
    const store = fixture();
    store.apply(thread, { ...event(1, 10), createdAt: NOW - 9 * DAY });
    store.apply(thread, { ...event(2, 16), createdAt: NOW - HOUR });
    store.rollup(7);
    store.rollup(7);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM hourly_usage").get()).toEqual({ n: 1 });
    expect(store.db.prepare("SELECT day, totalTokens FROM daily_usage").get()).toEqual({ day: localDay(NOW - 9 * DAY), totalTokens: 10 });
    expect(store.getDailyUsage(10).rows.reduce((n, r) => n + r.totals.totalTokens, 0)).toBe(16);
    expect(store.getThreadUsage(thread.id)?.totals.totalTokens).toBe(16);
  });
  it("folds deleted threads into daily totals and removes thread data", () => {
    const store = fixture();
    store.apply(thread, event(1, 10));
    store.deleteThread(thread.id);
    store.deleteThread(thread.id);
    expect(store.getThreadUsage(thread.id)).toBeNull();
    expect(store.getHours(NOW - DAY, 7).rows).toEqual([]);
    expect(store.getDailyUsage(1).rows[0].totals.totalTokens).toBe(10);
  });
  it("preserves project filters and retention warnings", () => {
    const store = fixture();
    store.apply(thread, event(1, 10));
    expect(store.getThreads(NOW - DAY, 7, "other").rows).toEqual([]);
    expect(store.getThreads(NOW - 30 * DAY, 7)).toMatchObject({ truncated: true, rows: [{ threadId: thread.id }] });
  });
});

it("keeps an existing model when turn metadata has no string model", () => {
  const store = fixture();
  store.applyTurn(thread, { seq: 1, data: {} });
  expect(store.getThreadUsage(thread.id)?.model).toBe("unknown");
  store.applyTurn(thread, turn(2, "model-a"));
  store.applyTurn(thread, { seq: 3, data: { execution: { model: null } } });
  store.applyTurn(thread, { seq: 4, data: {} });
  store.apply(thread, event(5, 10));
  expect(store.getThreadUsage(thread.id)).toMatchObject({ model: "model-a", totals: { totalTokens: 10 } });
  expect(store.cursor(thread.id)).toBe(5);
});

it("baselines first usage after earlier turn events for a pre-install thread", () => {
  const store = fixture();
  const old = { ...thread, createdAt: NOW - DAY };
  store.applyTurn(old, turn(1, "model-a"));
  store.applyTurn(old, turn(2, "model-b"));
  store.apply(old, event(3, 100));
  expect(store.getThreadUsage(thread.id)).toMatchObject({ baseline: true, model: "model-b", totals: { totalTokens: 0 } });
  store.apply(old, event(4, 115));
  expect(store.getThreadUsage(thread.id)?.totals.totalTokens).toBe(15);
});
