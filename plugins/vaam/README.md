# Vaam

A "Vaam" page in the BB sidebar. Its first section is a **Beads** viewer for
the vaam monorepo.

- A tree of beads, built from each bead's parent. Epics start expanded.
- Filters: text (title or id), status chips, and a "Show closed" toggle.
- A detail pane: description, design, acceptance criteria, notes, labels,
  blockers, and children.
- **Assign agent** opens BB's own new-thread composer, pre-filled with a
  prompt for that bead. You pick the provider, model, and permission mode in
  the dialog; the plugin creates the thread and opens it.

The section strip at the top holds Beads today. More sections go beside it.

## How it reads the data

The plugin runs the [beads](https://github.com/steveyegge/beads) CLI (`bd`)
in the beads root and parses its JSON. There is no database of its own. The
list is cached for 5 seconds, so filtering and expanding never re-run `bd`.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Beads root | `/Users/hmps/dev/vaam/monorepo/vaam-main` | The directory `bd` runs in. A leading `~` expands. |
| Beads CLI path | `bd` | Where to find `bd`. Set an absolute path when it is not on the server's `PATH`. |

The plugin matches this root against your BB projects and seeds the composer
with the project that holds it. No match means the composer opens with no
project preselected.

## Install

```
bb plugin install ./plugins/vaam --yes
```

## Develop

```
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc
bb plugin build
```
