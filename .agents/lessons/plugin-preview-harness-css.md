# Screenshot harness for a plugin UI outside bb

date: 2026-11-25
status: verified
scope: local preview harnesses that render a plugin slot (`renderSlot` from `@get-bb/plugin-sdk/testing/app`) with bb's host CSS, for screenshots
keywords: preview, screenshot, harness, tailwind, @layer, data-bb-plugin, renderSlot
evidence: plugins/inbox 0.1.3: with bb.css and `dist/app.css` in one Vite bundle, `size-16` rendered 30px and `mt-7` rendered 0. Two causes: `dist/app.css` scopes every utility under `:where([data-bb-plugin="<id>"], [data-bb-plugin-root]…)`, and the harness had no such ancestor; and app.css came first in the bundle, so bb's later `@layer base` ranked above the plugin's `@layer utilities`.
action: Give each slot container `data-bb-plugin="<plugin id>"`, and import bb's CSS before `dist/app.css` (both from the entry module, in that order). Then compare one known class, such as `getComputedStyle(el).width` for a `size-*` element, before you trust a screenshot.
verify: in the harness page, an element with `mt-7` has a computed `margin-top` of 28px.
retire-when: the SDK ships a preview or screenshot tool that applies the host CSS and the plugin scope.
