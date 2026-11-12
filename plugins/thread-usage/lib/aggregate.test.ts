import { describe, expect, it } from "vitest";
import type { DailyUsage, ThreadsUsage, Totals } from "../contract";
import { OTHER, dailySeries, topThreads } from "./aggregate";

const totals = (totalTokens: number): Totals => ({
  totalTokens, inputTokens: 0, cachedInputTokens: 0, cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
});
const day = (d: string, model: string, n: number, projectId = "proj_a"): DailyUsage["rows"][number] =>
  ({ day: d, projectId, model, totals: totals(n) });

describe("dailySeries", () => {
  it("keeps empty days, sums projects, and orders days oldest first", () => {
    const s = dailySeries([day("2026-11-12", "a", 10), day("2026-11-12", "a", 5, "proj_b"), day("2026-11-10", "b", 3)], 3, "2026-11-12");
    expect(s.days.map((d) => [d.day, d.total])).toEqual([["2026-11-10", 3], ["2026-11-11", 0], ["2026-11-12", 15]]);
    expect(s.models).toEqual([{ model: "a", total: 15 }, { model: "b", total: 3 }]);
    expect(s.total).toBe(18);
    expect(s.max).toBe(15);
  });

  it("drops rows outside the range and crosses month ends", () => {
    const s = dailySeries([day("2026-10-31", "a", 4), day("2026-10-30", "a", 99)], 2, "2026-11-01");
    expect(s.days.map((d) => d.day)).toEqual(["2026-10-31", "2026-11-01"]);
    expect(s.total).toBe(4);
  });

  it("moves the end forward when the server day is ahead of the viewer", () => {
    const s = dailySeries([day("2026-11-13", "a", 1)], 2, "2026-11-12");
    expect(s.days.map((d) => d.day)).toEqual(["2026-11-12", "2026-11-13"]);
  });

  it("folds models past the largest into Other, listed last", () => {
    const rows = [day("2026-11-12", "a", 50), day("2026-11-12", "b", 40), day("2026-11-12", "c", 30),
      day("2026-11-12", "d", 20), day("2026-11-12", "e", 10)];
    const s = dailySeries(rows, 1, "2026-11-12", 4);
    expect(s.models).toEqual([{ model: "a", total: 50 }, { model: "b", total: 40 }, { model: "c", total: 30 }, { model: OTHER, total: 30 }]);
    expect(s.days[0].models.at(-1)).toEqual({ model: OTHER, total: 30 });
  });

  it("keeps up to the series count without an Other entry", () => {
    const rows = ["a", "b", "c", "d"].map((m, i) => day("2026-11-12", m, 10 - i));
    expect(dailySeries(rows, 1, "2026-11-12", 4).models.map((m) => m.model)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("topThreads", () => {
  const row = (threadId: string, model: string, n: number, title: string | null = threadId): ThreadsUsage["rows"][number] =>
    ({ threadId, projectId: "proj_a", model, title, totals: totals(n) });

  it("merges models per thread and ranks by the merged total", () => {
    const top = topThreads([row("t1", "a", 50), row("t2", "a", 40), row("t2", "b", 30), row("t3", "a", 0)], 10);
    expect(top.map((t) => [t.threadId, t.total])).toEqual([["t2", 70], ["t1", 50]]);
    expect(top[0].models).toEqual([{ model: "a", total: 40 }, { model: "b", total: 30 }]);
  });

  it("limits the list and keeps a title from any row", () => {
    const top = topThreads([row("t1", "a", 5, null), row("t1", "b", 4, "Named"), row("t2", "a", 3)], 1);
    expect(top).toHaveLength(1);
    expect(top[0].title).toBe("Named");
  });
});
