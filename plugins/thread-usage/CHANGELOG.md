# Changelog

## 0.1.0

- Count token usage from bb events without model calls or added agent context.
- Store thread totals and retained hourly totals in SQLite.
- Keep daily totals after rollup and thread deletion.
- Add startup catch-up, lifecycle handling, and retention settings.
- Add thread, threads, days, and hours CLI commands with JSON output.
- Expose thread and daily usage RPC methods for the future UI.
