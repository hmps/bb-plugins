# Changelog

## 0.2.0

- Attempt a final event scan before folding a deleted thread into daily totals.
- Calculate the usage page's 24-hour window on each server read.
- Keep hour buckets inside server-local days, including time zones with half-hour offsets.
- Match the marketplace range to version 0.2.0.

- Add a Tokens row to the thread Info tab with an exact breakdown on select.
- Add a Thread usage page with 14 days by model and the top threads of the last 24 hours.
- Add the read-only `getThreads` RPC with the CLI `threads` JSON shape.
- Invalidate thread and totals reads when stored usage changes.

## 0.1.0

- Count token usage from bb events without model calls or added agent context.
- Exclude every event before installation while preserving its cumulative cursor.
- Read model changes from turn requests and split hourly usage by model.
- Store thread totals and retained hourly totals in SQLite.
- Keep daily totals after rollup and thread deletion.
- Add startup catch-up, lifecycle handling, and retention settings.
- Add thread, threads, days, and hours CLI commands with JSON output.
- Expose thread and daily usage RPC methods for the future UI.
