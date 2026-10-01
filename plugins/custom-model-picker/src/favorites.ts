// Favorite ordering. Pure: the menu passes the entries that the allowlist
// already kept, so a favorite can never add a model to the menu.
import type { CatalogEntry } from "./catalog";

export interface FavoriteSplit {
  /** Favorites that the menu can show, in favorite order. */
  favorites: CatalogEntry[];
  /** Every other shown entry, in configured order. */
  rest: CatalogEntry[];
  /** Favorite keys with no shown entry here. */
  missing: string[];
}

export function splitFavorites(
  entries: readonly CatalogEntry[],
  favoriteKeys: readonly string[],
): FavoriteSplit {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const favorites: CatalogEntry[] = [];
  const missing: string[] = [];
  for (const key of new Set(favoriteKeys)) {
    const entry = byKey.get(key);
    if (entry) favorites.push(entry);
    else missing.push(key);
  }
  const shown = new Set(favorites.map((entry) => entry.key));
  return { favorites, rest: entries.filter((entry) => !shown.has(entry.key)), missing };
}

export function toggleFavorite(favoriteKeys: readonly string[], key: string): string[] {
  return favoriteKeys.includes(key)
    ? favoriteKeys.filter((candidate) => candidate !== key)
    : [...favoriteKeys, key];
}
