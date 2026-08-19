import assert from "node:assert/strict";
import test from "node:test";
import {
  FIVE_HOUR_MS,
  formatPace,
  windowPace,
  worstPaceStatus,
  WEEK_MS,
  type WindowPace,
} from "../lib/pace.ts";
import {
  providerPaceStatus,
  sidebarWindowPaces,
} from "../lib/sidebar-usage.ts";
import type { ProviderUsage, UsageWindow } from "../lib/usage.ts";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

function usageWindow(
  label: string,
  usedPercent: number,
  resetsAt: string | null,
): UsageWindow {
  return {
    label,
    usedPercent,
    barPercent: Math.min(100, Math.max(0, usedPercent)),
    resetsAt,
    cost: null,
  };
}

function resetIn(ms: number): string {
  return new Date(NOW.getTime() + ms).toISOString();
}

function pace(overrides: Partial<WindowPace> = {}): WindowPace {
  return {
    status: "on_track",
    elapsedPercent: 50,
    projectedPercent: 72,
    runsOutAt: null,
    reason: null,
    ...overrides,
  };
}

test("projects an on-track window at half of its five-hour span", () => {
  const result = windowPace(
    usageWindow("Five-hour limit", 36, resetIn(2.5 * HOUR_MS)),
    FIVE_HOUR_MS,
    NOW,
  );

  assert.equal(result.status, "on_track");
  assert.equal(result.elapsedPercent, 50);
  assert.equal(result.projectedPercent, 72);
  assert.equal(result.runsOutAt, null);
  assert.equal(formatPace(result, "en-US"), "On track · ~72% at reset");
});

test("flags a watch window at the 85 percent projection threshold", () => {
  const result = windowPace(
    usageWindow("Weekly limit", 45, resetIn(3.5 * 24 * HOUR_MS)),
    WEEK_MS,
    NOW,
  );

  assert.equal(result.status, "watch");
  assert.equal(result.projectedPercent, 90);
  assert.equal(formatPace(result, "en-US"), "Watch · ~90% at reset");
});

test("flags an at-risk window and reports when it runs out", () => {
  const result = windowPace(
    usageWindow("Five-hour limit", 50, resetIn(3.75 * HOUR_MS)),
    FIVE_HOUR_MS,
    NOW,
  );

  assert.equal(result.status, "at_risk");
  assert.equal(result.elapsedPercent, 25);
  assert.equal(result.projectedPercent, 200);
  // Half the limit in a quarter of the window runs out a quarter later.
  assert.equal(result.runsOutAt, "2026-08-19T13:15:00.000Z");

  const runsOut = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(result.runsOutAt!));
  assert.equal(
    formatPace(result, "en-US"),
    `At risk · ~200% at reset · runs out ${runsOut}`,
  );
});

test("reports a used-up window as at risk that runs out now", () => {
  const result = windowPace(
    usageWindow("Five-hour limit", 120, resetIn(2.5 * HOUR_MS)),
    FIVE_HOUR_MS,
    NOW,
  );

  assert.equal(result.status, "at_risk");
  assert.equal(result.runsOutAt, NOW.toISOString());
});

test("waits for enough elapsed time before it reports a pace", () => {
  const result = windowPace(
    usageWindow("Five-hour limit", 4, resetIn(4.9 * HOUR_MS)),
    FIVE_HOUR_MS,
    NOW,
  );

  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "too_early");
  assert.equal(formatPace(result, "en-US"), "Too early to tell");
});

test("reports no pace without a usable reset time", () => {
  const missing = windowPace(usageWindow("Fable", 40, null), WEEK_MS, NOW);
  const invalid = windowPace(
    usageWindow("Fable", 40, "not-a-date"),
    WEEK_MS,
    NOW,
  );
  const past = windowPace(
    usageWindow("Fable", 40, resetIn(-HOUR_MS)),
    WEEK_MS,
    NOW,
  );

  for (const result of [missing, invalid, past]) {
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "unavailable");
    assert.equal(result.runsOutAt, null);
    assert.equal(formatPace(result, "en-US"), "Pace unavailable");
  }
});

test("ranks pace statuses from at risk down to unknown", () => {
  assert.equal(worstPaceStatus([]), "unknown");
  assert.equal(
    worstPaceStatus([pace({ status: "unknown" }), pace({ status: "on_track" })]),
    "on_track",
  );
  assert.equal(
    worstPaceStatus([pace({ status: "on_track" }), pace({ status: "watch" })]),
    "watch",
  );
  assert.equal(
    worstPaceStatus([pace({ status: "at_risk" }), pace({ status: "watch" })]),
    "at_risk",
  );
});

test("formats every pace state", () => {
  assert.equal(
    formatPace(pace({ status: "at_risk", projectedPercent: 129.6 }), "en-US"),
    "At risk · ~130% at reset",
  );
  assert.equal(
    formatPace(pace({ status: "unknown", reason: "unavailable" }), "en-US"),
    "Pace unavailable",
  );
});

function claudeProvider(): ProviderUsage {
  return {
    id: "claudeCode",
    name: "Claude Code",
    status: "ok",
    accountEmail: null,
    planLabel: null,
    message: null,
    windows: [
      usageWindow("Five-hour limit", 50, resetIn(2.5 * HOUR_MS)),
      usageWindow("Weekly limit", 20, resetIn(3.5 * 24 * HOUR_MS)),
      usageWindow("Fable", 50, resetIn(3.5 * 24 * HOUR_MS)),
    ],
  };
}

test("paces the five-hour window over 5 hours and other windows over 7 days", () => {
  const paces = sidebarWindowPaces(claudeProvider(), NOW);

  assert.equal(paces.fiveHour?.pace.elapsedPercent, 50);
  assert.equal(paces.fiveHour?.pace.projectedPercent, 100);
  assert.equal(paces.weekly?.pace.elapsedPercent, 50);
  assert.equal(paces.weekly?.pace.projectedPercent, 40);
  assert.equal(paces.extras.length, 1);
  assert.equal(paces.extras[0]?.window.label, "Fable");
  // A 3.5-day remainder only reads as half elapsed on a 7-day window.
  assert.equal(paces.extras[0]?.pace.elapsedPercent, 50);
  assert.equal(paces.extras[0]?.pace.projectedPercent, 100);
});

test("reports the worst window pace for the provider strip", () => {
  assert.equal(providerPaceStatus(claudeProvider(), NOW), "at_risk");

  const calm: ProviderUsage = {
    ...claudeProvider(),
    windows: [usageWindow("Weekly limit", 20, resetIn(3.5 * 24 * HOUR_MS))],
  };
  assert.equal(providerPaceStatus(calm, NOW), "on_track");

  const empty: ProviderUsage = { ...claudeProvider(), windows: [] };
  assert.equal(providerPaceStatus(empty, NOW), "unknown");
});

test("windowPace flags a used-up window as at risk even when too early", () => {
  const now = new Date("2026-08-19T12:00:00.000Z");
  const pace = windowPace(
    {
      label: "Five-hour limit",
      usedPercent: 100,
      barPercent: 100,
      resetsAt: new Date(now.getTime() + FIVE_HOUR_MS - 60_000).toISOString(),
      cost: null,
    },
    FIVE_HOUR_MS,
    now,
  );
  assert.equal(pace.status, "at_risk");
  assert.equal(pace.runsOutAt, now.toISOString());
});
