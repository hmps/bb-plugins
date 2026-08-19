import { describe, expect, it } from "vitest";
import { inHours, nextMondayMorning, snoozeChoices, tomorrowMorning } from "./snooze";

/** A Wednesday, 14:30 local time. */
const wednesday = new Date(2026, 7, 19, 14, 30, 0, 0).getTime();

describe("snooze times", () => {
  it("adds whole hours", () => {
    expect(inHours(wednesday, 3) - wednesday).toBe(3 * 3_600_000);
  });

  it("wakes tomorrow at 09:00 local time", () => {
    const at = new Date(tomorrowMorning(wednesday));
    expect(at.getDate()).toBe(20);
    expect(at.getHours()).toBe(9);
    expect(at.getMinutes()).toBe(0);
  });

  it("wakes on the coming Monday", () => {
    const at = new Date(nextMondayMorning(wednesday));
    expect(at.getDay()).toBe(1);
    expect(at.getDate()).toBe(24);
    expect(at.getHours()).toBe(9);
  });

  it("never picks today when today is Monday", () => {
    const monday = new Date(2026, 7, 24, 8, 0, 0, 0).getTime();
    const at = nextMondayMorning(monday);
    expect(new Date(at).getDate()).toBe(31);
    expect(at).toBeGreaterThan(monday);
  });

  it("offers four choices, all in the future", () => {
    const choices = snoozeChoices(wednesday);
    expect(choices).toHaveLength(4);
    for (const choice of choices) {
      expect(choice.snoozedUntil).toBeGreaterThan(wednesday);
    }
  });
});
