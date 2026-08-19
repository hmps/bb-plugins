# PR Digest

A bb plugin that adds a **Pull requests** homepage section:

- **Merged yesterday** — pull requests merged on the previous calendar day.
- **Open pull requests** — every open PR, grouped by repo, with review state, draft flag, labels, and diff size.

Repositories come from the GitHub remotes of your bb projects. Data comes from the `gh` CLI (`gh pr list`). Log in with `gh auth login` first.

Each row opens the pull request in the bb GitHub plugin (`/plugins/github/github/pulls/<owner>/<repo>/<n>`). Cmd-click or middle-click opens it in a new tab.

## Release

A second homepage section shows the release state of one Cloud Run service:

- **Live** — the revision that serves 100% of the traffic, with its commit and the time since deployment.
- **Built, not live** — revisions that are ready but hold no traffic, plus builds that run or failed.
- **Not yet released** — commits on `main` that are not live yet, each with a state: built, building, failed, or pending.

Data comes from the `gcloud` CLI and the `gh` CLI:

- `gcloud run services describe <service>` — the revision that holds the traffic.
- `gcloud run revisions list --service <service>` — newer revisions and their ready state.
- `gcloud builds describe <id>` and `gcloud builds list` — the commit behind each revision, plus build status and log links.
- `gh api repos/<repo>/compare/<live sha>...main` — the commits that are not released.

The plugin reads the Cloud Build id from the revision name (`<service>-build-<build id>`), then reads `COMMIT_SHA` from the build. Log in with `gcloud auth login` first.

Rows with a pull request number open in the bb GitHub plugin. Other rows open the commit on GitHub.

## Settings

- **Extra repositories** — comma-separated `owner/name` repos to include beside your bb projects.
- **Hide my own open PRs** — show only other people's open PRs.
- **Google Cloud project** — project that holds the Cloud Run service and the builds.
- **Cloud Run region** — region of the Cloud Run service.
- **Cloud Run service** — name of the Cloud Run service to report on.
- **Cloud Build region** — region of the Cloud Build builds.
- **Release repository** — `owner/name` repo that the service is built from.

Digest results cache for 5 minutes, release results for 2 minutes. The refresh button forces a new fetch.

## CLI

```
bb pr-digest show [--refresh] [--json]
bb pr-digest release [--refresh] [--json]
```

## Install

```
bb plugin install path:/path/to/bb-plugins --plugin pr-digest
```
