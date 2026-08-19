# Command Palette

A ⌘K palette for BB. It searches your threads, opens one, starts a new thread,
and runs the common thread actions without leaving the keyboard.

## Shortcut

Press `⌘K` (`Ctrl+K` on Windows and Linux) anywhere in the BB app. Press it
again, or `Esc`, to close the palette.

## What it does

- **Search threads.** Type to match a thread title or its project name. Press
  `Enter` to open the thread.
- **Start a thread.** "New thread" opens the composer. "New thread in
  \<project\>" opens the composer inside that project.
- **Run thread actions.** Press `Tab` or `→` on a highlighted thread to see its
  actions: Open, Pin / Unpin, Mark read / unread, Archive, Settle / Unsettle,
  Snooze, and Unsnooze. Press `←` or `Backspace` on an empty input to go back.

Pin and read actions keep the palette open and refresh the list. Every other
action closes it.

## What it needs

- BB `>=0.39`.
- The **t3sidebar** plugin, but only for Settle, Unsettle, Snooze, and Unsnooze.
  That plugin owns the settled / snoozed state. When it is not installed or not
  enabled, the palette hides those actions and everything else keeps working.

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
