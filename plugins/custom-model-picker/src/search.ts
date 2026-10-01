import type { CatalogEntry } from "./catalog";

/** Trims and lowercases the filter text. An empty result shows everything. */
export function normalizeQuery(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * Matches the filter against every name the menu shows or configures: the
 * display name, the model id, the provider name and id, the route, and the
 * `provider/model` key. The query must be normalized.
 */
export function entryMatches(entry: CatalogEntry, query: string): boolean {
  if (!query) return true;
  return [
    entry.displayName,
    entry.model,
    entry.providerName,
    entry.providerId,
    entry.route ?? "",
    entry.key,
  ].some((text) => text.toLowerCase().includes(query));
}

/** Matches a configured key that has no catalog entry, such as a missing favorite. */
export function keyMatches(key: string, query: string): boolean {
  return !query || key.toLowerCase().includes(query);
}
