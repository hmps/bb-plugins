# PR Digest

A bb plugin that adds a homepage section with two lists:

- **Merged yesterday** — pull requests merged on the previous calendar day.
- **Review queue** — open pull requests that request your review.

Data comes from the `gh` CLI (`gh search prs`). Log in with `gh auth login` first.

## Settings

- **Merged PRs scope** — GitHub search qualifiers for the merged list. Default `involves:@me`. Use `org:acme` for a whole org.
- **Review queue extra qualifiers** — added to `review-requested:@me`. Example: `org:acme` or `team-review-requested:acme/core`.

Results cache for 5 minutes. The Refresh button forces a new fetch.

## CLI

```
bb pr-digest show [--refresh] [--json]
```

## Install

```
bb plugin install path:/path/to/bb-plugins --plugin pr-digest
```
