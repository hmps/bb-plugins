import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";

// The stylesheet only applies while this class is on <html>, so a reload,
// disable, or removal restores the page before the CSS is unloaded.
const ROOT_CLASS = "bb-ios-status-bar";
const RAIL_CLASS = "bb-ios-status-bar-rail";

// iPhone and iPad. iPadOS 13+ reports a Mac platform, so also accept a Mac
// with a touch screen.
function isIos(): boolean {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "ios-status-bar",
    mount({ signal }) {
      if (!isIos()) return;
      const root = document.documentElement;
      const rails = ["top", "bottom"].map((edge) => {
        const rail = document.createElement("div");
        rail.className = `${RAIL_CLASS} ${RAIL_CLASS}-${edge}`;
        rail.setAttribute("aria-hidden", "true");
        return rail;
      });

      const clear = () => {
        root.classList.remove(ROOT_CLASS);
        for (const rail of rails) rail.remove();
      };
      root.classList.add(ROOT_CLASS);
      document.body.append(...rails);
      signal.addEventListener("abort", clear, { once: true });
      return clear;
    },
  });
});
