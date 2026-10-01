// Reasoning labels, the efforts the menu offers, and the check of a reasoning
// write. Pure, so tests can drive every branch with plain values.
import type { ExperimentalComposerSelection } from "@get-bb/plugin-sdk/app";
import type { CatalogEntry, CatalogProvider, ReasoningEffort } from "./catalog";

/** Efforts the menu never offers. It still shows them when they are current. */
const HIDDEN_LEVELS: ReadonlySet<string> = new Set(["max", "ultra", "ultracode"]);

// The fallback labels the native picker uses when a provider has none.
const LEVEL_LABELS: Record<string, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  ultracode: "Ultracode",
  max: "Max",
  ultra: "Ultra",
};

export function reasoningLabel(level: string, provider?: CatalogProvider): string {
  return provider?.reasoningLabels[level] ?? LEVEL_LABELS[level] ?? level;
}

/** The catalog efforts of the current model that the menu offers. */
export function reasoningChoices(entry: CatalogEntry | undefined): ReasoningEffort[] {
  return entry ? entry.reasoningEfforts.filter((effort) => !HIDDEN_LEVELS.has(effort.level)) : [];
}

export type ReasoningOutcome =
  | { kind: "applied" }
  | { kind: "model-changed"; actual: ExperimentalComposerSelection }
  | { kind: "reconciled"; actual: ExperimentalComposerSelection };

/**
 * Compares the settled selection with a reasoning-only request. The model
 * must stay the same and the level must match exactly.
 */
export function reasoningOutcome(
  requested: { providerId?: string; model?: string; reasoningLevel: string },
  actual: ExperimentalComposerSelection,
): ReasoningOutcome {
  if (
    (actual.providerId !== undefined && actual.providerId !== requested.providerId) ||
    (actual.model !== undefined && actual.model !== requested.model)
  ) {
    return { kind: "model-changed", actual };
  }
  if (actual.reasoningLevel !== requested.reasoningLevel) {
    return { kind: "reconciled", actual };
  }
  return { kind: "applied" };
}

export function describeReasoningOutcome(
  outcome: Exclude<ReasoningOutcome, { kind: "applied" }>,
  requestedLabel: string,
): string {
  if (outcome.kind === "model-changed") {
    return `The composer changed the model to ${outcome.actual.providerId ?? "?"}/${outcome.actual.model ?? "?"}. Check the reasoning level.`;
  }
  const kept = outcome.actual.reasoningLevel ?? "an unknown level";
  return `The composer did not accept ${requestedLabel} reasoning. It kept ${kept}.`;
}
