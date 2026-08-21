# GitHub+

GitHub issues and pull requests inside bb, with a **review dialog**: "Review
with agent" on a pull request opens a dialog that shows the review prompt —
editable — next to bb's own provider, model, reasoning, permission-mode, and
environment pickers. Nothing spawns until you press send.

This plugin is a fork of bb's builtin **github** plugin, version 0.2.1.

```sh
bb plugin install github-plus@hmps
```

## Disable the builtin github plugin

GitHub+ ships the whole builtin panel, mention providers, homepage section, and
CLI. Run both and you get two GitHub panels, duplicate `@`/`#` mention entries,
and two homepage sections.

Turn the builtin off before you use this one:

```sh
bb plugin disable github
```

The CLI command is `bb github-plus` (not `bb github`), so the two never collide
on the command name.

## The review dialog

1. Open a pull request in the GitHub+ panel, or in a thread's GitHub PR tab.
2. Press **Review with agent**.
3. The dialog loads the review prompt the builtin plugin would have sent, and
   puts it in an editable composer. Change the prompt, pick a provider and
   model, set reasoning and permission mode, choose the project and
   environment.
4. Press send. The thread spawns with exactly those settings and bb navigates
   to it.

Details:

- The draft is keyed per pull request (`github-plus:review:<repo>#<number>`), so
  an edited prompt for one PR never leaks into another.
- A failed spawn keeps the draft and shows a toast, so nothing you typed is
  lost.
- The composer's resolved selections go to the `spawnReview` rpc and straight
  into `threads.spawn`, `executionInputSources` included. Without that
  provenance the server drops your provider and model and falls back to the
  project defaults.
- Issues are unchanged: "Send agent" still spawns immediately.

## What else it does

- **Sidebar panel** (GitHub logo, full width): Issues and Pull requests tabs
  across every tracked repo, with a repo filter and a New issue form.
- **Issue detail**: markdown body, comments, comment box, status, assignee, and
  label editing, plus "Send agent". Deep-linkable through the URL hash:
  `#/issues/<owner>/<repo>/<number>`.
- **Pull request detail**: checks, reviews, inline review threads, per-file
  diffs.
- **Homepage section**: recent open issues with the same Send agent buttons.
- **Mentions**: `@` or `#` in any composer completes GitHub issues and PRs; the
  selected item's title, body, and state attach as agent context at send time.
- **`bb github-plus` CLI**: `repos`, `issues [repo]`, `prs [repo]`, `sync`.

## Auth

Uses the GitHub CLI. If `gh auth status` passes, the plugin works; otherwise it
reports needs-configuration. The plugin stores no tokens.

## Which repos are tracked

- Every bb project source whose checkout has a GitHub `origin` remote. That
  mapping is also how a spawn picks the project.
- Plus the `extraRepos` setting: a comma-separated `owner/repo` list.
- The `defaultProject` setting: where threads spawn for repos with no project.

```sh
bb plugin config github-plus set extraRepos "owner/repo, owner/other"
bb plugin reload github-plus
```

A background service refreshes the issue/PR cache every 5 minutes. The panel's
Refresh button, or `bb github-plus sync`, forces it.

## Differences from the builtin 0.2.1 source

bb 0.39.0's plugin runtime does not export `experimental_Diff`,
`experimental_FileLink`, `experimental_UrlLink`, or
`navigate.experimental_openUrl` — those arrived in plugin SDK 0.4.10, after
0.39.0. `components/sdk-compat.tsx` supplies local stand-ins:

- `UrlLink` — a plain `target="_blank"` anchor.
- `Diff` — a unified-diff renderer with add/remove shading.
- `FileLink` — plain text. bb 0.39.0 has no plugin API for opening a workspace
  file, so a diff file path is not clickable here.

Swap these back for the host components once bb ships a runtime that exports
them.

The shared `@bb/shared-ui` components are vendored under `components/ui/`,
`lib/`, and `hooks/`, as a standalone plugin needs.

## Development

```sh
cd plugins/github-plus
npm install
npm run typecheck
npm test
bb plugin build
bb plugin install . --yes
```
