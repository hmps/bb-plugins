# Lessons

- usage-tracker: bb reports no window start. Derive elapsed time from `resetsAt` and a fixed duration (5h / 7d). Model-scoped windows (Fable) share the weekly reset time, so 7d is correct.
- Verify plugin math against live data: `curl -X POST http://127.0.0.1:<port>/api/v1/plugins/usage-tracker/rpc/getUsage -d '{"threadId":null}'`. The port is in `~/.bb/bb-app-runtime.json`.
- `bb plugin list` keeps the install-time version after `bb plugin reload`; the reloaded code is still current.
- The Bash tool keeps its cwd between calls. Do not `cd` a relative path a second time; the chain fails.
- iOS 26 Safari ignores `theme-color`. It samples a fixed/sticky top element (top ≤4px, height >10px, width ≥90%, opaque bg, z-index ≥0). No candidate → black canvas in a tab, gradient bar in a Home Screen app. Give it a fixed rail (`ios-status-bar` plugin).
- `apple-mobile-web-app-status-bar-style` is read at Add-to-Home-Screen time. A runtime change needs a reinstall. Prefer CSS fixes.
- Content scripts cannot read plugin settings; only React slots have `useSettings`. Keep content-script plugins setting-free or add a settings slot.
- The fixed rail fixes the Safari tab but not the iOS 26 Home Screen app: WebKit still draws the scroll-pocket blur under `black-translucent`. iOS takes `apple-mobile-web-app-status-bar-style` from the served HTML at Add-to-Home-Screen time; a runtime DOM change is ignored even after a remove + re-add. Only a bb `index.html` change (`default`, as X uses) fixes standalone.
- zsh `noclobber` is on in the Bash tool: use `>|` to overwrite an existing file.
- WebKit edge tint = hit test at one point per edge (center x, 4px in); topmost painted fixed/sticky element wins; colors are collected from the whole ancestor chain (a `::before` tint still counts). Win with a fixed rail at max z-index, height >= 16px, opaque `background-color`, no `backdrop-filter`. Do rails for top and bottom.
