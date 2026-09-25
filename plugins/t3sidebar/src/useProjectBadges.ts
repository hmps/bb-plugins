import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { t3sidebarRpcContract } from "./server";
import {
  NEUTRAL_COLOR_ID,
  PROJECT_COLOR_CHANNEL,
  PROJECT_LABEL_CHANNEL,
  type ProjectColorSignal,
  type ProjectLabelSignal,
} from "./project-colors";

export interface ProjectBadges {
  /** Colour id per project id. */
  colors: ReadonlyMap<string, string>;
  /** Badge text per project id, for projects the user renamed. */
  labels: ReadonlyMap<string, string>;
}

/**
 * Colour and label per project id, read once and then kept current by the
 * realtime channels. A project the maps do not know reads as a neutral badge
 * with its bb name, so the sidebar paints a plain badge while the first read
 * is in flight.
 */
export function useProjectBadges(): ProjectBadges {
  const rpc = useRpc<typeof t3sidebarRpcContract>();
  const [colors, setColors] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [labels, setLabels] = useState<ReadonlyMap<string, string>>(
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
    setLabels(
      new Map(
        result.projects.flatMap((project) =>
          project.label === null
            ? []
            : [[project.projectId, project.label] as const],
        ),
      ),
    );
  }, [rpc]);

  useEffect(() => {
    // A failed read leaves every project neutral, which is the same thing the
    // sidebar draws before the first read lands.
    void refresh().catch(() => {});
  }, [refresh]);

  // The signals carry the new value, so one project changing costs no read.
  useRealtime(PROJECT_COLOR_CHANNEL, (payload) => {
    if (!isProjectColorSignal(payload)) return;
    setColors((previous) => {
      const next = new Map(previous);
      next.set(payload.projectId, payload.colorId ?? NEUTRAL_COLOR_ID);
      return next;
    });
  });
  useRealtime(PROJECT_LABEL_CHANNEL, (payload) => {
    if (!isProjectLabelSignal(payload)) return;
    setLabels((previous) => {
      const next = new Map(previous);
      if (payload.label === null) next.delete(payload.projectId);
      else next.set(payload.projectId, payload.label);
      return next;
    });
  });

  return { colors, labels };
}

function isProjectColorSignal(payload: unknown): payload is ProjectColorSignal {
  if (typeof payload !== "object" || payload === null) return false;
  const signal = payload as ProjectColorSignal;
  return (
    typeof signal.projectId === "string" &&
    (signal.colorId === null || typeof signal.colorId === "string")
  );
}

function isProjectLabelSignal(payload: unknown): payload is ProjectLabelSignal {
  if (typeof payload !== "object" || payload === null) return false;
  const signal = payload as ProjectLabelSignal;
  return (
    typeof signal.projectId === "string" &&
    (signal.label === null || typeof signal.label === "string")
  );
}
