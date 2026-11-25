// One small store for the badge, the sidebar, and the page, so the three
// stay in sync. Every consumer reads the same module-level state; the first
// mount loads it, and each "items-changed" signal or reconnect reloads it.
// Requests made in the same tick collapse into one `items_list` call.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { DetectionStatus, Item, RpcContract } from "../contract";
import { errorText } from "../lib/inbox";

/** The realtime channel (ITEMS_CHANGED in contract.ts), inlined so zod stays out of the bundle. */
export const ITEMS_CHANGED_CHANNEL = "items-changed";

export type InboxRpc = ReturnType<typeof useRpc<RpcContract>>;

export interface InboxState {
  items: Item[];
  detection: DetectionStatus | null;
  loaded: boolean;
  error: string | null;
}

const INITIAL: InboxState = {
  items: [],
  detection: null,
  loaded: false,
  error: null,
};

let state: InboxState = INITIAL;
const listeners = new Set<() => void>();
let inFlight = false;
let again = false;
let scheduled = false;

function setState(next: InboxState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getState(): InboxState {
  return state;
}

async function load(rpc: InboxRpc): Promise<void> {
  inFlight = true;
  try {
    const result = await rpc.call("items_list", {});
    setState({
      items: result.items,
      detection: result.detection,
      loaded: true,
      error: null,
    });
  } catch (error) {
    // Keep the last good list; show the error beside it.
    setState({ ...state, loaded: true, error: errorText(error) });
  } finally {
    inFlight = false;
    if (again) {
      again = false;
      void load(rpc);
    }
  }
}

/** Ask for a reload. Calls in the same tick share one request. */
export function requestRefresh(rpc: InboxRpc): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    if (inFlight) again = true;
    else void load(rpc);
  });
}

/** Put an item the server returned into the list; a closed one leaves it. */
export function upsertItem(item: Item): void {
  const rest = state.items.filter((existing) => existing.id !== item.id);
  setState({
    ...state,
    items: item.status === "closed" ? rest : [...rest, item],
  });
}

/** Tests only: forget everything between cases. */
export function resetInboxStore(): void {
  state = INITIAL;
  inFlight = false;
  again = false;
  scheduled = false;
}

export function useInbox(): InboxState & { rpc: InboxRpc } {
  const rpc = useRpc<RpcContract>();
  const snapshot = useSyncExternalStore(subscribe, getState, getState);

  useEffect(() => {
    if (!state.loaded && !inFlight) requestRefresh(rpc);
  }, [rpc]);

  useRealtime(ITEMS_CHANGED_CHANNEL, () => requestRefresh(rpc));

  // Realtime signals are not replayed, so reload after a reconnect.
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (previous.current === "reconnecting" && connection === "connected") {
      requestRefresh(rpc);
    }
    previous.current = connection;
  }, [connection, rpc]);

  return { ...snapshot, rpc };
}

/** The current time, updated every minute, for ages and snooze wake-ups. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
