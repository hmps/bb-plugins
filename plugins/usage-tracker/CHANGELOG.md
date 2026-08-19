# Changelog

All notable changes to Usage Tracker are documented here.

## 1.0.0 (hmps fork) - 2026-08-19

### Added

- Model-scoped quotas (for example Fable) show as extra rows in the expanded
  Claude Code details card.
- Last-known model-scoped windows are kept when a refresh returns none.

## 0.1.2 - 2026-08-17

### Changed

- Migrated development types to the published `@get-bb/plugin-sdk` package
  and raised the minimum BB version to 0.38.

## 0.1.1 - 2026-08-12

### Added

- Independent settings for showing or hiding Claude Code and Codex usage in
  the sidebar footer. Both providers remain enabled by default.

### Changed

- Provider visibility updates live after settings are saved, and the compact
  strip adapts its layout when only one provider is enabled.
- A single enabled provider now forms a compact right-aligned group with its
  refresh control, rather than retaining the full two-provider width.
- Disabling both providers hides the Usage Tracker sidebar row.

## 0.1.0 - 2026-08-11

### Added

- Initial release with compact Claude Code and Codex five-hour and weekly
  usage limits, expandable reset details, manual refresh, and last-known value
  retention.
