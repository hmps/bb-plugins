import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { fields, type Totals } from "./contract";
export { fields } from "./contract";
export const NOW = new Date(2026, 10, 12, 12).getTime();
export const thread = makeThreadResponse({
  id: "thr_test", projectId: "proj_test", providerId: "codex", title: "Usage test",
  createdAt: NOW + 1, updatedAt: NOW + 1,
});
type Event = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];
export function event(seq: number, count: number, session = "session-a"): Extract<Event, { type: "thread/tokenUsage/updated" }> {
  const total = Object.fromEntries(fields.map((f) => [f, count])) as Totals;
  return { id: `event-${seq}`, threadId: thread.id, scope: { kind: "thread" }, seq, createdAt: NOW,
    type: "thread/tokenUsage/updated", data: { providerThreadId: session, tokenUsage: { total, last: total, modelContextWindow: null } } };
}
export function turn(seq: number, model = "model-a"): Extract<Event, { type: "client/turn/requested" }> {
  return {
    id: `turn-${seq}`, threadId: thread.id, scope: { kind: "thread" }, seq, createdAt: NOW,
    type: "client/turn/requested",
    data: {
      direction: "outbound", initiator: "user", input: [], requestId: `request-${seq}`,
      source: "tell", senderThreadId: null, request: { method: "turn/start", params: {} },
      execution: { model, permissionMode: "full", reasoningLevel: "medium", serviceTier: "default", source: "client/turn/requested" },
      target: { kind: "new-turn" },
    },
  };
}
