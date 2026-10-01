// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginBrowserBbSdk, PluginComposerScope } from "@get-bb/plugin-sdk/app";

type ContextResult = Awaited<ReturnType<PluginBrowserBbSdk["threads"]["context"]>>;
type SubscribeArgs = Parameters<PluginBrowserBbSdk["subscribe"]>[0];

afterEach(cleanup);

const threadScope = (threadId: string): PluginComposerScope =>
  ({ kind: "thread", threadId, projectId: "p1" }) as PluginComposerScope;

const used = (usedTokens: number, modelContextWindow = 200_000, estimated = false): ContextResult => ({
  usage: { usedTokens, modelContextWindow, estimated },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

/**
 * Renders the composer action with a fake `threads.context` and `subscribe`.
 * `reads` answers each context read in order; the last answer repeats.
 */
async function renderAction(
  scope: PluginComposerScope,
  reads: Array<ContextResult | Promise<ContextResult>>,
) {
  const contextCalls: string[] = [];
  const subscriptions: Array<{ args: SubscribeArgs; unsubscribe: ReturnType<typeof vi.fn> }> = [];
  const app = await loadPluginApp(() => import("../app"));
  const action = app.composerCustomizations[0]!.actions![0]!;
  const slot = renderSlot(action, {}, {
    composer: { scope },
    sdk: {
      providers: {
        models: () =>
          Promise.resolve({
            modelLoadError: null,
            permissionCeiling: "full",
            providers: [],
            models: [],
            selectedOnlyModels: [],
          } as unknown as Awaited<ReturnType<PluginBrowserBbSdk["providers"]["models"]>>),
      },
      threads: {
        context: ({ threadId }) => {
          contextCalls.push(threadId);
          return Promise.resolve(reads[Math.min(contextCalls.length - 1, reads.length - 1)]!);
        },
      },
      subscribe: ((args: SubscribeArgs) => {
        const unsubscribe = vi.fn();
        subscriptions.push({ args, unsubscribe });
        return unsubscribe;
      }) as PluginBrowserBbSdk["subscribe"],
    },
  });
  /** Sends a thread change to the live subscription. */
  const emit = async (eventTypes: string[]) => {
    const live = subscriptions.at(-1)!.args as { callback: (event: unknown) => void };
    await act(async () => {
      live.callback({ changes: ["events-appended"], metadata: { eventTypes } });
    });
  };
  return { slot, contextCalls, subscriptions, emit };
}

const ring = (name: RegExp = /context window/i) => screen.findByRole("button", { name });

describe("ContextRing", () => {
  it("shows the percent of the thread context and a panel with the details", async () => {
    await renderAction(threadScope("t1"), [used(84_999)]);

    const button = await ring();
    expect(button.getAttribute("aria-label")).toBe("Context window 42% used");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");

    fireEvent.click(button);
    const panel = await screen.findByRole("dialog", { name: "Context window" });
    expect(within(panel).getByText("42% used")).toBeTruthy();
    expect(within(panel).getByText("58% left")).toBeTruthy();
    expect(within(panel).getByText("85k / 200k tokens")).toBeTruthy();

    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("marks estimated usage and colors a nearly full context", async () => {
    await renderAction(threadScope("t1"), [used(185_000, 200_000, true)]);

    const button = await ring();
    expect(button.getAttribute("aria-label")).toBe("Estimated context window 93% used");
    expect(button.className).toContain("text-destructive");
  });

  it("shows no ring when the thread reports no usage, and none in a new thread", async () => {
    const { contextCalls } = await renderAction(threadScope("t1"), [{ usage: null }]);
    await waitFor(() => expect(contextCalls).toEqual(["t1"]));
    expect(screen.queryByRole("button", { name: /context window/i })).toBeNull();
    cleanup();

    const fresh = await renderAction({ kind: "new-thread", projectId: "p1" } as PluginComposerScope, [
      used(1),
    ]);
    await screen.findByRole("button", { name: /^Model/ });
    expect(fresh.contextCalls).toEqual([]);
    expect(fresh.subscriptions).toEqual([]);
    expect(screen.queryByRole("button", { name: /context window/i })).toBeNull();
  });

  it("never shows the usage of the previous thread after a thread change", async () => {
    const late = deferred<ContextResult>();
    const next = deferred<ContextResult>();
    const { slot, subscriptions } = await renderAction(threadScope("t1"), [used(100_000), late.promise, next.promise]);
    expect((await ring()).getAttribute("aria-label")).toBe("Context window 50% used");

    // A read for t1 is still open when the composer moves to t2.
    window.dispatchEvent(new Event("focus"));
    await slot.setComposerScope(threadScope("t2"));
    expect(subscriptions[0]!.unsubscribe).toHaveBeenCalledOnce();
    expect(subscriptions[1]!.args).toMatchObject({ event: "thread:changed", threadId: "t2" });
    // t2 has no answer yet, so the ring of t1 must not stay.
    expect(screen.queryByRole("button", { name: /context window/i })).toBeNull();

    await act(async () => late.resolve(used(180_000)));
    expect(screen.queryByRole("button", { name: /context window/i })).toBeNull();
    await act(async () => next.resolve(used(20_000)));
    expect((await ring()).getAttribute("aria-label")).toBe("Context window 10% used");
  });

  it("reads again on usage events, focus, and open, and stops after unmount", async () => {
    const { slot, contextCalls, subscriptions, emit } = await renderAction(threadScope("t1"), [
      used(20_000),
      used(40_000),
    ]);
    await ring(/10% used/);
    expect(subscriptions).toHaveLength(1);

    await emit(["item/agentMessage/delta"]);
    expect(contextCalls).toHaveLength(1);
    await emit(["thread/contextWindowUsage/updated"]);
    await ring(/20% used/);
    expect(contextCalls).toHaveLength(2);

    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(contextCalls).toHaveLength(3);
    fireEvent.click(await ring());
    await waitFor(() => expect(contextCalls).toHaveLength(4));

    slot.unmount();
    expect(subscriptions[0]!.unsubscribe).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("focus"));
    expect(contextCalls).toHaveLength(4);
  });

  it("keeps the editor focused on a touch tap", async () => {
    await renderAction(threadScope("t1"), [used(1_000)]);
    const button = await ring();

    // Canceled events return false: the tap does not move focus to the ring.
    expect(fireEvent.pointerDown(button, { pointerType: "touch", button: 0 })).toBe(false);
    expect(fireEvent.mouseDown(button, { button: 0 })).toBe(false);
    fireEvent.click(button);
    expect(await screen.findByRole("dialog", { name: "Context window" })).toBeTruthy();
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });
});
