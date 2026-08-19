# iOS Status Bar

This frontend-only plugin fixes one iOS 26 problem in the bb web app: in a
Safari tab the area under the status bar shows black instead of the app
background.

It cannot fix the gradient bar in the Home Screen app. iOS takes
`apple-mobile-web-app-status-bar-style` from the served HTML when you add the
app to the Home Screen. bb serves `black-translucent`, and a plugin cannot
change the served HTML. That fix must land in bb's `index.html`.

## Why

iOS 26 Safari ignores `<meta name="theme-color">`. To tint the status bar and
the toolbar it hit-tests one point per edge (viewport center, 4 px in), takes
the topmost fixed or sticky element there, and uses its `background-color`.
bb has no such element, so Safari falls back to the canvas color: black in a
dark color scheme. bb's dim overlays and the sidebar drawer do sit at that
point, so they can turn the bars dark or gray, and the color sticks.

The plugin appends two fixed, pointer-transparent rails, one at the top and
one at the bottom, with the maximum z-index and bb's `--background` color.
They cover only the safe-area zone the system bar already paints (16 px floor
in a Safari tab), so they never overdraw content. Safari samples them on every
edge, whatever bb shows.

The plugin only runs on iPhone and iPad. Other clients get no DOM change.

## Install

From the `hmps` marketplace:

```sh
bb marketplace add git:https://github.com/hmps/bb-plugins.git@main
bb plugin install ios-status-bar@hmps
```

Or from this directory:

```sh
bb plugin install . --yes
```

## Known limits

- After a runtime theme change WebKit may not repaint the bar until a scroll
  or reload (WebKit 306074, 309956).
- The Home Screen app gradient needs a bb change; see the top of this file.
