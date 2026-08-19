// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  loadPluginApp,
  mountPluginContentScripts,
} from "@get-bb/plugin-sdk/testing/app";

function press(type: "pointerdown" | "mousedown", target: Element, init: MouseEventInit = {}) {
  const Ctor = type === "pointerdown" ? PointerEvent : MouseEvent;
  const event = new Ctor(type, { bubbles: true, cancelable: true, button: 0, ...init });
  // dispatchEvent returns false when preventDefault was called.
  return target.dispatchEvent(event);
}

describe("ios-composer-touch content script", () => {
  it("cancels pointerdown and mousedown defaults on the composer submit button only", async () => {
    document.body.innerHTML = `
      <div data-promptbox-submit-group="">
        <button type="submit" data-promptbox-submit-action=""><svg></svg></button>
      </div>
      <button type="button" id="other">Other</button>
    `;
    const app = await loadPluginApp(() => import("./app"));
    const scripts = await mountPluginContentScripts(app, {
      pluginId: "ios-composer-touch",
      generation: 1,
    });
    const submit = document.querySelector("[data-promptbox-submit-action]")!;
    const svg = submit.querySelector("svg")!;
    const other = document.getElementById("other")!;

    expect(document.documentElement.classList.contains("bb-ios-composer-touch")).toBe(true);
    expect(press("pointerdown", submit)).toBe(false);
    expect(press("mousedown", submit)).toBe(false);
    expect(press("pointerdown", svg)).toBe(false); // tap lands on the icon inside
    expect(press("pointerdown", submit, { button: 2 })).toBe(true); // secondary button
    expect(press("pointerdown", other)).toBe(true);
    expect(press("mousedown", other)).toBe(true);

    await scripts.lifecycle.dispose();
    expect(document.documentElement.classList.contains("bb-ios-composer-touch")).toBe(false);
    expect(press("pointerdown", submit)).toBe(true);
    expect(press("mousedown", submit)).toBe(true);
  });
});
