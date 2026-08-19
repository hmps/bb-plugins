// Spike 2: can a content-script root navigate the app?
import { definePluginApp } from "@get-bb/plugin-sdk/app";

const base = "/api/v1/plugins/hook-spike/rpc";
async function rpc<T>(method: string, input: unknown): Promise<T> {
  const r = await fetch(`${base}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const j = (await r.json()) as { ok: boolean; result?: T; error?: unknown };
  if (!j.ok) throw new Error(JSON.stringify(j.error));
  return j.result as T;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function activeRowId(): string | null {
  const el = document.querySelector(
    '[data-sidebar-thread-id][aria-current], [data-sidebar-thread-id][data-active="true"], [data-sidebar-thread-id].active',
  );
  return el?.getAttribute("data-sidebar-thread-id") ?? null;
}

async function run(signal: AbortSignal) {
  const lines: string[] = [];
  const log = (s: string) => lines.push(s);
  try {
    const start = location.pathname;
    log(`start: ${start} title="${document.title}"`);
    const t = await rpc<{ threadId: string | null; projectId: string | null; title: string | null }>(
      "newestThread",
      null,
    );
    log(`newest: ${JSON.stringify(t)}`);
    if (!t.threadId) return;
    if (start.includes(t.threadId)) log("already on newest thread; results may be weak");

    // Option 2: pushState + popstate
    const target = t.projectId
      ? `/projects/${t.projectId}/threads/${t.threadId}`
      : `/threads/${t.threadId}`;
    history.pushState({}, "", target);
    dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    await sleep(1500);
    log(
      `opt2 pushState+popstate: path=${location.pathname} title="${document.title}" activeRow=${activeRowId()} hasThreadChat=${!!document.querySelector('[data-thread-id="' + t.threadId + '"]')}`,
    );

    // Go back home before option 3
    history.pushState({}, "", "/");
    dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    await sleep(1000);
    log(`back: path=${location.pathname}`);

    // Option 3: server-side bb.sdk.threads.open
    const r = await rpc<{ result: string }>("openThread", { threadId: t.threadId });
    await sleep(1500);
    log(`opt3 sdk.threads.open: result=${r.result} path=${location.pathname} title="${document.title}"`);

    // Restore
    history.pushState({}, "", start);
    dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  } catch (e) {
    log(`error: ${(e as Error).message}`);
  } finally {
    if (!signal.aborted) await rpc("report", { lines }).catch(() => {});
  }
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "hook-spike",
    mount({ signal }) {
      void run(signal);
    },
  });
});
