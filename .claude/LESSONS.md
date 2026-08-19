# Lessons

- usage-tracker: bb reports no window start. Derive elapsed time from `resetsAt` and a fixed duration (5h / 7d). Model-scoped windows (Fable) share the weekly reset time, so 7d is correct.
- Verify plugin math against live data: `curl -X POST http://127.0.0.1:<port>/api/v1/plugins/usage-tracker/rpc/getUsage -d '{"threadId":null}'`. The port is in `~/.bb/bb-app-runtime.json`.
- `bb plugin list` keeps the install-time version after `bb plugin reload`; the reloaded code is still current.
- The Bash tool keeps its cwd between calls. Do not `cd` a relative path a second time; the chain fails.
