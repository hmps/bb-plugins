// Pure catalog, allowlist, routing, and selection-outcome logic. No React and
// no host access beyond the typed SDK calls in loadCatalog, so tests can drive
// every branch with plain values.
import type {
  ExperimentalComposerSelection,
  ExperimentalProviderIconProps,
  PluginBrowserBbSdk,
} from "@get-bb/plugin-sdk/app";

type ProvidersArea = PluginBrowserBbSdk["providers"];
type ModelsResult = Awaited<ReturnType<ProvidersArea["models"]>>;
type CatalogModel = ModelsResult["models"][number];
export type ReasoningLevel = CatalogModel["defaultReasoningEffort"];

/** Where a catalog request goes: an environment, a host, or the server default. */
export type CatalogRouting =
  | { environmentId: string }
  | { hostId: string }
  | Record<string, never>;

export interface ReasoningEffort {
  level: ReasoningLevel;
  description: string;
}

export interface CatalogEntry {
  /** Provider-qualified key, the same form the allowlist setting uses. */
  key: string;
  providerId: string;
  providerName: string;
  model: string;
  displayName: string;
  /** Route qualifier the native picker shows next to the label. */
  route?: string;
  /** Efforts the catalog says this model accepts, in catalog order. */
  reasoningEfforts: ReasoningEffort[];
  defaultReasoning: ReasoningLevel;
}

/** Provider metadata the menu shows: artwork and the host's effort labels. */
export interface CatalogProvider {
  id: string;
  name: string;
  icon: ExperimentalProviderIconProps["provider"];
  reasoningLabels: Partial<Record<string, string>>;
}

export interface CatalogError {
  providerId: string;
  providerName: string;
  message: string;
}

export interface Catalog {
  entries: CatalogEntry[];
  /** Labels for models the host lists only while they are selected. */
  selectedOnly: CatalogEntry[];
  errors: CatalogError[];
  providers: Record<string, CatalogProvider>;
}

export function modelKey(providerId: string, model: string): string {
  return `${providerId}/${model}`;
}

export interface FilteredCatalog {
  entries: CatalogEntry[];
  /** Allowlist keys that match no catalog model on this machine. */
  unmatched: string[];
}

/** Applies the allowlist in its own order; an empty allowlist keeps all. */
export function filterCatalog(
  entries: readonly CatalogEntry[],
  allowlist: readonly string[],
): FilteredCatalog {
  if (allowlist.length === 0) return { entries: [...entries], unmatched: [] };
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const kept: CatalogEntry[] = [];
  const unmatched: string[] = [];
  for (const key of allowlist) {
    const entry = byKey.get(key);
    if (entry) kept.push(entry);
    else unmatched.push(key);
  }
  return { entries: kept, unmatched };
}

/**
 * Mirrors the native new-thread picker: an existing machine or a chosen host
 * routes to that host, a reused environment routes to it, and everything else
 * uses the server's default host.
 */
export function routingForNewThread(
  environment: ExperimentalComposerSelection["environment"],
): CatalogRouting {
  if (!environment) return {};
  switch (environment.type) {
    case "reuse":
      return { environmentId: environment.environmentId };
    case "host":
      return environment.hostId ? { hostId: environment.hostId } : {};
    case "provider":
      return environment.machine?.type === "existing"
        ? { hostId: environment.machine.hostId }
        : {};
    default:
      return {};
  }
}

export function routingForThread(environmentId: string | null): CatalogRouting {
  return environmentId ? { environmentId } : {};
}

export function routingKey(routing: CatalogRouting): string {
  if ("environmentId" in routing) return `env:${routing.environmentId}`;
  if ("hostId" in routing) return `host:${routing.hostId}`;
  return "default";
}

function toEntry(
  providerId: string,
  providerName: string,
  model: CatalogModel,
): CatalogEntry {
  const displayName = model.displayName || model.model;
  return {
    key: modelKey(providerId, model.model),
    providerId,
    providerName,
    model: model.model,
    displayName: providerId === "codex" ? displayName.replace(/^gpt-/i, "") : displayName,
    ...(model.routeProviderId ? { route: model.routeProviderId } : {}),
    reasoningEfforts: (model.supportedReasoningEfforts ?? []).map((effort) => ({
      level: effort.reasoningEffort,
      description: effort.description,
    })),
    defaultReasoning: model.defaultReasoningEffort,
  };
}

function toProvider(provider: ModelsResult["providers"][number]): CatalogProvider {
  const tint = provider.strings?.iconTint;
  return {
    id: provider.id,
    name: provider.displayName || provider.id,
    icon: {
      id: provider.id,
      logoUrl: provider.logoUrl ?? null,
      icon: provider.icon ?? null,
      strings: tint ? { iconTint: tint } : null,
    },
    reasoningLabels: Object.fromEntries(
      (provider.reasoningLevels ?? []).map((level) => [level.id, level.label]),
    ),
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Builds the catalog from the provider list result and one per-provider
 * models result. Unavailable providers are skipped. A provider whose load
 * failed contributes an error instead of entries.
 */
export function buildCatalog(
  providers: ModelsResult["providers"],
  results: ReadonlyArray<PromiseSettledResult<ModelsResult>>,
): Catalog {
  const catalog: Catalog = { entries: [], selectedOnly: [], errors: [], providers: {} };
  providers.forEach((provider, index) => {
    const settled = results[index];
    if (!settled) return;
    const info = toProvider(provider);
    catalog.providers[provider.id] = info;
    const name = info.name;
    if (settled.status === "rejected") {
      catalog.errors.push({
        providerId: provider.id,
        providerName: name,
        message: errorMessage(settled.reason),
      });
      return;
    }
    const result = settled.value;
    if (result.modelLoadError) {
      catalog.errors.push({
        providerId: provider.id,
        providerName: name,
        message: result.modelLoadError.detail || result.modelLoadError.code,
      });
    }
    for (const model of result.models) {
      catalog.entries.push(toEntry(provider.id, name, model));
    }
    for (const model of result.selectedOnlyModels) {
      catalog.selectedOnly.push(toEntry(provider.id, name, model));
    }
  });
  return catalog;
}

/** Loads every available provider's models from one machine. */
export async function loadCatalog(
  providersApi: ProvidersArea,
  routing: CatalogRouting,
  signal?: AbortSignal,
): Promise<Catalog> {
  const base = await providersApi.models({ ...routing, signal });
  const providers = base.providers.filter((provider) => provider.available);
  const results = await Promise.allSettled(
    providers.map((provider) =>
      providersApi.models({ ...routing, providerId: provider.id, signal }),
    ),
  );
  return buildCatalog(providers, results);
}

export type SelectionOutcome =
  | { kind: "applied" }
  | { kind: "provider-ignored"; actual: ExperimentalComposerSelection }
  | { kind: "model-reconciled"; actual: ExperimentalComposerSelection };

/**
 * Compares what the composer settled on with what the user asked for. Only
 * an exact provider and model match counts as success.
 */
export function selectionOutcome(
  requested: { providerId: string; model: string },
  actual: ExperimentalComposerSelection,
): SelectionOutcome {
  if (actual.providerId !== requested.providerId) {
    return { kind: "provider-ignored", actual };
  }
  if (actual.model !== requested.model) {
    return { kind: "model-reconciled", actual };
  }
  return { kind: "applied" };
}

export function describeOutcome(
  outcome: Exclude<SelectionOutcome, { kind: "applied" }>,
  requestedLabel: string,
): string {
  const actual = outcome.actual.model
    ? `${outcome.actual.providerId ?? "?"}/${outcome.actual.model}`
    : "no model";
  return outcome.kind === "provider-ignored"
    ? `This composer does not offer the provider for ${requestedLabel}. It kept ${actual}.`
    : `The composer did not accept ${requestedLabel}. It selected ${actual}.`;
}
