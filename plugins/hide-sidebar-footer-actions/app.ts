import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";

// The stylesheet only applies while this class is on <html>, so a reload,
// disable, or removal restores the buttons even before the CSS is unloaded.
const ROOT_CLASS = "bb-hide-sidebar-footer-actions";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "hide-footer-actions",
    mount({ signal }) {
      const root = document.documentElement;
      const clear = () => root.classList.remove(ROOT_CLASS);
      root.classList.add(ROOT_CLASS);
      signal.addEventListener("abort", clear, { once: true });
      return clear;
    },
  });
});
