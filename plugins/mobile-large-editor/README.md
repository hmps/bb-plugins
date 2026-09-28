# mobile-large-editor

A Codex-style thread composer on mobile (viewports up to 767px). Desktop is
unchanged.

## What it does

- While empty, the editor is one row high with the short placeholder "Ask a
  follow-up".
- The editor grows with the text up to five rows. After that, it scrolls.
- At five rows, an expand button shows in the top-right corner of the editor.
- The button opens a full-height editor: the editor fills the visible app
  shell (`--bb-shell-height`, which follows the visual viewport while the
  keyboard is open), and the status bars above the composer are hidden. The
  same button collapses it.
- The full-height mode is transient, like the stock thread zen mode: it turns
  off when a message is submitted. Focus stays in the editor when you tap the
  button.
- Enter already inserts a newline on coarse pointers, so key handling is
  unchanged.

## Why

bb's prompt box has a zen mode (the `Maximize2` button). The thread follow-up
composer hides it on viewports up to 767px: the mobile composer expands by
focus and gets a `compact` config, and `enterZenMode` returns early when that
config is set. The plugin SDK has no API to toggle zen mode, so this plugin
rebuilds it with a class on `<html>` and CSS.

## How

- The button is a composer action (`thread` and `side-chat` scopes). bb
  renders it in the action row; `app.css` moves it to the top-right corner.
- The editor's stock sizes are inline styles, so the height rules use
  `!important`. They apply only while the plugin's content script has put its
  class on `<html>`, so reload, disable, and removal restore stock behavior.

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
