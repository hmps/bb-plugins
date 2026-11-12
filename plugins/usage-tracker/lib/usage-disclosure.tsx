import type { ExperimentalSidebarFooterDisclosureProps } from "@get-bb/plugin-sdk/app";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from "react";
import { formatUsageProjection, type PaceStatus } from "./pace.ts";
import {
  SIDEBAR_PROVIDER_IDS,
  type SidebarProviderId,
} from "./preferences.ts";
import { providerMark } from "./provider-marks.ts";
import {
  mergeLastKnownWindows,
  sidebarWindowPaces,
  type SidebarWindowPace,
} from "./sidebar-usage.ts";
import {
  formatResetTime,
  formatUsedPercent,
  providerStatusLabel,
  type ProviderUsage,
  type UsageSnapshot,
} from "./usage.ts";

const CACHE_KEY = "bb:usage-tracker:sidebar:last-known";
const AUTO_REFRESH_MS = 5 * 60_000;

interface RpcEnvelope<T> {
  ok: boolean;
  result?: T;
  error?: { message?: string };
}

interface PreferencesResult {
  enabledProviderIds: SidebarProviderId[];
  cliproxyConfigured: boolean;
}

interface CliproxyCredentialView {
  provider: string;
  account: string;
  status: string;
  statusMessage: string;
  disabled: boolean;
  planLabel: string | null;
  success: number | null;
  failed: number | null;
  cooldowns: number;
  recent: { time: string; success: number; failed: number }[];
}

interface CliproxyOverview {
  message: string | null;
  credentials: CliproxyCredentialView[];
}

const CLIPROXY_TAB = "cliproxy";
type TabId = SidebarProviderId | typeof CLIPROXY_TAB;

function readCachedSnapshot(): UsageSnapshot | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
    if (
      value === null ||
      typeof value !== "object" ||
      !Array.isArray((value as Partial<UsageSnapshot>).providers)
    ) {
      return null;
    }
    return value as UsageSnapshot;
  } catch {
    return null;
  }
}

function cacheSnapshot(snapshot: UsageSnapshot): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // The live view still works when storage is unavailable.
  }
}

function mergeSnapshot(
  current: UsageSnapshot,
  previous: UsageSnapshot | null,
): UsageSnapshot {
  return {
    ...current,
    providers: current.providers.map((provider) =>
      mergeLastKnownWindows(
        provider,
        previous?.providers.find((candidate) => candidate.id === provider.id),
      ),
    ),
  };
}

async function postRpc<T>(
  method: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/v1/plugins/usage-tracker/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    signal,
  });
  const payload = (await response.json()) as RpcEnvelope<T>;
  if (!response.ok || !payload.ok || payload.result === undefined) {
    throw new Error(payload.error?.message ?? "Usage is unavailable.");
  }
  return payload.result;
}

function ProviderGlyph({ providerId }: { providerId: SidebarProviderId }) {
  const mark = providerMark(providerId);
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={mark.viewBox}
      fillRule={mark.fillRule}
    >
      <path d={mark.path} />
    </svg>
  );
}

function ReloadGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path d="M20 6v5h-5M4 18v-5h5M6.1 9a7 7 0 0 1 11.7-2.5L20 11M4 13l2.2 4.5A7 7 0 0 0 18 15" />
    </svg>
  );
}

function CollapseGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path d="m7 10 5 5 5-5" />
    </svg>
  );
}

function CliproxyGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path d="M4 7h16M4 17h16M8 7v10M16 7v10" />
    </svg>
  );
}

const PROVIDER_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
};

function ActivityBars({
  recent,
}: {
  recent: CliproxyCredentialView["recent"];
}) {
  const peak = Math.max(1, ...recent.map((b) => b.success + b.failed));
  return (
    <div
      className="usage-disclosure__activity"
      role="img"
      aria-label="Requests in the last intervals"
    >
      {recent.map((bucket) => (
        <span
          key={bucket.time}
          title={`${bucket.time}: ${bucket.success} ok, ${bucket.failed} failed`}
          data-failed={bucket.failed > 0 ? "true" : undefined}
          style={{
            height: `${Math.max(6, ((bucket.success + bucket.failed) / peak) * 100)}%`,
          }}
        />
      ))}
    </div>
  );
}

function CliproxyDetails({ overview }: { overview: CliproxyOverview | null }) {
  const number = new Intl.NumberFormat();
  return (
    <>
      <div className="usage-disclosure__identity">
        <div>
          <h2>CLIProxyAPI</h2>
          <p>Credentials and recent requests</p>
        </div>
      </div>
      {overview === null ? (
        <p className="usage-disclosure__empty">Loading credentials…</p>
      ) : overview.message !== null ? (
        <p className="usage-disclosure__message" role="status">
          {overview.message}
        </p>
      ) : overview.credentials.length === 0 ? (
        <p className="usage-disclosure__empty">No credentials reported.</p>
      ) : (
        <div className="usage-disclosure__windows">
          {overview.credentials.map((credential) => (
            <div
              key={`${credential.provider}:${credential.account}`}
              className="usage-disclosure__credential"
              data-inactive={
                credential.disabled || credential.status !== "active"
                  ? "true"
                  : undefined
              }
            >
              <div className="usage-disclosure__window-heading">
                <span title={credential.account}>
                  {PROVIDER_NAMES[credential.provider] ?? credential.provider}
                  {credential.planLabel === null ? "" : ` ${credential.planLabel}`}
                </span>
                <span>
                  {credential.disabled ? "disabled" : credential.status || "unknown"}
                </span>
              </div>
              <ActivityBars recent={credential.recent} />
              <p>
                {credential.success === null
                  ? "No request totals"
                  : `${number.format(credential.success)} ok`}
                {credential.failed === null || credential.failed === 0
                  ? ""
                  : ` · ${number.format(credential.failed)} failed`}
                {credential.cooldowns > 0
                  ? ` · ${credential.cooldowns} cooling down`
                  : ""}
              </p>
              {credential.statusMessage === "" ? null : (
                <p>{credential.statusMessage}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function tone(status: PaceStatus): string | undefined {
  return status === "watch" || status === "at_risk" ? status : undefined;
}

function UsageWindowRow({ entry }: { entry: SidebarWindowPace }) {
  const { window, pace } = entry;
  return (
    <div className="usage-disclosure__window" data-pace={tone(pace.status)}>
      <div className="usage-disclosure__window-heading">
        <span>{window.label}</span>
        <span title="Expected usage at reset is shown in parentheses">
          {formatUsageProjection(window.usedPercent, pace)}
        </span>
      </div>
      <div className="usage-disclosure__rail">
        <span
          className="usage-disclosure__fill"
          style={{ width: `${Math.max(2, window.barPercent)}%` }}
        />
      </div>
      <p>{formatResetTime(window.resetsAt)}</p>
    </div>
  );
}

function ProviderDetails({ provider }: { provider: ProviderUsage }) {
  const paces = sidebarWindowPaces(provider, new Date());
  const entries = [paces.session, paces.weekly, ...paces.extras].filter(
    (entry): entry is SidebarWindowPace => entry !== null,
  );

  return (
    <>
      <div className="usage-disclosure__identity">
        <div>
          <h2>{provider.name}</h2>
          {provider.accountEmail === null ? null : (
            <p title={provider.accountEmail}>{provider.accountEmail}</p>
          )}
        </div>
        {provider.planLabel === null ? null : (
          <span className="usage-disclosure__plan">{provider.planLabel}</span>
        )}
      </div>

      {provider.status !== "ok" && provider.message !== null ? (
        <p className="usage-disclosure__message" role="status">
          {entries.length > 0 ? "Showing the last update. " : ""}
          {provider.message}
        </p>
      ) : null}

      {entries.length === 0 ? (
        <p className="usage-disclosure__empty">
          {provider.status === "ok"
            ? "No usage limits reported for this plan."
            : providerStatusLabel(provider.status)}
        </p>
      ) : (
        <div className="usage-disclosure__windows">
          {entries.map((entry) => (
            <UsageWindowRow key={entry.window.label} entry={entry} />
          ))}
        </div>
      )}

      {provider.id === "codex" && provider.resetCreditsAvailable !== null ? (
        <div className="usage-disclosure__resets">
          <span>Full resets</span>
          <strong>{provider.resetCreditsAvailable} available</strong>
        </div>
      ) : null}
    </>
  );
}

export function UsageDisclosure({
  dismiss,
}: ExperimentalSidebarFooterDisclosureProps) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(() =>
    readCachedSnapshot(),
  );
  const [enabledProviderIds, setEnabledProviderIds] = useState<
    SidebarProviderId[]
  >([...SIDEBAR_PROVIDER_IDS]);
  const [cliproxyConfigured, setCliproxyConfigured] = useState(false);
  const [overview, setOverview] = useState<CliproxyOverview | null>(null);
  const [selectedTab, setSelectedTab] = useState<TabId>(
    SIDEBAR_PROVIDER_IDS[0],
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setIsRefreshing(true);
      setError(null);
      try {
        const [usage, preferences] = await Promise.all([
          postRpc<UsageSnapshot>("getUsage", { threadId: null }, signal),
          postRpc<PreferencesResult>("getPreferences", null, signal),
        ]);
        setSnapshot((previous) => {
          const merged = mergeSnapshot(usage, previous);
          cacheSnapshot(merged);
          return merged;
        });
        setEnabledProviderIds(preferences.enabledProviderIds);
        setCliproxyConfigured(preferences.cliproxyConfigured);
        if (preferences.cliproxyConfigured) {
          setOverview(await postRpc<CliproxyOverview>("getCliproxy", null, signal));
        } else {
          setOverview(null);
        }
      } catch (loadError) {
        if (signal?.aborted !== true) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Usage is unavailable.",
          );
        }
      } finally {
        if (signal?.aborted !== true) setIsRefreshing(false);
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const interval = window.setInterval(() => void load(), AUTO_REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [load]);

  useEffect(() => {
    const valid =
      selectedTab === CLIPROXY_TAB
        ? cliproxyConfigured
        : enabledProviderIds.includes(selectedTab);
    if (!valid) {
      setSelectedTab(enabledProviderIds[0] ?? SIDEBAR_PROVIDER_IDS[0]);
    }
  }, [enabledProviderIds, selectedTab, cliproxyConfigured]);

  const providers = useMemo(
    () =>
      enabledProviderIds
        .map((providerId) =>
          snapshot?.providers.find((provider) => provider.id === providerId),
        )
        .filter((provider): provider is ProviderUsage => provider !== undefined),
    [enabledProviderIds, snapshot],
  );
  const tabIds: TabId[] = [
    ...providers.map((provider) => provider.id as SidebarProviderId),
    ...(cliproxyConfigured ? [CLIPROXY_TAB as TabId] : []),
  ];
  const showingCliproxy = selectedTab === CLIPROXY_TAB && cliproxyConfigured;
  const selectedProvider =
    providers.find((provider) => provider.id === selectedTab) ??
    providers[0] ??
    null;

  const selectProviderWithKeyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    let nextIndex: number;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabIds.length;
    else if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + tabIds.length) % tabIds.length;
    } else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabIds.length - 1;
    else return;

    const nextTab = tabIds[nextIndex];
    if (nextTab === undefined) return;
    event.preventDefault();
    setSelectedTab(nextTab);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      .item(nextIndex)
      .focus();
  };

  return (
    <div className="usage-disclosure">
      <div className="usage-disclosure__header">
        <div
          className="usage-disclosure__tabs"
          role="tablist"
          aria-label="Usage provider"
        >
          {providers.map((provider, index) => {
            const providerId = provider.id as SidebarProviderId;
            const selected =
              !showingCliproxy && provider.id === selectedProvider?.id;
            return (
              <button
                key={provider.id}
                type="button"
                role="tab"
                aria-label={provider.name}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                data-provider={provider.id}
                onClick={() => setSelectedTab(providerId)}
                onKeyDown={(event) => selectProviderWithKeyboard(event, index)}
              >
                <ProviderGlyph providerId={providerId} />
              </button>
            );
          })}
          {cliproxyConfigured ? (
            <button
              type="button"
              role="tab"
              aria-label="CLIProxyAPI"
              aria-selected={showingCliproxy}
              tabIndex={showingCliproxy ? 0 : -1}
              data-provider={CLIPROXY_TAB}
              onClick={() => setSelectedTab(CLIPROXY_TAB)}
              onKeyDown={(event) =>
                selectProviderWithKeyboard(event, tabIds.length - 1)
              }
            >
              <CliproxyGlyph />
            </button>
          ) : null}
        </div>
        {snapshot?.host.name === null || snapshot?.host.name === undefined ? null : (
          <span className="usage-disclosure__host" title={snapshot.host.name}>
            {snapshot.host.name}
          </span>
        )}
        <button
          className="usage-disclosure__icon-button"
          type="button"
          aria-label="Reload provider usage"
          disabled={isRefreshing}
          onClick={() => void load()}
        >
          <ReloadGlyph />
        </button>
        <button
          className="usage-disclosure__icon-button"
          type="button"
          aria-label="Collapse provider usage"
          onClick={dismiss}
        >
          <CollapseGlyph />
        </button>
      </div>

      <div className="usage-disclosure__content" role="tabpanel">
        {showingCliproxy ? (
          <CliproxyDetails overview={overview} />
        ) : selectedProvider === null ? (
          <p className="usage-disclosure__empty">
            {isRefreshing ? "Loading provider usage…" : "No providers are enabled."}
          </p>
        ) : (
          <ProviderDetails provider={selectedProvider} />
        )}
        {error === null ? null : (
          <p className="usage-disclosure__message" role="status">
            Showing the last update. {error}
          </p>
        )}
      </div>
    </div>
  );
}
