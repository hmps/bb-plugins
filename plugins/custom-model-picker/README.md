# custom-model-picker

A second model picker in the bb thread composer and the new-thread composer.
It shows only the models that you put in its setting. It also shows and sets
the reasoning level. The original bb picker stays in place. Fast mode stays in
the original picker. In a thread composer, a small ring on the right of the
picker shows how much of the context window the thread uses.

## What it does

- The picker shows as a composer action in the expanded and zen layouts.
- The button shows the provider icon, the model, and the current reasoning
  level, for example "Opus 5.5 High".
- The menu has four parts:
  - **Reasoning**: the levels that the catalog gives for the current model.
    The current level has a mark.
  - **Filter**: a text field. See [Filter](#filter).
  - **Favorites**: your favorite models, first, in the order that you added
    them.
  - **The other models**, in the order of the `models` setting, with a
    provider icon and name above each group.
- It gets the catalog from the machine that the composer uses:
  - In a thread, it uses the thread's environment.
  - In a new-thread composer, it follows the environment you chose. This is
    the same routing that the native picker uses.
- When you pick a model, the plugin calls `experimental_setSelection` on that
  composer and waits for the result. The picker then shows the model that the
  composer actually selected.
- When you pick a reasoning level, the plugin sends only the level. The
  composer keeps its provider and model. The picker then shows the level that
  the composer actually selected.
- If the composer selects a different model or level, the picker shows an
  error. It does not show a false success.
- If the call fails, the picker keeps the old display and shows the error.
- The plugin never sends a message. It never selects a model or a level by
  itself on mount, on load, or when you change a setting.

## Context ring

In a thread composer, a ring on the right of the picker shows how much of the
model context window the thread uses.

- The ring fills with the percent of the window that the thread uses.
- The ring is gray below 75%, uses the warning color from 75%, and uses the
  danger color from 90%.
- The ring button has a name for screen readers, for example "Context window
  42% used". If bb only estimates the usage, the name starts with
  "Estimated".
- Click, tap, or press Enter on the ring to open a small panel. The panel
  shows the percent used, the percent left, and the used and total tokens.
  Escape or a click outside closes it.
- The ring reads the usage with `threads.context` from the bb SDK. It reads
  again when the thread sends a usage event, when a run starts or ends, when
  the window gets focus, and when you open the panel. A running turn sends
  usage events as the context grows, so the ring changes during a run. The
  ring does not poll.
- When the composer moves to a different thread, the ring stops reading the
  old thread. It shows nothing until the new thread answers. A late answer
  for the old thread is ignored.
- If the thread reports no usage, or the read fails before a first value, the
  ring does not show. It never shows a false 0%. If a later read fails, the
  ring keeps the last value.
- The new-thread composer shows no ring, because no thread exists yet.
- The ring never selects a model and never sends a message.

## Favorites

Each model row has a star button. Click the star to add the model to the
favorites or to remove it. The plugin saves the list in the `favorites`
setting, so it stays after a reload.

- A favorite shows only once in the menu, in the Favorites group.
- The favorites do not add models to the menu. A favorite that the `models`
  setting does not show, or that the current machine does not have, shows as
  "not available here". Use its star to remove it.
- The default is no favorites.

## Filter

The filter field is between the reasoning levels and the model list.

- Type to show only the models that contain the text. The filter ignores case
  and spaces at the start and the end.
- The filter looks at the model name, the model id, the provider name and id,
  the route, and the `provider/model` key.
- It filters the Favorites group and the provider groups. It does not change
  their order, and the stars still work.
- The clear button (×) empties the field. If no model matches, the menu says
  so.
- Each open of the menu starts with an empty filter.
- The filter never selects a model and never sends a message. Enter does
  nothing.
- A mouse or keyboard open puts the cursor in the field. A touch open keeps
  the cursor in the message editor. Tap the field to type. When the menu
  closes, the cursor goes back to the message editor.

## Reasoning

- The menu shows only the levels that the catalog gives for the current model.
- The menu does not offer Max, Ultra, or Ultracode. If the composer already
  uses one of these levels, the button and the menu show it.
- If the catalog has no data for the current model, the menu shows "Unknown"
  and no levels.
- If the model has no reasoning setting, the menu says so.

## Settings

Open the plugin settings in bb, or use the CLI.

| Key         | Type           | Default | Description |
| ----------- | -------------- | ------- | ----------- |
| `models`    | multiline text | empty   | The models to show. |
| `favorites` | multiline text | empty   | The models to show first. The star buttons change this value. |

Write one `provider/model` key per line. You can also separate keys with
commas. Text after `#` is a comment. The picker shows the models in the order
of the list. An empty `models` setting shows every model in the catalog.

```text
# Fast models first
codex/gpt-6-luna
claude-code/claude-sonnet-5-5
claude-code/claude-opus-5-5
```

The provider id is the id that bb uses for the provider, for example
`claude-code` or `codex`. The model id is the model value in the catalog, not
the display name. A key that does not match a model on the current machine
shows in the menu under "Not in this catalog".

```sh
bb plugin config custom-model-picker
bb plugin config custom-model-picker set models "claude-code/claude-opus-5-5
codex/gpt-6-luna"
bb plugin config custom-model-picker unset models
bb plugin config custom-model-picker unset favorites
```

Both settings reject a key that is not in `provider/model` form.

## Limits

- The picker and the context ring show in the action area, on the left of
  the microphone button.
  bb gives plugins no slot in the left group next to the original picker, and
  plugin styles cannot move host elements. The picker does not use a
  workaround for this.
- The action area does not shrink, so the picker sets its own width. When
  the window is less than 390px wide, the picker shows only the provider icon.
  The button label and tooltip keep the model name. From 390px, the label
  width is at most `min(14rem, 100vw - 280px)`. These limits use the window
  width, not the composer width.
- The context ring button is 32px with a mouse and 36px on a touch screen.
  bb cuts plugin actions at 36px high, so a larger touch area is not possible.
- In the compact mobile layout, bb shows no composer actions and no original
  picker. This picker also does not show there. When you tap the editor, the
  composer expands and both pickers show. The context ring is also not in
  the compact layout, for the same reason. The bb indicator in the collapsed
  composer is not available to plugins.
- On a touch screen, a tap on the picker or in its menu does not move focus
  out of the editor. If the editor loses focus, the mobile composer collapses
  and removes the picker before the tap can open the menu. Thus the keyboard
  stays open while the menu is open. The bb microphone and send buttons use
  the same method. A mouse or a keyboard opens the menu with normal focus: the
  focus goes into the menu, and it goes back to the picker button when the
  menu closes. The context ring uses the same method.
- bb has no event for selection changes. The picker reads the selection again
  when it mounts, when the composer scope changes, when you open it, when the
  window gets focus, and when a turn ends. A change in the original picker
  shows in this picker at the next of these points.
- In a thread, a pick of a model from a different provider starts a handoff,
  as in the original picker. The menu marks these models with "handoff". bb
  adds the handoff block to the draft, and the next send starts a new thread.
- The plugin does not register in the queued-message editor or in side chats.
  `experimental_setSelection` rejects in those composers.
- A thread with no environment uses the server's default host for the catalog.
- If a provider fails to load, the menu shows its error and tries again when
  you open the menu. The models that loaded stay on screen during this.
- The picker does not show fast mode. Use the original picker for it.
- The host `experimental_ProviderModelPicker` component has no filter, so this
  plugin uses its own menu with the host styles.

## Build and install

Run these commands in this folder.

```sh
npm install --legacy-peer-deps
npm run typecheck
npm test
bb plugin build
bb plugin install . --yes
```

npm needs `--legacy-peer-deps`: without it, npm 10 stops with an internal
error in the peer set of the plugin SDK.

After a change, run `bb plugin build` and `bb plugin reload custom-model-picker`.
