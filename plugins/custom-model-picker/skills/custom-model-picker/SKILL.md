---
name: custom-model-picker
description: Configure the Custom Model Picker plugin, which shows a short list of models, favorites, and a reasoning control in the bb composers. Use it when the user asks to change which models or favorites the extra composer model menu shows.
---

# Custom Model Picker

The plugin adds a second model menu to the thread and new-thread composers.
The menu shows only the models in the `models` setting. The models in the
`favorites` setting show first. The menu also shows and sets the reasoning
level of the composer.

## Read the settings

```sh
bb plugin config custom-model-picker
```

## Change the shown models

1. Find the provider and model ids. Use the model value from the catalog, not
   the display name.
2. Write one `provider/model` key per line. The menu keeps this order.
3. Set the value:

```sh
bb plugin config custom-model-picker set models "claude-code/claude-opus-5-5
codex/gpt-6-luna"
```

To show every model again, unset the value:

```sh
bb plugin config custom-model-picker unset models
```

## Change the favorites

The user normally changes favorites with the star buttons in the menu. To set
them from the CLI, use the same key form:

```sh
bb plugin config custom-model-picker set favorites "codex/gpt-6-luna"
bb plugin config custom-model-picker unset favorites
```

## Rules

- Do not select a model or a reasoning level for the user. The plugin changes
  a composer only when the user picks a value in the menu.
- Both settings reject a key that is not in `provider/model` form.
- A favorite does not add a model to the menu. A favorite that the `models`
  setting does not show is marked "not available here".
- A key with no model on the current machine shows under "Not in this catalog"
  in the menu. It is not an error.
- The menu does not offer the Max, Ultra, or Ultracode reasoning levels.
- Fast mode stays in the original bb picker.
