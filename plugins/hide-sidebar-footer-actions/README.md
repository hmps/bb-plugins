# Hide sidebar footer actions

This frontend-only plugin hides two buttons in the sidebar footer:

- **Remote access** (the connect plugin's footer action)
- **Report a bug**

The Settings button and the update badge stay visible.

The rule lives in `app.css` and applies only while the content script has put
`bb-hide-sidebar-footer-actions` on `<html>`. The script removes that class on
abort or dispose, so a reload, disable, or removal restores the buttons.

Install from the `hmps` marketplace:

```sh
bb marketplace add git:https://github.com/hmps/bb-plugins.git@main
bb plugin install hide-sidebar-footer-actions@hmps
```

Or from this directory:

```sh
bb plugin install . --yes
```
