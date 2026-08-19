/**
 * Backend RPC over raw fetch.
 *
 * The palette mounts its own React root from a content script, and the SDK's
 * `useRpc` hook only works inside a plugin slot component. A same-origin fetch
 * against the plugin's own RPC route is the supported path from here.
 */
import type { rpcContract } from "../server";

const BASE = "/api/v1/plugins/command-palette/rpc";

type Envelope<T> = { ok: true; result: T } | { ok: false; error: unknown };

export type ListThreadsResult = ReturnType<
  (typeof rpcContract)["listThreads"]["output"]["parse"]
>;
export type ListProjectsResult = ReturnType<
  (typeof rpcContract)["listProjects"]["output"]["parse"]
>;
export type PaletteThread = ListThreadsResult["threads"][number];
export type PaletteProject = ListProjectsResult["projects"][number];

async function call<T>(method: string, input: unknown): Promise<T> {
  const response = await fetch(`${BASE}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const envelope = (await response.json()) as Envelope<T>;
  if (!envelope.ok) throw new Error(describe(envelope.error));
  return envelope.result;
}

function describe(error: unknown): string {
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return JSON.stringify(error);
}

export const rpc = {
  listThreads: () => call<ListThreadsResult>("listThreads", null),
  listProjects: () => call<ListProjectsResult>("listProjects", null),
  threadAction: (threadId: string, action: string) =>
    call<{ ok: true }>("threadAction", { threadId, action }),
  snooze: (threadId: string, snoozedUntil: number) =>
    call<{ ok: boolean }>("snooze", { threadId, snoozedUntil }),
};
