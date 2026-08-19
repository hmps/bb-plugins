// Spike: mount a React root from a content script and probe SDK hooks.
import { Component, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRpc,
  useSettings,
  useRealtimeConnectionState,
  experimental_useSidebarThreads,
  experimental_useSidebarThreadActions,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";

type Probe = { name: string; run: () => unknown };

function summarize(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "function") return "fn";
  if (typeof v !== "object") return JSON.stringify(v);
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .map((k) => {
      const x = o[k];
      if (Array.isArray(x)) return `${k}:[${x.length}]`;
      if (typeof x === "function") return `${k}:fn`;
      if (typeof x === "object" && x !== null) return `${k}:{…}`;
      return `${k}:${JSON.stringify(x)}`;
    })
    .join(",")}}`;
}

// Each hook runs in its own component so one failure does not stop the rest.
function HookProbe({ name, run, onResult }: Probe & { onResult: (s: string) => void }) {
  // Hooks must run unconditionally at top level: call run() directly.
  const value = run();
  const line = `${name}: OK ${summarize(value)}`;
  useEffect(() => onResult(line), [line, onResult]);
  return null;
}

class Boundary extends Component<
  { name: string; onResult: (s: string) => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: Error) {
    this.props.onResult(`${this.props.name}: FAIL ${e.message}`);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const probes: Probe[] = [
  { name: "useRpc", run: () => useRpc<typeof rpcContract>() },
  { name: "useBbContext", run: () => useBbContext() },
  { name: "useBbNavigate", run: () => useBbNavigate() },
  { name: "useSettings", run: () => useSettings() },
  { name: "useRealtimeConnectionState", run: () => useRealtimeConnectionState() },
  { name: "experimental_useSidebarThreads", run: () => experimental_useSidebarThreads() },
  { name: "experimental_useSidebarThreadActions", run: () => experimental_useSidebarThreadActions() },
];

function Spike() {
  const [lines, setLines] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const onResult = (s: string) =>
    setLines((prev) => {
      const name = s.split(":")[0];
      if (prev.some((p) => p.startsWith(`${name}:`))) return prev;
      return [...prev, s];
    });

  // Report once all probes have a line, or after 3s.
  useEffect(() => {
    if (done) return;
    if (lines.length >= probes.length) {
      setDone(true);
      return;
    }
    const t = setTimeout(() => setDone(true), 3000);
    return () => clearTimeout(t);
  }, [lines, done]);

  useEffect(() => {
    if (!done) return;
    const out = [...lines, `location: ${window.location.pathname}`];
    // Raw fetch so the report does not depend on useRpc working.
    void fetch("/api/v1/plugins/hook-spike/rpc/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lines: out }),
    }).then(
      (r) => console.log("[hook-spike] reported", r.status, out),
      (e) => console.error("[hook-spike] report failed", e, out),
    );
  }, [done]);

  return (
    <>
      {probes.map((p) => (
        <Boundary key={p.name} name={p.name} onResult={onResult}>
          <HookProbe {...p} onResult={onResult} />
        </Boundary>
      ))}
    </>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "hook-spike",
    mount({ signal }) {
      const host = document.createElement("div");
      host.id = "hook-spike-root";
      document.body.appendChild(host);
      const root = createRoot(host);
      root.render(<Spike />);
      const dispose = () => {
        root.unmount();
        host.remove();
      };
      signal.addEventListener("abort", dispose, { once: true });
      return dispose;
    },
  });
});
