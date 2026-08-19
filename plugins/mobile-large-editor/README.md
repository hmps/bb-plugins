# mobile-large-editor

Adds the "Make prompt box larger" toggle to thread composers on mobile.

## Why

bb's prompt box has a zen mode (the `Maximize2` button). The new-thread
composer shows it on every screen size. The thread follow-up composer hides it
on viewports up to 767px: the mobile composer expands by focus and gets a
`compact` config, and `enterZenMode` returns early when that config is set.
The plugin SDK has no API to toggle zen mode, so this plugin rebuilds the part
that matters.

## What it does

- Registers a composer action button (`thread` and `side-chat` scopes). bb
  renders it next to the mic and send buttons. The button only shows on
  compact viewports in the expanded layout; desktop keeps the stock button.
- When on, the follow-up editor gets a fixed height of half the visible app
  shell (`--bb-shell-height`, which follows the visual viewport while the
  keyboard is open) and scrolls inside that area.
- The mode is transient, like the stock thread zen mode: it turns off when a
  message is submitted. Focus stays in the editor when you tap the button.
- Enter already inserts a newline on coarse pointers, so key handling is
  unchanged.

## Install

```sh
bb plugin install mobile-large-editor@hmps
```

## Develop

```sh
npm install
bb plugin build
bb plugin install . --yes
```
