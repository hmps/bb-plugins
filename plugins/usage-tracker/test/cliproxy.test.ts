import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  CliproxyError,
  loadCliproxyCredentials,
  normalizeBaseUrl,
  parseAuthFiles,
  resetCliproxyState,
  toRawUsage,
} from "../lib/cliproxy.ts";

const NOW = new Date("2026-11-12T19:00:00Z");
const nowSeconds = NOW.getTime() / 1000;
const FUTURE = String(nowSeconds + 6 * 86_400);
const PAST = String(nowSeconds - 3_600);

function claudeSignals(utilization: string, reset: string) {
  return {
    "Anthropic-Ratelimit-Unified-7d-Utilization": utilization,
    "Anthropic-Ratelimit-Unified-7d-Reset": reset,
  };
}

function authFiles() {
  return {
    files: [
      {
        provider: "claude",
        account: "me@example.com",
        status: "active",
        success: 10,
        failed: 1,
        cooldowns: [],
        recent_requests: [{ time: "16:40-16:50", success: 5, failed: 0 }],
        quota: { signals: claudeSignals("0.01", FUTURE) },
        model_quotas: {
          "claude-opus-5-5": { signals: claudeSignals("0.01", FUTURE) },
          "claude-haiku-5-5": { signals: claudeSignals("0.0", FUTURE) },
          "claude-fable-5-2": {
            signals: claudeSignals("0.17", String(nowSeconds + 86_400)),
          },
          "claude-sonnet-5": { signals: claudeSignals("0.21", PAST) },
        },
      },
      {
        provider: "codex",
        account: "me@example.com",
        status: "active",
        id_token: { plan_type: "pro" },
        quota: {
          signals: {
            "X-Codex-Primary-Window-Minutes": "10080",
            "X-Codex-Primary-Used-Percent": "54",
            "X-Codex-Primary-Reset-At": FUTURE,
            "X-Codex-Secondary-Window-Minutes": "0",
            "X-Codex-Secondary-Used-Percent": "0",
          },
        },
      },
    ],
  };
}

beforeEach(() => resetCliproxyState());

test("normalizeBaseUrl accepts http(s) only and drops the path", () => {
  assert.equal(
    normalizeBaseUrl(" https://host.ts.net:8317/v0/x "),
    "https://host.ts.net:8317",
  );
  assert.equal(normalizeBaseUrl("ftp://host"), null);
  assert.equal(normalizeBaseUrl("nope"), null);
  assert.equal(normalizeBaseUrl(""), null);
});

test("parseAuthFiles maps Claude weekly and model windows, skips stale ones", () => {
  const [claude] = parseAuthFiles(authFiles(), NOW);
  assert.ok(claude);
  assert.deepEqual(
    claude.windows.map((window) => [window.label, window.usedPercent]),
    [
      ["Weekly limit", 1],
      ["Fable", 17],
    ],
  );
  assert.equal(claude.success, 10);
  assert.equal(claude.recent.length, 1);
});

test("parseAuthFiles maps Codex windows and plan", () => {
  const codex = parseAuthFiles(authFiles(), NOW)[1];
  assert.ok(codex);
  assert.equal(codex.planLabel, "Pro");
  assert.deepEqual(
    codex.windows.map((window) => [window.label, window.usedPercent]),
    [["Weekly limit", 54]],
  );
});

test("toRawUsage reports missing and disabled credentials as errors", () => {
  const credentials = parseAuthFiles(authFiles(), NOW);
  assert.equal(toRawUsage(credentials, "claude").status, "ok");
  assert.equal(toRawUsage([], "codex").status, "error");
  const disabled = credentials.map((credential) => ({
    ...credential,
    disabled: true,
  }));
  assert.equal(toRawUsage(disabled, "claude").status, "error");
});

test("parseAuthFiles rejects an unexpected body", () => {
  assert.throws(() => parseAuthFiles({ nope: 1 }, NOW), CliproxyError);
});

test("a rejected key blocks further calls for 30 minutes", async () => {
  let calls = 0;
  const config = { baseUrl: "https://p.example:8317", managementKey: "bad" };
  const fetchImpl = async () => {
    calls += 1;
    return { status: 401, text: async () => '{"error":"invalid management key"}' };
  };
  await assert.rejects(loadCliproxyCredentials(config, fetchImpl, NOW), CliproxyError);
  await assert.rejects(loadCliproxyCredentials(config, fetchImpl, NOW), CliproxyError);
  assert.equal(calls, 1);
  const later = new Date(NOW.getTime() + 31 * 60_000);
  await assert.rejects(loadCliproxyCredentials(config, fetchImpl, later), CliproxyError);
  assert.equal(calls, 2);
});

test("a good response is cached for a short time and never leaks the key", async () => {
  let calls = 0;
  const config = { baseUrl: "https://p.example:8317", managementKey: "secret-key" };
  const fetchImpl = async (
    _url: string,
    init: { headers: Record<string, string> },
  ) => {
    calls += 1;
    assert.equal(init.headers.authorization, "Bearer secret-key");
    return { status: 200, text: async () => JSON.stringify(authFiles()) };
  };
  const first = await loadCliproxyCredentials(config, fetchImpl, NOW);
  await loadCliproxyCredentials(config, fetchImpl, NOW);
  assert.equal(calls, 1);
  assert.equal(first.length, 2);
  assert.ok(!JSON.stringify(first).includes("secret-key"));
});

test("network failures become a friendly error", async () => {
  const config = { baseUrl: "https://p.example:8317", managementKey: "k" };
  await assert.rejects(
    loadCliproxyCredentials(
      config,
      async () => {
        throw new Error("ECONNREFUSED");
      },
      NOW,
    ),
    /unreachable/u,
  );
});

test("Fable shows as 0% with no reset when its window has passed", () => {
  const body = authFiles();
  const claude = body.files[0];
  assert.ok(claude?.model_quotas);
  claude.model_quotas["claude-fable-5-2"] = {
    signals: claudeSignals("0.17", PAST),
  };
  const [parsed] = parseAuthFiles(body, NOW);
  assert.deepEqual(
    parsed?.windows.map((window) => [window.label, window.usedPercent, window.resetsAt]),
    [
      ["Weekly limit", 1, new Date(Number(FUTURE) * 1000).toISOString()],
      ["Fable", 0, null],
    ],
  );
});
