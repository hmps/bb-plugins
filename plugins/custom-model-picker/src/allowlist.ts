// The `models` setting format. Shared by the server (validation) and the app
// (filtering), so it has no imports.

/**
 * Parses the `models` setting: one `provider/model` key per line or comma.
 * Blank entries and `#` comments are dropped. An empty result means "show
 * every catalog model".
 */
export function parseAllowlist(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const keys = raw
    .split(/[\n,]/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.length > 0);
  return [...new Set(keys)];
}

/** Keys that are not `provider/model`, such as a model id with no provider. */
export function invalidAllowlistKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => !/^[^/\s]+\/\S+$/.test(key));
}
