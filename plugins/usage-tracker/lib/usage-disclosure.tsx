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
}

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
  const [selectedProviderId, setSelectedProviderId] =
    useState<SidebarProviderId>(SIDEBAR_PROVIDER_IDS[0]);
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
    if (!enabledProviderIds.includes(selectedProviderId)) {
      setSelectedProviderId(enabledProviderIds[0] ?? SIDEBAR_PROVIDER_IDS[0]);
    }
  }, [enabledProviderIds, selectedProviderId]);

  const providers = useMemo(
    () =>
      enabledProviderIds
        .map((providerId) =>
          snapshot?.providers.find((provider) => provider.id === providerId),
        )
        .filter((provider): provider is ProviderUsage => provider !== undefined),
    [enabledProviderIds, snapshot],
  );
  const selectedProvider =
    providers.find((provider) => provider.id === selectedProviderId) ??
    providers[0] ??
    null;

  const selectProviderWithKeyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    let nextIndex: number;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % providers.length;
    else if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + providers.length) % providers.length;
    } else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = providers.length - 1;
    else return;

    const nextProvider = providers[nextIndex];
    if (nextProvider === undefined) return;
    event.preventDefault();
    setSelectedProviderId(nextProvider.id as SidebarProviderId);
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
            const selected = provider.id === selectedProvider?.id;
            return (
              <button
                key={provider.id}
                type="button"
                role="tab"
                aria-label={provider.name}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                data-provider={provider.id}
                onClick={() => setSelectedProviderId(providerId)}
                onKeyDown={(event) => selectProviderWithKeyboard(event, index)}
              >
                <ProviderGlyph providerId={providerId} />
              </button>
            );
          })}
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
        {selectedProvider === null ? (
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
