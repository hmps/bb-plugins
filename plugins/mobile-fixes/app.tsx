// bb-plugin-mobile-fixes — frontend entry.
//
// Phone fixes for the thread composer. Each feature lives in its own module
// with its own stylesheet:
//   - src/editor.tsx: Codex-style editor (one row, grows to five, expand
//     button, full-height mode).
//   - src/status-bars.tsx: hideable status bars above the composer.
//   - src/voice.ts: first-tap voice buttons, focus after dictation, no empty
//     row while recording.
// The features meet in the composer's action row and in the status bars, so
// they ship as one plugin.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ExpandToggle, largeMode } from "./src/editor";
import { ROOT_CLASS } from "./src/shared";
import { barsOpen, StatusBarsToggle } from "./src/status-bars";
import { mountVoiceFixes } from "./src/voice";
import "./src/shared.css";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "mobile-fixes",
    mount({ signal }) {
      const root = document.documentElement;
      root.classList.add(ROOT_CLASS);
      largeMode.sync();
      barsOpen.sync();
      mountVoiceFixes(signal);
      const clear = () => {
        root.classList.remove(ROOT_CLASS, largeMode.className, barsOpen.className);
      };
      signal.addEventListener("abort", clear, { once: true });
      return clear;
    },
  });

  app.composer.customize({
    id: "mobile-fixes",
    scopes: ["thread", "side-chat"],
    actions: [
      { id: "status-bars", component: StatusBarsToggle },
      { id: "expand", component: ExpandToggle },
    ],
  });
});
