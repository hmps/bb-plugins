// Child Thread Split — an "Open in split" icon button on the active child
// thread rows above the composer and on child thread pills in generated
// message headers. One app overlay owns the React state and portals each
// button into a span it inserts beside the host element.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ChildThreadSplitOverlay } from "./src/SplitOverlay";
import "./app.css";

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "open-in-split",
    component: ChildThreadSplitOverlay,
  });
});
