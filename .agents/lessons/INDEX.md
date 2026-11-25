# Lessons

Read the records whose scope matches your change. Legacy notes stay in
`.claude/LESSONS.md` (read-only).

| Record | Scope | Action |
| --- | --- | --- |
| [bb-spawn-remote-base-branch](bb-spawn-remote-base-branch.md) | `bb thread spawn` for workers and reviewers | Pass `--base-branch origin/<branch>` when the child can run on another machine. |
| [sdk-pin-npm-lag](sdk-pin-npm-lag.md) | `plugins/*/package.json` SDK pin | Pin the newest `@get-bb/plugin-sdk` that npm has; do not let `bb plugin types` pin the server's unpublished version. |
