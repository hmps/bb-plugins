/**
 * Client-side navigation for a content-script root.
 *
 * The palette lives outside the host router, so it cannot use the SDK's
 * navigate hook. `pushState` plus a synthetic `popstate` is what the host
 * router listens to, and it moves only this client — unlike a server-side
 * `threads.open`, which moves every connected client.
 */

/** Route to a thread. bb always gives a thread a project, but stay defensive. */
export function threadPath(
  threadId: string,
  projectId: string | null,
): string {
  return projectId === null || projectId === ""
    ? `/threads/${threadId}`
    : `/projects/${projectId}/threads/${threadId}`;
}

/** Route to the composer for a new thread, optionally inside a project. */
export function newThreadPath(projectId: string | null): string {
  return projectId === null || projectId === ""
    ? "/"
    : `/projects/${projectId}`;
}

/** Move this client to `path`. */
export function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
}

/** The thread in view, read from a pathname like `/projects/<p>/threads/<t>`. */
export function currentThreadId(pathname: string): string | null {
  const match = /\/threads\/([^/?#]+)/.exec(pathname);
  return match?.[1] ?? null;
}
