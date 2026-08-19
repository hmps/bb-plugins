# bb-plugins

Personal [bb](https://github.com/get-bb/bb) plugin marketplace.

## Use the marketplace

```sh
bb marketplace add git:https://github.com/hmps/bb-plugins.git@main
bb plugin install ios-composer-touch@hmps
bb plugin install hide-sidebar-footer-actions@hmps
```

`bb plugin update` moves installed plugins to newer releases inside the range
that `marketplace.json` lists.

## Plugins

| Plugin | What it does |
| --- | --- |
| [ios-composer-touch](plugins/ios-composer-touch) | First-tap send on iOS and larger composer hit areas. |
| [hide-sidebar-footer-actions](plugins/hide-sidebar-footer-actions) | Hides the Remote access and Report a bug buttons in the sidebar footer. |

## Layout

- `marketplace.json` — the catalog bb reads. Each entry points at a plugin
  directory in this repo with a semver range over `<plugin>/vX.Y.Z` tags.
- `.bb/plugins.json` — collection index. It enables
  `bb plugin install git:https://github.com/hmps/bb-plugins.git@main --plugin <name>`.
- `plugins/<name>/` — one plugin per directory with its own `package.json`.

## Release a plugin

1. Bump `version` in `plugins/<name>/package.json`.
2. Commit.
3. Tag `<name>/v<version>` and push the tag:

   ```sh
   git tag ios-composer-touch/v1.0.1
   git push origin main --tags
   ```

bb resolves the highest tag inside the range. Never move a published tag;
publish a new version instead.

## Develop

Each plugin builds standalone:

```sh
cd plugins/<name>
npm install
bb plugin build
bb plugin install . --yes
```
