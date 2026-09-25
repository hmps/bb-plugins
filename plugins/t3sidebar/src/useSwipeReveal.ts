import { useEffect, useRef, useState } from "react";

/** Movement before a touch commits to a direction. */
const LOCK_DISTANCE = 8;

/**
 * Swipe left to reveal a tray of `width` pixels behind a row, the way mail
 * apps hide row actions on touch screens.
 *
 * Touch only: a mouse or pen keeps hover controls. A touch that moves mostly
 * up or down is left to the browser, so the list still scrolls (pair the
 * handlers with `touch-action: pan-y`). Release past half the tray snaps
 * open; anything less snaps shut. A tap on the open row, or a touch anywhere
 * outside it, closes the tray.
 */
export function useSwipeReveal(width: number, enabled: boolean) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLLIElement>(null);
  const gesture = useRef<{
    x: number;
    y: number;
    base: number;
    axis: "x" | "y" | null;
  } | null>(null);
  // A swipe ends in a click on the row's link; this swallows it.
  const swallowClick = useRef(false);

  const isOpen = offset !== 0 && !dragging;
  const close = () => setOffset(0);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOffset(0);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [isOpen]);

  // A row that loses its actions (it started working, or it is archiving)
  // must not stay open on a tray it no longer has.
  useEffect(() => {
    if (!enabled) setOffset(0);
  }, [enabled]);

  const end = () => {
    const g = gesture.current;
    gesture.current = null;
    // Read the axis, not `dragging`: the state may not have rendered yet.
    if (g?.axis !== "x") return;
    setDragging(false);
    setOffset((current) => (current < -width / 2 ? -width : 0));
  };

  const handlers = {
    onPointerDown(event: React.PointerEvent<HTMLElement>) {
      swallowClick.current = false;
      if (!enabled || event.pointerType !== "touch") return;
      gesture.current = {
        x: event.clientX,
        y: event.clientY,
        base: offset,
        axis: null,
      };
    },
    onPointerMove(event: React.PointerEvent<HTMLElement>) {
      const g = gesture.current;
      if (!g) return;
      const dx = event.clientX - g.x;
      const dy = event.clientY - g.y;
      if (g.axis === null) {
        if (Math.abs(dx) < LOCK_DISTANCE && Math.abs(dy) < LOCK_DISTANCE) return;
        g.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (g.axis === "x") {
          setDragging(true);
          swallowClick.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }
      }
      if (g.axis !== "x") return;
      setOffset(Math.min(0, Math.max(-width, g.base + dx)));
    },
    onPointerUp: end,
    onPointerCancel: end,
    onClickCapture(event: React.MouseEvent<HTMLElement>) {
      if (!swallowClick.current && offset === 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (!swallowClick.current) close();
      swallowClick.current = false;
    },
  };

  return {
    rootRef,
    offset,
    dragging,
    isOpen,
    close,
    handlers,
    /** Mount the tray only while some of it can show. */
    trayVisible: offset !== 0,
  };
}
