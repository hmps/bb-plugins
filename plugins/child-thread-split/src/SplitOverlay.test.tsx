// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot, type CapturedPluginApp } from "@get-bb/plugin-sdk/testing/app";
import type {
  PluginSidebarSplitLayout,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";

const PROJECT = "prj_1";
const PARENT = "thr_parent";
const CHILD = "thr_child";

let app: CapturedPluginApp;

beforeAll(async () => {
  app = await loadPluginApp(() => import("../app"));
});

const restores: Array<() => void> = [];

afterEach(() => {
  cleanup();
  while (restores.length > 0) {
    restores.pop()?.();
  }
  document.body.replaceChildren();
});

// --- Fixtures: markup copied from the bb 0.44 bundle -----------------------

/** ChildThreadsBody inside the composer banner (`aria-hidden` = collapsed). */
function composerBanner(rows: Array<{ id: string; title: string }>, collapsed = false): string {
  const items = rows
    .map(
      ({ id, title }) => `
        <li class="text-xs">
          <a href="/projects/${PROJECT}/threads/${id}" class="flex min-w-0 items-center gap-2 rounded-md px-2 py-1">
            <span data-icon="Bot" class="size-3.5 shrink-0"></span>
            <span class="bb-thread-title flex-1" title="${title}">${title}</span>
            <span class="shrink-0 text-muted-foreground">Needs input</span>
          </a>
        </li>`,
    )
    .join("");
  return `
    <section id="thread-prompt-banner-child-threads-body" aria-hidden="${collapsed}">
      <div class="overflow-hidden bg-popover">
        <ul class="max-h-40 overflow-y-auto">${items}</ul>
      </div>
    </section>`;
}

/** PromptMentionPill for a thread, as GeneratedAgentSourceTitle renders it. */
function threadPill(id: string, label: string): string {
  const resource = JSON.stringify({ kind: "thread", threadId: id, projectId: PROJECT, label });
  return `<span role="link" tabindex="0" class="cursor-pointer" data-prompt-mention="true"
      data-prompt-mention-resource='${resource}'
      data-prompt-mention-serialized-text="@thread:${id}" title="${label}"
    ><span data-icon="MessageSquare"></span><span class="truncate">${label}</span></span>`;
}

/** A timeline row whose header is GeneratedAgentSourceTitle, plus its body. */
function messageRow(id: string, label: string, bodyPill = ""): string {
  return `
    <div class="rounded-md text-muted-foreground" data-testid="message-${id}">
      <div class="group/timeline-row">
        <button type="button" aria-expanded="false" class="inline-flex max-w-full overflow-hidden py-0.5">
          <span class="min-w-0">
            <span class="inline-flex min-w-0 max-w-full items-center gap-1 overflow-hidden whitespace-nowrap text-sm leading-5" title="Message from ${label}"><span class="shrink-0 whitespace-pre text-muted-foreground">Message from</span> ${threadPill(id, label)}</span>
          </span>
        </button>
      </div>
      <div aria-hidden="true" class="grid"><div class="overflow-hidden"><p>See ${bodyPill}</p></div></div>
    </div>`;
}

/**
 * A BB system message (child-completed) panel. The preview markup is the live
 * DOM that the parent captured; the wrappers come from ExpandablePanel ($V)
 * and the collapsed-preview wrapper in YH (bb 0.44). `expandable` adds the
 * wrapper's `role="button"` toggle.
 */
function childReport(id: string, label: string, options: { expandable?: boolean; lead?: string } = {}): string {
  const { expandable = true, lead = "" } = options;
  const resource = JSON.stringify({ kind: "thread", threadId: id, projectId: PROJECT, label });
  const toggle = expandable
    ? 'class="px-2 pb-1 pt-0.5 cursor-pointer focus-visible:outline-none" role="button" tabindex="0" aria-expanded="false"'
    : 'class="px-2 pb-1 pt-0.5"';
  return `
    <div class="rounded-md text-muted-foreground" data-testid="report-${id}">
      <div class="group/timeline-row">
        <button type="button" aria-expanded="false" class="inline-flex max-w-full overflow-hidden py-0.5">
          <span class="inline-flex min-w-0 max-w-full items-center gap-1.5">
            <span data-icon="CircleCheck"></span>
            <span class="inline-flex min-w-0 max-w-full items-baseline gap-1 overflow-hidden whitespace-nowrap text-sm leading-5" title="${label} finished"><a href="/projects/${PROJECT}/threads/${id}" class="min-w-0 truncate whitespace-pre underline">${label}</a> <span class="shrink-0 whitespace-pre">finished</span></span>
          </span>
        </button>
      </div>
      <div class="relative transition-[height] duration-200 ease-out"><div>
        <div ${toggle}>
          <div class="relative my-1 pl-3 pr-2 before:pointer-events-none before:absolute before:bottom-1 before:left-1.5 before:top-0 before:w-px before:bg-border-seam before:content-[''] max-w-full min-w-0"><div class="flex min-w-0 items-baseline truncate pl-2 text-sm leading-relaxed text-foreground"><div class="min-w-0 truncate"><div data-markdown-preview="" class="min-w-0"><p>${lead}<a data-prompt-mention="true" data-prompt-mention-resource='${resource}' data-prompt-mention-serialized-text="@thread:${id}" href="/projects/${PROJECT}/threads/${id}" title="${label}"><span data-icon="MessageSquare"></span><span class="truncate">${label}</span></a> completed:</p></div></div><span class="shrink-0 text-muted-foreground">...</span></div></div>
        </div>
      </div></div>
    </div>`;
}

/** The same panel expanded: $V swaps the preview for the full markdown body. */
function expandedChildReport(id: string, label: string): string {
  const resource = JSON.stringify({ kind: "thread", threadId: id, projectId: PROJECT, label });
  return `
    <div class="rounded-md text-muted-foreground">
      <div class="group/timeline-row"><button type="button" aria-expanded="true">${label} finished</button></div>
      <div class="relative transition-[height] duration-200 ease-out"><div>
        <div class="px-2 pb-1 pt-0">
          <div class="relative my-1 pl-3 pr-2"><div class="pl-2 text-sm leading-relaxed text-foreground"><div data-markdown-preview=""><p><a data-prompt-mention="true" data-prompt-mention-resource='${resource}' data-prompt-mention-serialized-text="@thread:${id}" href="/projects/${PROJECT}/threads/${id}">${label}</a> completed:</p><p>Done.</p></div></div></div>
        </div>
      </div></div>
    </div>`;
}

function mountDom(html: string): void {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
}

function thread(fields: Partial<PluginSidebarThread> & { id: string }): PluginSidebarThread {
  return {
    projectId: PROJECT,
    title: fields.id,
    displayTitle: fields.id,
    parentThreadId: null,
    originKind: null,
    isHidden: false,
    ...fields,
  } as PluginSidebarThread;
}

function pane(paneId: string, threadId: string | null, isFocused = false) {
  return { paneId, threadId, isFocused, rect: { x: 0, y: 0, width: 0.5, height: 1 } };
}

type SplitHook = (threadId: string) => {
  isAvailable: boolean;
  layout: unknown;
  splitProps: unknown;
};

/**
 * Replaces the runtime split hook; the harness one is always available and
 * closed. renderSlot reinstalls the runtime with the same app object, so the
 * hook is swapped on that object.
 */
function fakeSplit(hook: SplitHook): void {
  const host = globalThis as unknown as {
    __bbPluginRuntime: { pluginSdkApp: Record<string, unknown> };
  };
  const sdkApp = host.__bbPluginRuntime.pluginSdkApp;
  const original = sdkApp.experimental_useSidebarThreadSplit;
  sdkApp.experimental_useSidebarThreadSplit = hook;
  restores.push(() => {
    sdkApp.experimental_useSidebarThreadSplit = original;
  });
}

function render(
  options: {
    threads?: PluginSidebarThread[];
    layout?: PluginSidebarSplitLayout;
    threadId?: string | null;
  } = {},
) {
  const [overlay] = app.appOverlays;
  return renderSlot(overlay, {}, {
    context: { projectId: PROJECT, threadId: options.threadId === undefined ? PARENT : options.threadId },
    sidebarThreads: { threads: options.threads ?? [] },
    sidebarSplitLayout: options.layout,
  });
}

const splitButtons = () =>
  [...document.querySelectorAll<HTMLButtonElement>("[data-child-thread-split] > button")];

// --- Composer rows ----------------------------------------------------------

describe("composer child rows", () => {
  it("adds a labelled native button beside the row link and opens the child in a split", async () => {
    mountDom(composerBanner([{ id: CHILD, title: "Fix the login flow" }]));
    const anchor = document.querySelector("a")!;
    const li = document.querySelector("li")!;
    let linkClicks = 0;
    anchor.addEventListener("click", () => linkClicks++);
    li.addEventListener("click", () => linkClicks++);

    const view = render();
    await waitFor(() => expect(splitButtons()).toHaveLength(1));
    const button = splitButtons()[0];

    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("Open Fix the login flow in split");
    expect(button.closest("a")).toBeNull();
    expect(button.parentElement?.previousElementSibling).toBe(anchor);
    expect(button.querySelector('[data-icon="Columns2"]')).not.toBeNull();
    button.focus();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: CHILD, options: { split: true } },
    ]);
    expect(linkClicks).toBe(0);
  });

  it("removes the button from the tab order while the banner is collapsed", async () => {
    mountDom(composerBanner([{ id: CHILD, title: "Child" }], true));
    render();
    await waitFor(() => expect(splitButtons()).toHaveLength(1));
    expect(splitButtons()[0].tabIndex).toBe(-1);

    document.querySelector("section")!.setAttribute("aria-hidden", "false");
    await waitFor(() => expect(splitButtons()[0].tabIndex).toBe(0));
  });

  it("keeps one button per row across rescans and host re-renders", async () => {
    mountDom(composerBanner([{ id: CHILD, title: "Child" }, { id: "thr_two", title: "Two" }]));
    render();
    await waitFor(() => expect(splitButtons()).toHaveLength(2));

    // Unrelated mutations rescan; a host re-render drops the plugin span.
    document.querySelector(".bb-thread-title")!.setAttribute("title", "Renamed");
    const li = document.querySelector("li")!;
    li.replaceChildren(li.querySelector("a")!);
    document.body.append(document.createElement("div"));

    await waitFor(() => {
      expect(splitButtons()).toHaveLength(2);
      expect(document.querySelectorAll("li > [data-child-thread-split]")).toHaveLength(2);
      expect(splitButtons()[0].getAttribute("aria-label")).toBe("Open Renamed in split");
    });
  });

  it("follows route changes and removes every node on unmount", async () => {
    mountDom(composerBanner([{ id: CHILD, title: "Child" }]));
    const view = render();
    await waitFor(() => expect(splitButtons()).toHaveLength(1));

    document.querySelector("section")!.parentElement!.remove();
    mountDom(composerBanner([{ id: "thr_other", title: "Other" }]));
    await waitFor(() => {
      expect(splitButtons()).toHaveLength(1);
      expect(splitButtons()[0].getAttribute("aria-label")).toBe("Open Other in split");
    });

    view.lifecycle.unmount();
    expect(document.querySelectorAll("[data-child-thread-split]")).toHaveLength(0);
  });

  it("hides the button where bb cannot split, such as a narrow window", async () => {
    fakeSplit(() => ({ isAvailable: false, layout: null, splitProps: {} }));
    mountDom(composerBanner([{ id: CHILD, title: "Child" }]));
    render();
    await waitFor(() => expect(document.querySelectorAll("[data-child-thread-split]")).toHaveLength(1));
    expect(splitButtons()).toHaveLength(0);
  });
});

// --- Multiple panes ---------------------------------------------------------

describe("split panes", () => {
  it("focuses the pane that shows the button before it opens the child", async () => {
    mountDom(`
      <div data-split-pane-id="pane-a"></div>
      <div data-split-pane-id="pane-b">${composerBanner([{ id: CHILD, title: "Child" }])}</div>`);
    const view = render({
      layout: { panes: [pane("pane-a", "thr_left", true), pane("pane-b", PARENT)] },
    });
    await waitFor(() => expect(splitButtons()).toHaveLength(1));

    fireEvent.click(splitButtons()[0]);
    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: PARENT, options: { split: true } },
      { method: "toThread", threadId: CHILD, options: { split: true } },
    ]);
  });

  it("adds one button to each pane's banner", async () => {
    mountDom(`
      <div data-split-pane-id="pane-a">${composerBanner([{ id: CHILD, title: "Child" }])}</div>
      <div data-split-pane-id="pane-b">${composerBanner([{ id: CHILD, title: "Child" }])}</div>`);
    render({ layout: { panes: [pane("pane-a", PARENT, true), pane("pane-b", PARENT)] } });
    await waitFor(() => expect(splitButtons()).toHaveLength(2));
  });

  it("hides the button at the pane cap, where bb would replace the focused pane", async () => {
    mountDom(composerBanner([{ id: CHILD, title: "Child" }]));
    const panes = Array.from({ length: 8 }, (_, index) => pane(`pane-${index}`, `thr_${index}`, index === 0));
    render({ layout: { panes } });
    await waitFor(() => expect(document.querySelectorAll("[data-child-thread-split]")).toHaveLength(1));
    expect(splitButtons()).toHaveLength(0);
  });

  it("keeps the button at the cap when the child is already open, because bb only focuses it", async () => {
    fakeSplit(() => ({
      isAvailable: true,
      layout: { panes: [{ paneId: "pane-1", rect: { x: 0, y: 0, width: 1, height: 1 }, isMe: true, isFocused: false }] },
      splitProps: {},
    }));
    mountDom(composerBanner([{ id: CHILD, title: "Child" }]));
    const panes = Array.from({ length: 8 }, (_, index) => pane(`pane-${index}`, `thr_${index}`, index === 0));
    render({ layout: { panes } });
    await waitFor(() => expect(splitButtons()).toHaveLength(1));
  });
});

// --- Message header pills ---------------------------------------------------

describe("message header pills", () => {
  const threads = [
    thread({ id: CHILD, parentThreadId: PARENT }),
    thread({ id: "thr_fork", parentThreadId: PARENT, originKind: "fork" }),
    thread({ id: "thr_side", parentThreadId: PARENT, isHidden: true }),
    thread({ id: "thr_unrelated", parentThreadId: "thr_elsewhere" }),
  ];

  it("adds a button only for child threads, beside the header and outside its toggle", async () => {
    mountDom(
      [
        messageRow(CHILD, "Child agent", threadPill("thr_unrelated", "Body mention")),
        messageRow("thr_fork", "Fork"),
        messageRow("thr_side", "Side chat"),
        messageRow("thr_unrelated", "Unrelated"),
      ].join(""),
    );
    const header = document.querySelector("[aria-expanded]")!;
    let toggles = 0;
    header.addEventListener("click", () => toggles++);

    const view = render({ threads });
    await waitFor(() => expect(splitButtons()).toHaveLength(1));
    const button = splitButtons()[0];

    expect(button.getAttribute("aria-label")).toBe("Open Child agent in split");
    expect(button.closest("button[aria-expanded], a, [role='link']")).toBeNull();
    expect(button.parentElement?.parentElement?.className).toBe("group/timeline-row");
    expect(button.closest(`[data-testid="message-${CHILD}"]`)).not.toBeNull();

    fireEvent.click(button);
    expect(view.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: CHILD, options: { split: true } },
    ]);
    expect(toggles).toBe(0);
  });

  it("uses the thread of the pane that shows the message as the parent", async () => {
    mountDom(`
      <div data-split-pane-id="pane-a">${messageRow(CHILD, "Child agent")}</div>
      <div data-split-pane-id="pane-b">${messageRow(CHILD, "Child agent")}</div>`);
    render({
      threads,
      threadId: "thr_route",
      layout: { panes: [pane("pane-a", "thr_route", true), pane("pane-b", PARENT)] },
    });
    await waitFor(() => expect(splitButtons()).toHaveLength(1));
    expect(splitButtons()[0].closest("[data-split-pane-id]")?.getAttribute("data-split-pane-id")).toBe(
      "pane-b",
    );
  });

  it("ignores rows until the thread list knows the child", async () => {
    mountDom(messageRow(CHILD, "Child agent"));
    render({ threads: [] });
    await waitFor(() => expect(document.querySelectorAll("[data-child-thread-split]")).toHaveLength(1));
    expect(splitButtons()).toHaveLength(0);
  });
});

// --- Child report previews --------------------------------------------------

describe("child report previews", () => {
  const threads = [
    thread({ id: CHILD, parentThreadId: PARENT }),
    thread({ id: "thr_unrelated", parentThreadId: "thr_elsewhere" }),
  ];

  it.each([true, false])(
    "adds a button to the report header, outside the preview toggle (expandable: %s)",
    async (expandable) => {
      mountDom(childReport(CHILD, "Add child thread split buttons plugin", { expandable }));
      const toggles: string[] = [];
      for (const element of document.querySelectorAll("[aria-expanded]")) {
        element.addEventListener("click", () => toggles.push(element.tagName));
      }

      const view = render({ threads });
      await waitFor(() => expect(splitButtons()).toHaveLength(1));
      const button = splitButtons()[0];

      expect(button.getAttribute("aria-label")).toBe("Open Add child thread split buttons plugin in split");
      expect(button.closest("button[aria-expanded], [role='button'], a, [role='link']")).toBeNull();
      expect(button.parentElement?.parentElement?.className).toBe("group/timeline-row");
      expect(button.closest(`[data-testid="report-${CHILD}"]`)).not.toBeNull();

      fireEvent.click(button);
      expect(view.inspection.navigateCalls).toEqual([
        { method: "toThread", threadId: CHILD, options: { split: true } },
      ]);
      expect(toggles).toEqual([]);
    },
  );

  it("ignores expanded bodies, pills after other text, and threads that are not children", async () => {
    mountDom(
      [
        expandedChildReport(CHILD, "Expanded"),
        childReport(CHILD, "Mid-line", { lead: "See " }),
        childReport("thr_unrelated", "Unrelated"),
      ].join(""),
    );
    render({ threads });
    // Only the unrelated report is a target, and it gets no button.
    await waitFor(() => expect(document.querySelectorAll("[data-child-thread-split]")).toHaveLength(1));
    expect(document.querySelector('[data-testid="report-thr_unrelated"] [data-child-thread-split]')).not.toBeNull();
    expect(splitButtons()).toHaveLength(0);
  });

  it("removes the button when the panel expands and the preview goes away", async () => {
    mountDom(childReport(CHILD, "Child"));
    render({ threads });
    await waitFor(() => expect(splitButtons()).toHaveLength(1));

    document.querySelector('[role="button"]')!.remove();
    await waitFor(() => expect(document.querySelectorAll("[data-child-thread-split]")).toHaveLength(0));
  });
});
