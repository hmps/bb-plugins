import type * as React from "react";

// Controls with a touch pointerdown whose compatibility mousedown is still to come.
const touchPressed = new WeakSet<EventTarget>();

/**
 * A touch tap on a control must not take focus from the composer editor. The
 * mobile composer collapses when the editor blurs, and a collapse unmounts
 * this action before the tap click can open or use the menu.
 *
 * A canceled pointerdown is not sufficient: iOS WebKit still sends the
 * compatibility mousedown, and that mousedown moves focus to the body. So the
 * guard also cancels the next mousedown on the same control, as the bb submit
 * button does. A real mouse press always starts with its own mouse
 * pointerdown, which clears the mark, so a touch that sent no mousedown (a
 * scroll, for example) cannot cancel a later mouse press. The click still fires.
 */
export const keepEditorFocus = {
  onPointerDown(event: React.PointerEvent) {
    if (event.pointerType !== "mouse" && event.button === 0) {
      touchPressed.add(event.currentTarget);
      event.preventDefault();
    } else {
      touchPressed.delete(event.currentTarget);
    }
  },
  onMouseDown(event: React.MouseEvent) {
    if (touchPressed.delete(event.currentTarget)) event.preventDefault();
  },
};

export function isEditable(element: Element | null): boolean {
  return (
    element instanceof HTMLElement &&
    (element.isContentEditable || element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
  );
}
