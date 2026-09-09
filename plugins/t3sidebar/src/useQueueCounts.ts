import { useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { t3sidebarRpcContract } from "./server";
import { QUEUE_CHANNEL, type QueueCountSignal } from "./inbox";

/**
 * Queued-message counts, keyed by thread id.
 *
 * The sidebar's thread view has no queue field, so the plugin's own backend
 * reads it. Each thread is asked for once; after that the server pushes a
 * new count on the realtime channel whenever bb reports a queue change. A
 * thread that was never asked for reads as zero, which draws nothing.
 */
export function useQueueCounts(
  threads: readonly PluginSidebarThread[],
): ReadonlyMap<string, number> {
  const rpc = useRpc<typeof t3sidebarRpcContract>();
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  // Ids already requested, so a re-render never re-asks for a known thread.
  const requested = useRef(new Set<string>());

  useEffect(() => {
    const fresh = threads
      .map((thread) => thread.id)
      .filter((id) => !requested.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) requested.current.add(id);
    const applyResults = (entries: Array<{ threadId: string; count: number }>) =>
      setCounts((previous) => {
        const next = new Map(previous);
        for (const { threadId, count } of entries) {
          next.set(threadId, count);
        }
        return next;
      });
    // One rpc call per at most 500 ids: the queueCounts contract caps a
    // single batch, and a sidebar with more threads than that would
    // otherwise fail every call and re-ask the same oversized batch forever.
    for (let start = 0; start < fresh.length; start += 500) {
      const batch = fresh.slice(start, start + 500);
      rpc
        .call("queueCounts", { threadIds: batch })
        .then((result) => applyResults(result.counts))
        .catch(() => {
          // Let a failed batch be asked for again on the next thread change.
          for (const id of batch) requested.current.delete(id);
        });
    }
  }, [rpc, threads]);

  useRealtime(QUEUE_CHANNEL, (payload) => {
    if (!isQueueCountSignal(payload)) return;
    const { threadId, count } = payload;
    requested.current.add(threadId);
    setCounts((previous) => {
      if (previous.get(threadId) === count) return previous;
      const next = new Map(previous);
      next.set(threadId, count);
      return next;
    });
  });

  return counts;
}

function isQueueCountSignal(payload: unknown): payload is QueueCountSignal {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as QueueCountSignal).threadId === "string" &&
    typeof (payload as QueueCountSignal).count === "number"
  );
}
