import assert from "node:assert/strict";
import test from "node:test";
import {
  loadUsageSnapshot,
  resolveThreadHostId,
  type UsageSdk,
} from "../lib/load-usage.ts";
import {
  clampPercent,
  formatCost,
  formatFetchedAt,
  formatResetTime,
  formatUsedPercent,
  normalizeUsage,
  providerStatusLabel,
  type RawUsageResponse,
} from "../lib/usage.ts";
import {
  extraSidebarWindows,
  mergeLastKnownWindows,
  sidebarUsagePrimarySummary,
  sidebarUsageSummary,
  sidebarUsageWindows,
} from "../lib/sidebar-usage.ts";
import { enabledSidebarProviderIds } from "../lib/preferences.ts";

function healthyResponse(): RawUsageResponse {
  return {
    codex: {
      status: "ok",
      accountEmail: "mateo@example.com",
      planLabel: "Pro",
      windows: [
        {
          label: "Weekly limit",
          usedPercent: 17.25,
          resetsAt: "2026-08-17T00:44:00.000Z",
          cost: { usedUsdCents: 125, limitUsdCents: 500 },
        },
      ],
    },
    "claude-code": {
      status: "ok",
      accountEmail: "mateo@example.com",
      planLabel: "Max (20x)",
      windows: [
        {
          label: "Current session",
          usedPercent: 5,
          resetsAt: "2026-08-17T10:00:00.000Z",
        },
        {
          label: "Weekly limit",
          usedPercent: 68,
          resetsAt: "2026-08-20T17:00:00.000Z",
        },
        {
          label: "Fable",
          usedPercent: 79,
          resetsAt: "2026-08-20T17:00:00.000Z",
        },
      ],
    },
    "acp-cursor": { status: "unauthenticated" },
  };
}

function makeSdk(overrides: Partial<UsageSdk> = {}): UsageSdk {
  return {
    threads: {
      async get() {
        return { environmentId: "env_1" };
      },
    },
    environments: {
      async get() {
        return { hostId: "host_1" };
      },
    },
    hosts: {
      async get() {
        return { name: "Mateo's MacBook" };
      },
    },
    system: {
      async usageLimits() {
        return healthyResponse();
      },
    },
    ...overrides,
  };
}

test("enables sidebar providers independently in display order", () => {
  assert.deepEqual(
    enabledSidebarProviderIds({ enableClaudeCode: true, enableCodex: true }),
    ["claudeCode", "codex"],
  );
  assert.deepEqual(
    enabledSidebarProviderIds({ enableClaudeCode: true, enableCodex: false }),
    ["claudeCode"],
  );
  assert.deepEqual(
    enabledSidebarProviderIds({ enableClaudeCode: false, enableCodex: true }),
    ["codex"],
  );
  assert.deepEqual(
    enabledSidebarProviderIds({ enableClaudeCode: false, enableCodex: false }),
    [],
  );
});

test("normalizes providers in stable order with every usage window", () => {
  const snapshot = normalizeUsage(
    healthyResponse(),
    { id: "host_1", name: "Mateo's MacBook" },
    new Date("2026-08-11T17:00:00.000Z"),
  );

  assert.equal(snapshot.fetchedAt, "2026-08-11T17:00:00.000Z");
  assert.deepEqual(
    snapshot.providers.map((provider) => provider.id),
    ["codex", "claudeCode", "cursor"],
  );
  assert.equal(snapshot.providers[0]?.windows.length, 1);
  assert.equal(snapshot.providers[0]?.windows[0]?.barPercent, 17.25);
  assert.deepEqual(snapshot.providers[0]?.windows[0]?.cost, {
    usedUsdCents: 125,
    limitUsdCents: 500,
  });
  assert.equal(snapshot.providers[1]?.status, "ok");
  assert.deepEqual(
    snapshot.providers[1]?.windows.map((window) => window.label),
    ["Current session", "Weekly limit", "Fable"],
  );
  assert.equal(snapshot.providers[2]?.status, "unauthenticated");
  assert.match(snapshot.providers[2]?.message ?? "", /cursor-agent login/);
});

test("normalizes not-installed and provider-error states", () => {
  const response: RawUsageResponse = {
    codex: { status: "not_installed" },
    claudeCode: {
      status: "error",
      message: "Provider timed out",
      planLabel: "Max",
      accountEmail: "account@example.com",
    },
    cursor: { status: "expired" },
  };

  const snapshot = normalizeUsage(response, { id: null, name: null });
  assert.equal(snapshot.providers[0]?.message, "Codex is not installed on this machine.");
  assert.deepEqual(snapshot.providers[1], {
    id: "claudeCode",
    name: "Claude Code",
    status: "error",
    accountEmail: "account@example.com",
    planLabel: "Max",
    message: "Provider timed out",
    windows: [],
    resetCreditsAvailable: null,
  });
  assert.equal(providerStatusLabel("not_installed"), "Not installed");
  assert.equal(providerStatusLabel("error"), "Unavailable");
});

test("normalizes providers omitted by the live usage response", () => {
  const response: RawUsageResponse = {
    codex: healthyResponse().codex,
  };

  const snapshot = normalizeUsage(response, { id: null, name: null });

  assert.equal(snapshot.providers[0]?.status, "ok");
  assert.equal(snapshot.providers[1]?.status, "not_installed");
  assert.equal(snapshot.providers[2]?.status, "not_installed");
});

test("preserves current Claude throttle errors", () => {
  const message =
    "Anthropic temporarily throttled this usage check. Try again later.";
  const snapshot = normalizeUsage(
    { "claude-code": { status: "error", message } },
    { id: null, name: null },
  );

  assert.equal(snapshot.providers[1]?.status, "error");
  assert.equal(snapshot.providers[1]?.message, message);
});

test("normalizes the Codex reset-credit count", () => {
  const snapshot = normalizeUsage(
    healthyResponse(),
    { id: null, name: null },
    new Date("2026-08-11T17:00:00.000Z"),
    2,
  );

  assert.equal(snapshot.providers[0]?.resetCreditsAvailable, 2);
  assert.equal(snapshot.providers[1]?.resetCreditsAvailable, null);
});

test("clamps progress geometry and rejects non-finite values", () => {
  assert.equal(clampPercent(-3), 0);
  assert.equal(clampPercent(45.5), 45.5);
  assert.equal(clampPercent(140), 100);
  assert.throws(() => clampPercent(Number.NaN), /finite/);

  const response = healthyResponse();
  const codex = response.codex;
  if (codex?.status !== "ok") assert.fail("codex fixture must be healthy");
  codex.windows[0]!.usedPercent = Number.POSITIVE_INFINITY;
  assert.throws(
    () => normalizeUsage(response, { id: null, name: null }),
    /finite/,
  );
});

test("formats reset, update, percentage, and cost copy safely", () => {
  assert.equal(formatResetTime(null), "Reset unavailable");
  assert.equal(formatResetTime("not-a-date"), "Reset unavailable");
  assert.match(
    formatResetTime("2026-08-17T00:44:00.000Z", "en-US"),
    /^Resets /,
  );
  assert.equal(formatFetchedAt("bad"), "Updated recently");
  assert.match(formatFetchedAt("2026-08-11T17:00:00.000Z", "en-US"), /^Updated /);
  assert.equal(formatUsedPercent(Number.NaN), "—");
  assert.equal(formatUsedPercent(17.25, "en-US"), "17.3");
  assert.equal(
    formatCost({ usedUsdCents: 125, limitUsdCents: 500 }, "en-US"),
    "$1.25 of $5.00",
  );
});

test("shows only the Codex weekly window in compact sidebar copy", () => {
  const provider = normalizeUsage(
    healthyResponse(),
    { id: null, name: null },
  ).providers[0]!;
  const windows = sidebarUsageWindows(provider);

  assert.equal(windows.session, null);
  assert.equal(windows.weekly?.label, "Weekly limit");
  assert.equal(sidebarUsageSummary(provider), "17.3% wk");
  assert.equal(sidebarUsagePrimarySummary(provider), "17.3%");
});

test("drops obsolete windows after success and keeps them through errors", () => {
  const previous = normalizeUsage(healthyResponse(), {
    id: null,
    name: null,
  }).providers[1]!;
  const partial = {
    ...previous,
    windows: previous.windows.filter((window) => window.label === "Weekly limit"),
  };
  const failed = { ...partial, status: "error" as const, message: "Rate limited" };

  assert.equal(
    sidebarUsageSummary(mergeLastKnownWindows(partial, previous)),
    "68% wk",
  );
  assert.equal(
    sidebarUsageSummary(mergeLastKnownWindows(failed, previous)),
    "5% session · 68% wk",
  );
  assert.equal(extraSidebarWindows(mergeLastKnownWindows(failed, previous))[0]?.label, "Fable");
});

test("resolves the thread environment host", async () => {
  const sdk = makeSdk();
  assert.equal(await resolveThreadHostId(sdk, "thr_1"), "host_1");
});

test("falls back when a thread has no environment or lookup fails", async () => {
  const noEnvironment = makeSdk({
    threads: {
      async get() {
        return { environmentId: null };
      },
    },
  });
  assert.equal(await resolveThreadHostId(noEnvironment, "thr_1"), null);

  const missingEnvironment = makeSdk({
    environments: {
      async get() {
        throw new Error("environment missing");
      },
    },
  });
  assert.equal(await resolveThreadHostId(missingEnvironment, "thr_1"), null);
});

test("loads usage for the resolved host and tolerates missing host metadata", async () => {
  const calls: Array<{ hostId?: string } | undefined> = [];
  const sdk = makeSdk({
    hosts: {
      async get() {
        throw new Error("host metadata unavailable");
      },
    },
    system: {
      async usageLimits(args) {
        calls.push(args);
        return healthyResponse();
      },
    },
  });

  const snapshot = await loadUsageSnapshot(
    sdk,
    "thr_1",
    new Date("2026-08-11T17:00:00.000Z"),
  );
  assert.deepEqual(calls, [{ hostId: "host_1" }]);
  assert.deepEqual(snapshot.host, { id: "host_1", name: null });
});

test("omits host override for primary-machine fallback", async () => {
  const calls: Array<{ hostId?: string } | undefined> = [];
  const sdk = makeSdk({
    threads: {
      async get() {
        return { environmentId: null };
      },
    },
    system: {
      async usageLimits(args) {
        calls.push(args);
        return healthyResponse();
      },
    },
  });

  const snapshot = await loadUsageSnapshot(sdk, "thr_1");
  assert.deepEqual(calls, [undefined]);
  assert.deepEqual(snapshot.host, { id: null, name: null });
});

test("loads the primary machine directly for the sidebar strip", async () => {
  const calls: Array<{ hostId?: string } | undefined> = [];
  const sdk = makeSdk({
    threads: {
      async get() {
        throw new Error("the primary-machine surface must not resolve a thread");
      },
    },
    system: {
      async usageLimits(args) {
        calls.push(args);
        return healthyResponse();
      },
    },
  });

  let resetLoads = 0;
  const snapshot = await loadUsageSnapshot(sdk, null, new Date(), async () => {
    resetLoads += 1;
    return 1;
  });
  assert.deepEqual(calls, [undefined]);
  assert.deepEqual(snapshot.host, { id: null, name: null });
  assert.equal(snapshot.providers[0]?.resetCreditsAvailable, 1);
  assert.equal(resetLoads, 1);
});

test("propagates thread and request-level usage failures", async () => {
  const threadFailure = makeSdk({
    threads: {
      async get() {
        throw new Error("thread missing");
      },
    },
  });
  await assert.rejects(() => loadUsageSnapshot(threadFailure, "thr_1"), /thread missing/);

  const usageFailure = makeSdk({
    system: {
      async usageLimits() {
        throw new Error("usage unavailable");
      },
    },
  });
  await assert.rejects(() => loadUsageSnapshot(usageFailure, "thr_1"), /usage unavailable/);
});

test("extraSidebarWindows returns model-scoped windows beyond session and weekly", () => {
  const provider = normalizeUsage(healthyResponse(), { id: null, name: null }).providers.find(
    (entry) => entry.id === "claudeCode",
  )!;
  assert.equal(extraSidebarWindows(provider)[0]?.label, "Fable");
});
