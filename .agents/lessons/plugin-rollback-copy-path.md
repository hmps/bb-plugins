# Where the live source of a git plugin is, for a rollback copy

date: 2026-11-25
status: verified
scope: rollback copies before `bb plugin update <id>` of a git plugin from this repository on Ethereal-Titan
keywords: rollback, plugin cache, bb plugin update, deploy, ethereal-titan, data.db
evidence: inbox 0.1.3 → 0.1.4 deploy. `~/.bb/plugins/inbox` holds only `data.db`, `logs`, and `secrets`; `~/.bb/plugin-sources` holds other plugins. The source and built `dist` were at `~/.bb/plugins/cache/git/github.com/hmps/bb-plugins/<full sha>/plugins/inbox`.
action: Run `bb plugin source <id> --json`. Take the running build's SHA from `resolved` (short form), and the full SHA from the `history[].version` entry that starts with it. Copy `~/.bb/plugins/cache/git/github.com/hmps/bb-plugins/<sha>` (on Ethereal-Titan, by `ssh ethereal-titan`) to a path outside `~/.bb`, and hash its files. Back up `~/.bb/plugins/<id>/data.db` with `sqlite3 … ".backup <path>"` when the release changes the schema.
verify: the copied directory name starts with the SHA in `resolved`, and the hash of its `plugins/<id>/dist/server.js` is recorded.
retire-when: bb ships a documented rollback command or prints the cache path in `bb plugin source`.
