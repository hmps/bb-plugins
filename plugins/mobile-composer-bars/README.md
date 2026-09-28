# mobile-composer-bars

Hides the status bars above the thread composer on mobile behind a toggle.

## Why

On a phone, bb stacks status bars above the thread composer: background
commands, active child threads, the parent thread, and the changes summary.
With the keyboard open, they can take most of the space that is left for the
conversation.

## What it does

- On viewports up to 767px, it hides the status bars above the thread
  composer. The queued-messages panel and plugin slots stay visible.
- Registers a composer action button (`thread` scope). bb renders it next to
  the mic and send buttons while the composer is expanded. A badge shows the
  number of hidden items. Tap the button to show or hide the bars.
- The button does not show when there are no bars.
- The choice persists in `localStorage`, so it holds across threads and
  reloads. Focus stays in the editor when you tap the button.
- Desktop is unchanged.

## Install

```sh
bb plugin install mobile-composer-bars@hmps
```

## Develop

```sh
npm install
bb plugin build
bb plugin install . --yes
```
