import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { HOUR, hourStart, localDay, migrations, UsageStore } from "./storage";
import { event, thread } from "./test-fixtures";

afterEach(() => vi.unstubAllEnvs());

it("keeps Kolkata midnight usage in the same day before and after rollup", () => {
  vi.stubEnv("TZ", "Asia/Kolkata");
  const at = Date.parse("2026-11-12T00:15:00+05:30");
  expect(new Date(at).getTimezoneOffset()).toBe(-330);
  const db = new Database(":memory:");
  try {
    for (const sql of migrations) db.exec(sql);
    let now = at - HOUR;
    const store = new UsageStore(db, () => now);
    now = at;
    store.apply({ ...thread, createdAt: at - 30 * 60_000 }, { ...event(1, 25), createdAt: at });
    expect(store.getDailyUsage(1).rows).toMatchObject([{ day: "2026-11-12", totals: { totalTokens: 25 } }]);
    expect(hourStart(at)).toBe(Date.parse("2026-11-12T00:00:00+05:30"));
    now = Date.parse("2026-11-15T12:00:00+05:30");
    store.rollup(1);
    expect(db.prepare("SELECT day, totalTokens FROM daily_usage").all()).toEqual([{ day: "2026-11-12", totalTokens: 25 }]);
    expect(store.getDailyUsage(4).rows).toMatchObject([{ day: "2026-11-12", totals: { totalTokens: 25 } }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM hourly_usage").get()).toEqual({ n: 0 });
  } finally { db.close(); }
});

it("preserves existing UTC bucket values for CET and CEST including repeated hours", () => {
  vi.stubEnv("TZ", "Europe/Stockholm");
  for (const stamp of ["2026-11-12T00:15:00+01:00", "2026-07-12T00:15:00+02:00", "2026-10-25T02:45:00+02:00", "2026-10-25T02:45:00+01:00"]) {
    const at = Date.parse(stamp);
    expect(hourStart(at)).toBe(Math.floor(at / HOUR) * HOUR);
    expect(localDay(hourStart(at))).toBe(localDay(at));
  }
});
