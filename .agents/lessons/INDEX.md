# Lessons

Read the records whose scope matches your change. Legacy notes stay in
`.claude/LESSONS.md` (read-only).

| Record | Scope | Action |
| --- | --- | --- |
| [bb-spawn-remote-base-branch](bb-spawn-remote-base-branch.md) | `bb thread spawn` for workers and reviewers | Pass `--base-branch origin/<branch>` when the child can run on another machine. |
| [sdk-pin-npm-lag](sdk-pin-npm-lag.md) | `plugins/*/package.json` SDK pin | Pin the newest `@get-bb/plugin-sdk` that npm has; do not let `bb plugin types` pin the server's unpublished version. |
| [plugin-git-sha-pin-blocks-update](plugin-git-sha-pin-blocks-update.md) | `bb plugin install git:` for this repo | Install with a semver range and `--tag-prefix <id>/`; a SHA pin can only be replaced by a data-deleting remove. |
| [plugin-preview-harness-css](plugin-preview-harness-css.md) | Local screenshot harness for a plugin UI | Wrap each slot in `data-bb-plugin="<id>"` and load bb CSS before `dist/app.css`; else utilities silently drop. |
| [plugin-rollback-copy-path](plugin-rollback-copy-path.md) | Rollback copy before a git plugin update on Ethereal-Titan | Copy `~/.bb/plugins/cache/git/github.com/hmps/bb-plugins/<sha>`; the plugin data dir holds no source. |
| [bb-message-link-mid-turn](bb-message-link-mid-turn.md) | Opening a thread at a message (`messageSeq`, `#msg=`) | Link to the agent's last message of the turn; bb shows "Message not found" for a mid-turn one. |
| [sdk-fake-skips-server-limits](sdk-fake-skips-server-limits.md) | Server tests with `bb.sdk` stubs | Make each stub refuse what the server refuses, such as an events limit over 100. |
| [inbox-live-dismiss-advances](inbox-live-dismiss-advances.md) | Live browser checks of inbox actions | Make test items read and adjacent; check the title before each action; undo read marks after. |
