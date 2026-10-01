import { describe, expect, it } from "vitest";
import { changesUsage, formatTokens, readUsage, usagePercent, usageTone } from "./contextUsage";

const usage = (usedTokens: number, modelContextWindow: number, estimated = false) => ({
  usage: { usedTokens, modelContextWindow, estimated },
});

describe("readUsage", () => {
  it("returns null when the thread reports no usage or numbers that give no percent", () => {
    expect(readUsage(null)).toBeNull();
    expect(readUsage({ usage: null })).toBeNull();
    expect(readUsage(usage(10, 0))).toBeNull();
    expect(readUsage(usage(10, Number.NaN))).toBeNull();
    expect(readUsage(usage(Number.POSITIVE_INFINITY, 100))).toBeNull();
    expect(readUsage(usage(-1, 100))).toBeNull();
  });

  it("keeps a real zero and the estimated flag", () => {
    expect(readUsage(usage(0, 200_000, true))).toEqual({
      usedTokens: 0,
      modelContextWindow: 200_000,
      estimated: true,
    });
  });
});

describe("usagePercent and usageTone", () => {
  it("rounds like the bb indicator and clamps an overfull window to 100", () => {
    expect(usagePercent({ usedTokens: 84_999, modelContextWindow: 200_000, estimated: false })).toBe(42);
    expect(usagePercent({ usedTokens: 250_000, modelContextWindow: 200_000, estimated: false })).toBe(100);
  });

  it("warns from 75% and shows danger from 90%", () => {
    expect([74, 75, 89, 90].map(usageTone)).toEqual(["normal", "warning", "warning", "destructive"]);
  });

  it("formats token counts in compact form", () => {
    expect(formatTokens(84_999)).toBe("85k");
    expect(formatTokens(1_000_000)).toBe("1m");
  });
});

describe("changesUsage", () => {
  it("reads again only for events that can change the usage", () => {
    const appended = (...eventTypes: string[]) => ({
      changes: ["events-appended"],
      metadata: { eventTypes },
    });
    expect(changesUsage(appended("thread/contextWindowUsage/updated"))).toBe(true);
    expect(changesUsage(appended("item/agentMessage/delta", "turn/completed"))).toBe(true);
    expect(changesUsage(appended("item/agentMessage/delta"))).toBe(false);
    expect(changesUsage({ changes: ["events-appended"] })).toBe(false);
    expect(changesUsage({ changes: ["history-rewritten"] })).toBe(true);
    expect(changesUsage({ changes: ["title"] })).toBe(false);
  });
});
