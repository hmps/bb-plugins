// bb-plugin-ios-composer-touch — frontend entry.
//
// Ports the composer half of get-bb/bb#1673 as a plugin so it can run on a
// stock bb install:
//   1. The submit button no longer needs two taps on iOS. Capture-phase
//      pointerdown and mousedown listeners cancel the default focus transfer
//      for the composer submit button. That keeps the editor focused and the
//      keyboard open, so the button's click still lands and sends on the first
//      tap. Verified on a real iPhone: with both guards, pointerdown and
//      mousedown report defaultPrevented, the editor stays active through
//      click, and the form submits.
//   2. Coarse pointers on compact viewports get 44px hit areas (visual size
//      unchanged) for the composer submit/stop/voice slot and the inline-editor
//      cancel button (see app.css). The CSS applies only while ROOT_CLASS is on
//      <html>, so reload, disable, and removal restore stock behavior at once.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";

const ROOT_CLASS = "bb-ios-composer-touch";
const SUBMIT_BUTTON_SELECTOR =
  'button[type="submit"][data-promptbox-submit-action]';

function cancelSubmitFocusTransfer(event: PointerEvent | MouseEvent) {
  if (event.button !== 0) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest(SUBMIT_BUTTON_SELECTOR);
  if (!(button instanceof HTMLButtonElement) || button.disabled) return;
  // Focus transfer happens as the default action of pointerdown/mousedown,
  // before click. On iOS, moving focus from the editor to this button begins
  // keyboard dismissal and resizes the app shell, so the click lands where the
  // button used to be. Cancelling the default only suppresses that focus
  // transfer for this press; the click still fires and owns the submit.
  event.preventDefault();
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "composer-touch",
    mount({ signal }) {
      const root = document.documentElement;
      root.classList.add(ROOT_CLASS);
      const options = { capture: true, signal } as const;
      document.addEventListener("pointerdown", cancelSubmitFocusTransfer, options);
      document.addEventListener("mousedown", cancelSubmitFocusTransfer, options);
      const clear = () => {
        root.classList.remove(ROOT_CLASS);
        document.removeEventListener("pointerdown", cancelSubmitFocusTransfer, { capture: true });
        document.removeEventListener("mousedown", cancelSubmitFocusTransfer, { capture: true });
      };
      signal.addEventListener("abort", clear, { once: true });
      return clear;
    },
  });
});
