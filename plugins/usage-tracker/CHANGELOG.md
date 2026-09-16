# Changelog

All notable changes to Usage Tracker are documented here.

## Unreleased

### Added

- The expanded Codex card shows the number of available full usage resets.

### Changed

- The sidebar now uses BB's native icon-only disclosure, provider tabs, and
  stacked usage rows.
- Pace guidance now places expected usage at reset beside current usage.
- Provider response IDs follow current BB IDs, including `claude-code` and
  `acp-cursor`.
- The expanded card shows only the windows that a provider reports. A healthy
  Codex weekly-only response no longer restores an obsolete five-hour window.
- Claude throttle errors keep their original message, and last-known session,
  weekly, and Fable values remain visible through the temporary error.

## 1.1.0 - 2026-08-19

### Added

- A pace signal for every usage window. Usage Tracker projects the current
  burn rate forward to the reset time and reports on track, watch, or at
  risk.
- A pace line and an elapsed-time tick in each row of the expanded details
  card. The line shows the projected percent at reset, and the time the
  window runs out when it is at risk.
- Amber and red colors on the collapsed strip when a provider has a window
  to watch or at risk.

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
