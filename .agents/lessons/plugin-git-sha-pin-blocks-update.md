# Install git plugins with a semver range, not a SHA pin

date: 2026-11-25
status: verified
scope: `bb plugin install git:…` for plugins from this repository
keywords: bb plugin install, bb plugin update, range, pinned, remove it first, tag-prefix
evidence: inbox was installed as `git:…@43d76a9` (pinned). Installing 0.1.1 → `plugin id "inbox" is already installed … remove it first`; `bb plugin update inbox --range ^0.1.1` → `does not follow a version range`. `bb plugin remove` deletes the plugin's settings, secrets and stored data, so the 0.1.1 deploy stopped.
action: Install with a range and tag prefix (`git:https://github.com/hmps/bb-plugins.git@^X.Y.Z --subdirectory plugins/<id> --tag-prefix <id>/`) and push a `<id>/vX.Y.Z` tag for each release, so `bb plugin update <id>` can move it without a remove.
verify: `bb plugin source <id>` shows a `requested` ref that is a semver range, not a commit SHA.
retire-when: bb can repin a SHA-pinned git plugin in place.
