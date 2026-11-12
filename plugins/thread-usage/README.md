# Thread Usage

Thread Usage counts tokens from bb's own `thread/tokenUsage/updated` events.
It reads model changes from `client/turn/requested` events.
It stores totals per thread, server-local hour, server-local day, project, and model.
The plugin uses no tokens. It makes no model calls and adds no agent context.
Version 0.2.0 adds a Tokens row to each thread's Info tab and a Thread usage page.

## What it counts

Totals show usage **since tracking began**. The plugin cannot recover past data.
On first load, it records an installation time in its own SQLite database.
Every usage event before installation updates the cursor and counts nothing.
For an older thread, the first observed total becomes a baseline and counts nothing.
This baseline rule also applies when its first retained event is after installation.
For a thread created after installation, the first total counts in full.
Later events add the difference from the previous cumulative total.
A changed provider session ID or a decrease in any counter starts a new session.
The plugin counts that session's total in full.
Missing optional counters count as zero. Repeated event sequences count once.

The seven fields are `totalTokens`, `inputTokens`, `cachedInputTokens`,
`cacheReadInputTokens`, `cacheWriteInputTokens`, `outputTokens`, and `reasoningOutputTokens`.
These fields follow the provider's report. Cache and reasoning fields can overlap other fields.
Do not add all seven fields to calculate a total.
Tokens are not quota. Provider quota can use other measures and time windows.

The plugin reads the model from `client/turn/requested` events at `data.execution.model`.
A missing model keeps the previous value. The first default is `unknown`.
Thread totals contain the latest model label. Hourly and daily totals retain their stored labels.

## Retention and recovery

`retentionDays` defaults to 7 and accepts whole numbers of at least 1.
Set it with `bb plugin config thread-usage set retentionDays 14`.
At 03:15 server-local time, the plugin folds older hours into daily totals.
It deletes those hourly rows and runs incremental vacuum.
Daily totals remain stored. Archiving keeps thread totals.
Deleting a thread first attempts a final event scan inside its serial queue.
It then folds its hours into daily totals and removes its thread totals and hours.
bb 0.49.0 marks threads deleted before it emits the deletion notification.
Its events API then returns 404, so that final scan cannot recover unobserved usage.
The plugin keeps already observed totals and logs when the final event read fails.

On startup, catch-up reads thread lists in pages of 200, including hidden and archived threads.
It checks `updatedAt` against the previous successful startup checkpoint.
The SDK has no update-time list filter. The plugin scans at most 20,000 threads per archive state.
If it reaches that bound, it logs a warning and leaves the checkpoint unchanged.
Catch-up and event reads run serially per thread. Each event page contains at most 100 rows.
A failed event read retries on the next trigger or startup.

bb periodically prunes older token events and keeps the latest per thread.
Several older events can remain until pruning runs.
Cumulative totals recover missed updates within one provider session.
A session replaced while the plugin is offline can lose that earlier session's unseen usage.
The plugin assigns a recovered difference to the latest event's server-local hour.
It cannot reconstruct the actual times of missed updates.
Daily dates use the server time zone at query or rollup time.
Keep that time zone fixed for consistent day boundaries.

## CLI

```sh
bb thread-usage --help
bb thread-usage thread thr_example
bb thread-usage thread thr_example --json
bb thread-usage threads --since 2026-11-01 --project proj_example --limit 20 --json
bb thread-usage days --days 7 --json
bb thread-usage hours --since 2026-11-12T00:00:00Z --json
```

Plain output uses compact tab-separated tables.
`thread` returns all tracked totals, the latest model label, first-seen time, and baseline flag.
An unknown thread returns `null` in JSON.
`threads` ranks thread/model rows by `totalTokens` inside the hourly retention window.
Its default limit is 20. The maximum limit is 1,000.
`days` combines stored daily totals with retained hours, split by project and model.
It defaults to 7 days and accepts up to 3,660 days.
`hours` groups retained server-local hours by model. Hour-start timestamps remain UTC epoch milliseconds.
Thread and hour periods include whole event hours.
Date-only `--since` values use server-local midnight. ISO timestamps can include a time zone.
Periods that exceed retention return `truncated: true` and show a warning in plain output.
Deleted threads no longer appear in thread or hour output.

JSON uses camelCase names, integer epoch milliseconds, and unformatted token counts.
Each usage row contains a `totals` object with all seven fields.
`threads` and `hours` return `{ since, retentionStart, truncated, rows }`.
`days` returns `{ days, rows }`, with each row shaped as `{ day, projectId, model, totals }`.
`thread` returns `{ threadId, projectId, providerId, model, title, firstSeenAt, updatedAt, archivedAt, baseline, totals }`.

## UI

The **Tokens** row in each thread's Info tab shows the compact thread total and the latest model.
A second line shows "Since <time>", or "Tracking started <time>" for a baseline thread.
Select the row to show exact input, cache read, cache write, output, and total counts.
A thread with no tracked tokens shows "No usage tracked yet".

The **Thread usage** page is in the sidebar navigation.
It shows the last 14 days as one bar per day, split by model.
The three largest models keep their names. Other models combine into "Other".
It also lists the top 10 threads of the last 24 hours. Select a thread to open it.
Hold Cmd or Ctrl to open the thread in a split.
Compact counts use `k`, `M`, and `B`. Hover a count to see the exact value.

Both views only read data. The server invalidates their reads when stored usage changes.
Open views then refresh without polling.

## RPC

The shared contract is in `contract.ts`. RPC methods return the same JSON shapes as the CLI:

- `getThreadUsage({ threadId })` returns the `thread` object or `null`. Tag: `thread:<threadId>`.
- `getDailyUsage({ days })` returns the `days` object. Omitted `days` defaults to 7. Tag: `totals`.
- `getThreads({ since?, hours?, project?, limit? })` returns the `threads` object. Tag: `totals`.
  Without a period input, it uses the same defaults as `bb thread-usage threads`.
  Use either `since` or `hours`. `hours` accepts whole numbers from 1 to 87,840.
  With `hours`, each read calculates `since` from the current server-local hour minus that many elapsed hours.
  The UI passes `hours: 24`, so invalidated reads use the current window.

The RPC validates inputs. All methods read only the plugin database.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
bb plugin build
```

The plugin pins SDK declarations to the running bb version through `bb plugin types`.
Its local workspace permits the `better-sqlite3` development build script.
Tests use real SQLite databases and the public SDK test harness.
