import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { t3sidebarRpcContract } from "./server";
import {
  NEUTRAL_COLOR_ID,
  PROJECT_COLOR_CHANNEL,
  type ProjectColorSignal,
} from "./project-colors";

/**
 * Colour id per project id, read once and then kept current by the realtime
 * channel. A project the map does not know reads as neutral, so the sidebar
 * paints a plain badge while the first read is in flight.
 */
export function useProjectColors(): ReadonlyMap<string, string> {
  const rpc = useRpc<typeof t3sidebarRpcContract>();
  const [colors, setColors] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  // Responses can land out of order, and an older list would restore a colour
  // the user just changed. Only the newest request may write.
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    const result = await rpc.call("listProjectColors", {});
    if (seq !== requestSeq.current) return;
    setColors(
      new Map(
        result.projects.map((project) => [project.projectId, project.colorId]),
      ),
    );
  }, [rpc]);

  useEffect(() => {
    // A failed read leaves every project neutral, which is the same thing the
    // sidebar draws before the first read lands.
    void refresh().catch(() => {});
  }, [refresh]);

  // The signal carries the new colour, so one project changing costs no read.
  useRealtime(PROJECT_COLOR_CHANNEL, (payload) => {
    if (!isProjectColorSignal(payload)) return;
    setColors((previous) => {
      const next = new Map(previous);
      next.set(payload.projectId, payload.colorId ?? NEUTRAL_COLOR_ID);
      return next;
    });
  });

  return colors;
}

function isProjectColorSignal(payload: unknown): payload is ProjectColorSignal {
  if (typeof payload !== "object" || payload === null) return false;
  const signal = payload as ProjectColorSignal;
  return (
    typeof signal.projectId === "string" &&
    (signal.colorId === null || typeof signal.colorId === "string")
  );
}
