export const SIDEBAR_PROVIDER_IDS = ["claudeCode", "codex"] as const;

export type SidebarProviderId = (typeof SIDEBAR_PROVIDER_IDS)[number];

export interface UsageTrackerPreferences {
  enableClaudeCode: boolean;
  enableCodex: boolean;
}

export function enabledSidebarProviderIds(
  preferences: UsageTrackerPreferences,
): SidebarProviderId[] {
  return SIDEBAR_PROVIDER_IDS.filter((providerId) =>
    providerId === "claudeCode"
      ? preferences.enableClaudeCode
      : preferences.enableCodex,
  );
}
