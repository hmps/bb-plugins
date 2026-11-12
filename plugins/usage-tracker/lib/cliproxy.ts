import type { RawProviderUsage, RawUsageWindow } from "./usage.ts";

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 20_000;
/** After a rejected key, wait this long. The proxy bans IPs that fail repeatedly. */
export const REJECTED_KEY_BACKOFF_MS = 30 * 60_000;

export type CliproxyProvider = "claude" | "codex";

export interface CliproxyRequestBucket {
  time: string;
  success: number;
  failed: number;
}

export interface CliproxyCredential {
  provider: string;
  account: string;
  status: string;
  statusMessage: string;
  disabled: boolean;
  planLabel: string | null;
  success: number | null;
  failed: number | null;
  cooldowns: number;
  recent: CliproxyRequestBucket[];
  windows: RawUsageWindow[];
}

export interface CliproxyConfig {
  baseUrl: string;
  managementKey: string;
}

export class CliproxyError extends Error {}

/** Return a normalized base URL, or null when the value is not http(s). */
export function normalizeBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function epochToIso(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

function isFuture(seconds: number | null, now: Date): boolean {
  return seconds !== null && seconds * 1000 > now.getTime();
}

function modelLabel(modelId: string): string {
  const parts = modelId.replace(/^claude-/u, "").split("-");
  const family = parts[0] ?? modelId;
  if (family === "fable") return "Fable";
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  const version = parts.slice(1).join(".");
  return version === "" ? name : `${name} ${version}`;
}

interface ClaudeWindowReading {
  usedPercent: number;
  reset: number;
}

function claudeWeekly(
  signals: Record<string, unknown> | null,
  now: Date,
): ClaudeWindowReading | null {
  const utilization = num(signals?.["Anthropic-Ratelimit-Unified-7d-Utilization"]);
  const reset = num(signals?.["Anthropic-Ratelimit-Unified-7d-Reset"]);
  // A reset time in the past means the reading is from the previous window.
  if (utilization === null || reset === null || !isFuture(reset, now)) {
    return null;
  }
  return { usedPercent: utilization * 100, reset };
}

function claudeFiveHour(
  signals: Record<string, unknown> | null,
  now: Date,
): ClaudeWindowReading | null {
  const utilization = num(signals?.["Anthropic-Ratelimit-Unified-5h-Utilization"]);
  const reset = num(signals?.["Anthropic-Ratelimit-Unified-5h-Reset"]);
  if (utilization === null || reset === null || !isFuture(reset, now)) {
    return null;
  }
  return { usedPercent: utilization * 100, reset };
}

function claudeWindows(
  file: Record<string, unknown>,
  now: Date,
): RawUsageWindow[] {
  const signals = record(record(file.quota)?.signals);
  const windows: RawUsageWindow[] = [];
  const fiveHour = claudeFiveHour(signals, now);
  if (fiveHour !== null) {
    windows.push({
      label: "5-hour limit",
      usedPercent: fiveHour.usedPercent,
      resetsAt: epochToIso(fiveHour.reset),
    });
  }
  const weekly = claudeWeekly(signals, now);
  if (weekly !== null) {
    windows.push({
      label: "Weekly limit",
      usedPercent: weekly.usedPercent,
      resetsAt: epochToIso(weekly.reset),
    });
  }

  // Model-scoped quotas show as extra rows when they have their own window.
  const seen = new Set(windows.map((window) => window.label));
  const models = record(file.model_quotas) ?? {};
  for (const [modelId, entry] of Object.entries(models)) {
    const signals = record(record(entry)?.signals);
    const reading = claudeWeekly(signals, now);
    if (reading === null) {
      // Fable always shows. A reset time in the past means the window has
      // reset since the last reading, so usage starts again at 0%.
      const label = modelLabel(modelId);
      if (label === "Fable" && !seen.has(label) && signals !== null) {
        seen.add(label);
        windows.push({ label, usedPercent: 0, resetsAt: null });
      }
      continue;
    }
    // The same reset time means the shared weekly pool. Readings from other
    // models in that pool differ only by when they were observed.
    if (weekly !== null && reading.reset === weekly.reset) continue;
    const label = modelLabel(modelId);
    if (seen.has(label)) continue;
    seen.add(label);
    windows.push({
      label,
      usedPercent: reading.usedPercent,
      resetsAt: epochToIso(reading.reset),
    });
  }
  return windows;
}

function codexWindowLabel(minutes: number): string {
  if (minutes === 10_080) return "Weekly limit";
  if (minutes === 300) return "5-hour limit";
  if (minutes === 1_440) return "Daily limit";
  return `${minutes}-minute limit`;
}

function codexWindows(
  file: Record<string, unknown>,
  now: Date,
): RawUsageWindow[] {
  const signals = record(record(file.quota)?.signals);
  const windows: RawUsageWindow[] = [];
  for (const slot of ["Primary", "Secondary"] as const) {
    const minutes = num(signals?.[`X-Codex-${slot}-Window-Minutes`]);
    const used = num(signals?.[`X-Codex-${slot}-Used-Percent`]);
    const resetAt = num(signals?.[`X-Codex-${slot}-Reset-At`]);
    if (minutes === null || minutes <= 0 || used === null) continue;
    if (resetAt !== null && !isFuture(resetAt, now)) continue;
    windows.push({
      label: codexWindowLabel(minutes),
      usedPercent: used,
      resetsAt: epochToIso(resetAt),
    });
  }
  return windows;
}

function planLabel(file: Record<string, unknown>): string | null {
  const plan = str(record(file.id_token)?.plan_type);
  return plan === "" ? null : plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** Read the `files` list of `GET /v0/management/auth-files`. */
export function parseAuthFiles(
  body: unknown,
  now: Date = new Date(),
): CliproxyCredential[] {
  const files = record(body)?.files;
  if (!Array.isArray(files)) {
    throw new CliproxyError("CLIProxyAPI returned an unexpected auth-files response.");
  }
  return files.flatMap((raw): CliproxyCredential[] => {
    const file = record(raw);
    if (file === null) return [];
    const provider = str(file.provider);
    const recent = Array.isArray(file.recent_requests)
      ? file.recent_requests.flatMap((bucket): CliproxyRequestBucket[] => {
          const entry = record(bucket);
          const success = num(entry?.success);
          const failed = num(entry?.failed);
          return entry === null || success === null || failed === null
            ? []
            : [{ time: str(entry.time), success, failed }];
        })
      : [];
    return [
      {
        provider,
        account:
          str(file.account) || str(file.email) || str(file.label) || str(file.name),
        status: str(file.status),
        statusMessage: str(file.status_message),
        disabled: file.disabled === true,
        planLabel: planLabel(file),
        success: num(file.success),
        failed: num(file.failed),
        cooldowns: Array.isArray(file.cooldowns) ? file.cooldowns.length : 0,
        recent,
        windows:
          provider === "claude"
            ? claudeWindows(file, now)
            : provider === "codex"
              ? codexWindows(file, now)
              : [],
      },
    ];
  });
}

/** Map the first usable credential of a provider to BB's raw usage shape. */
export function toRawUsage(
  credentials: readonly CliproxyCredential[],
  provider: CliproxyProvider,
): RawProviderUsage {
  const matching = credentials.filter((credential) => credential.provider === provider);
  const credential = matching.find((candidate) => !candidate.disabled);
  if (credential === undefined) {
    return {
      status: "error",
      message:
        matching.length === 0
          ? "CLIProxyAPI has no credential for this provider."
          : "The CLIProxyAPI credential for this provider is disabled.",
    };
  }
  if (credential.status !== "" && credential.status !== "active") {
    return {
      status: "error",
      message:
        credential.statusMessage ||
        `The CLIProxyAPI credential is ${credential.status}.`,
      accountEmail: credential.account || null,
      planLabel: credential.planLabel,
    };
  }
  return {
    status: "ok",
    accountEmail: credential.account || null,
    planLabel: credential.planLabel,
    windows: credential.windows,
  };
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

interface CacheEntry {
  at: number;
  credentials: CliproxyCredential[];
}

const cache = new Map<string, CacheEntry>();
const rejectedUntil = new Map<string, number>();

function cacheKey(config: CliproxyConfig): string {
  return `${config.baseUrl}\u0000${config.managementKey}`;
}

/** Clear module state. Tests use this. */
export function resetCliproxyState(): void {
  cache.clear();
  rejectedUntil.clear();
}

/**
 * Fetch the credentials. A rejected key blocks further calls for 30 minutes,
 * because repeated failed logins ban the caller's IP on the proxy.
 */
export async function loadCliproxyCredentials(
  config: CliproxyConfig,
  fetchImpl: FetchLike = fetch,
  now: Date = new Date(),
): Promise<CliproxyCredential[]> {
  const key = cacheKey(config);
  const blockedUntil = rejectedUntil.get(key);
  if (blockedUntil !== undefined && blockedUntil > now.getTime()) {
    throw new CliproxyError(
      "CLIProxyAPI rejected the management key. Fix the key in the plugin settings.",
    );
  }
  const cached = cache.get(key);
  if (cached !== undefined && now.getTime() - cached.at < CACHE_TTL_MS) {
    return cached.credentials;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${config.baseUrl}/v0/management/auth-files`, {
      headers: { authorization: `Bearer ${config.managementKey}` },
      signal: controller.signal,
    });
    const text = (await response.text()).slice(0, MAX_BODY_BYTES);
    if (response.status === 401 || response.status === 403) {
      if (/banned/iu.test(text)) {
        rejectedUntil.set(key, now.getTime() + REJECTED_KEY_BACKOFF_MS);
        throw new CliproxyError("CLIProxyAPI banned this IP. Try again later.");
      }
      rejectedUntil.set(key, now.getTime() + REJECTED_KEY_BACKOFF_MS);
      throw new CliproxyError(
        "CLIProxyAPI rejected the management key. Fix the key in the plugin settings.",
      );
    }
    if (response.status !== 200) {
      throw new CliproxyError(`CLIProxyAPI answered with HTTP ${response.status}.`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new CliproxyError("CLIProxyAPI returned a response that is not JSON.");
    }
    const credentials = parseAuthFiles(body, now);
    cache.set(key, { at: now.getTime(), credentials });
    return credentials;
  } catch (error) {
    if (error instanceof CliproxyError) throw error;
    throw new CliproxyError(
      error instanceof Error && error.name === "AbortError"
        ? "CLIProxyAPI did not answer in time."
        : "CLIProxyAPI is unreachable.",
    );
  } finally {
    clearTimeout(timer);
  }
}
