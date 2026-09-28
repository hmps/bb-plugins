# mobile-fixes

Phone fixes for the bb thread composer (viewports up to 767px). Desktop is
unchanged. This plugin replaces `mobile-large-editor` and
`mobile-composer-bars`.

## What it does

### Editor (`src/editor.tsx`)

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

bb has its own zen mode, but the thread follow-up composer hides it on
viewports up to 767px, and the plugin SDK has no API to toggle it. A class on
`<html>` drives the full-height mode instead.

### Status bars (`src/status-bars.tsx`)

- Hides the status bars above the thread composer: background commands, child
  threads, the parent thread, and the changes summary. The queued-messages
  panel and plugin slots stay visible.
- A composer button with a badge shows the number of hidden items. Tap it to
  show or hide the bars. The button does not show when there are no bars.
- The choice persists in `localStorage`.

### Voice (`src/voice.ts`)

- Voice buttons work on the first tap on touch screens: the mic, and the
  recording bar's stop and cancel buttons. bb cancels `pointerdown` on the mic
  but not `mousedown`, and the recording buttons have no guard. On iOS,
  `mousedown` moves focus out of the editor, the keyboard closes, and the
  click misses. A capture-phase listener cancels both events, as bb already
  does for the send button. The click still fires.
- While a recording runs with an empty editor, the card shows only the
  recording bar (no empty text row). With text, the text stays above the bar.
- bb makes the editor read-only while it records, so the editor loses focus.
  When the recording ends, the plugin focuses the editor again, so the
  transcript shows in the expanded composer.

## How

- The buttons are composer actions (`thread` and `side-chat` scopes). bb
  renders them in the action row; `src/editor.css` moves the expand button to
  the top-right corner.
- All CSS applies only while the content script has put `bb-mobile-fixes` on
  `<html>`, so reload, disable, and removal restore stock behavior at once.
- The editor's stock sizes are inline styles, so the height rules use
  `!important`.

## Install

```sh
bb plugin install mobile-fixes@hmps
```

## Develop

```sh
npm install
bb plugin build
bb plugin install . --yes
```
