Pick a model and a reasoning level from a short list that you choose, in the
thread composer and the new-thread composer.

## What you get

- A compact model menu in the composer actions, with the bb provider icons.
- The current model and reasoning level on the menu button.
- A reasoning control for the current model. Max, Ultra, and Ultracode are not
  offered.
- A Favorites group at the top. Click the star on a model to add or remove it.
- Only the models in your list, in your order. An empty list shows every model.
- In a thread, a small ring on the right of the menu shows how much of the
  context window the thread uses. Open it to see the percent and the tokens.

## How it works

The menu reads the model catalog from the machine that the composer uses. When
you pick a model or a level, the plugin asks the composer to select it and
shows what the composer actually selected. If the composer selects something
different, the menu shows an error.

The plugin never sends a message and never selects a model or a level by
itself. Fast mode stays in the original picker.

The context ring reads the usage of the current thread from bb. It updates
during a run and when you open it. It does not show in the new-thread composer,
or when bb reports no usage, so it never shows a false 0%.

In the compact mobile layout, bb shows no composer actions, so the menu shows
when the composer expands. On a touch screen, the keyboard stays open while
the menu is open, so the composer does not collapse.

## Settings

Put one `provider/model` key per line in **Shown models**, for example
`claude-code/claude-opus-5-5`. Lines that start with `#` are comments.

**Favorite models** holds the favorites. The star buttons change it. It is
empty by default.
