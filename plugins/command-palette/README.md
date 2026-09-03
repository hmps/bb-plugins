# Command Palette

Thread actions in bb's own quick palette. Press `Mod+Shift+P`, type, and act on
the thread you are looking at.

bb 0.40 owns the quick palette and its thread search, so this plugin no longer
draws a palette of its own. It registers rows the host renders, matches, and
orders, listed under the plugin's name beside bb's commands.

## What it adds

Every row acts on the thread in view. When no thread is in view, the rows do
not appear.

- **Pin thread**, **Unpin thread**
- **Mark thread read**, **Mark thread unread**
- **Archive thread**
- **Settle thread**, **Settle and archive thread**, **Unsettle thread**,
  **Unsnooze thread**
- **Snooze thread 1 hour**, **3 hours**, **until tomorrow 9:00**, **until next
  Monday 9:00**

A palette row has a fixed title and cannot read thread state, so both
directions of a toggle get their own row. Type "pin" to narrow to the pair.

Snooze needs a wake time and a row cannot ask for one, so each preset is its
own row. The wake time is computed when you pick the row, not at startup.

## What it needs

- BB `>=0.40`.
- The **t3sidebar** plugin, but only for Settle, Settle and archive, Unsettle,
  Snooze, and Unsnooze. That plugin owns the settled / snoozed state. The
  plugin probes for it once at startup; when it is not installed or not enabled,
  those rows stay hidden and everything else keeps working.

## Install

```sh
bb plugin install ./plugins/command-palette
```

## Develop

```sh
npm install
npm run typecheck
npm test
npm run build
```
