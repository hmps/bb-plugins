import { describe, expect, it } from "vitest";
import { exactTitle, formatDay, formatExact, formatMoment, formatTimestamp, formatTokens } from "./format";

describe("formatTokens", () => {
  it.each([
    [0, "0"], [7, "7"], [999, "999"],
    [1000, "1k"], [1234, "1.2k"], [45_300, "45.3k"], [99_949, "99.9k"], [340_000, "340k"], [340_499, "340k"],
    [999_499, "999k"], [999_960, "1M"],
    [1_200_000, "1.2M"], [18_239_216, "18.2M"], [140_000_000, "140M"],
    [1_500_000_000, "1.5B"],
  ])("%d -> %s", (value, text) => {
    expect(formatTokens(value)).toBe(text);
  });

  it("rounds fractions and treats bad input as zero", () => {
    expect(formatTokens(12.6)).toBe("13");
    expect(formatTokens(Number.NaN)).toBe("0");
  });
});

describe("exact counts", () => {
  it("adds thousands separators", () => {
    expect(formatExact(18_239_216)).toBe("18,239,216");
    expect(formatExact(0)).toBe("0");
  });
  it("names the unit for hover text", () => {
    expect(exactTitle(1)).toBe("1 token");
    expect(exactTitle(1234)).toBe("1,234 tokens");
  });
});

describe("dates", () => {
  const now = new Date(2026, 10, 12, 9, 30).getTime();
  it("formats a day key with its weekday", () => {
    expect(formatDay("2026-11-12")).toBe("Thu 12 Nov");
    expect(formatDay("2026-11-01")).toBe("Sun 1 Nov");
  });
  it("shows only the clock for today", () => {
    expect(formatMoment(new Date(2026, 10, 12, 6, 53).getTime(), now)).toBe("06:53");
  });
  it("adds the date for earlier days and the year for earlier years", () => {
    expect(formatMoment(new Date(2026, 10, 11, 23, 5).getTime(), now)).toBe("11 Nov 23:05");
    expect(formatMoment(new Date(2025, 0, 2, 8, 0).getTime(), now)).toBe("2 Jan 2025 08:00");
  });
  it("gives a full timestamp for hover text", () => {
    expect(formatTimestamp(new Date(2026, 10, 12, 6, 53).getTime())).toBe("2026-11-12 06:53");
  });
});
