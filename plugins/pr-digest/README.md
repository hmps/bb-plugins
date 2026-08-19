# PR Digest

A bb plugin that adds a **Pull requests** homepage section:

- **Merged yesterday** — pull requests merged on the previous calendar day.
- **Open pull requests** — every open PR, grouped by repo, with review state, draft flag, labels, and diff size.

Repositories come from the GitHub remotes of your bb projects. Data comes from the `gh` CLI (`gh pr list`). Log in with `gh auth login` first.

## Settings

- **Extra repositories** — comma-separated `owner/name` repos to include beside your bb projects.
- **Hide my own open PRs** — show only other people's open PRs.

Results cache for 5 minutes. The refresh button forces a new fetch.

## CLI

```
bb pr-digest show [--refresh] [--json]
```

## Install

```
bb plugin install path:/path/to/bb-plugins --plugin pr-digest
```
