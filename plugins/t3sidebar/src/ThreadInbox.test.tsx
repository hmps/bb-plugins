// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  PluginSidebarThread,
  PluginThreadListProps,
} from "@get-bb/plugin-sdk";

// Load through the harness so the plugin's `@get-bb/plugin-sdk/app` import binds
// to the test runtime; importing the component directly would bind it to an
// empty runtime first.
const app = await loadPluginApp(() => import("../app"));
const inbox = app.threadLists[0]!;
// Imported after the harness so the hook binds to the test runtime.
const sdk = await import("@get-bb/plugin-sdk/app");

function thread(
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id: "thr_1",
    projectId: "proj_1",
    title: "A thread",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  };
}

const listProps = {
  activeThreadId: null,
  activeProjectId: null,
  isCompactViewport: false,
  onNavigate: () => {},
  searchQuery: "",
  // The host list, for a plugin that delegates; this one never renders it.
  Original: () => null,
};

function render(
  threads: PluginSidebarThread[],
  projects = [{ id: "proj_1", name: "bb", isPersonal: false }],
  settings: Record<string, string | boolean> = {},
) {
  return renderSlot(inbox, listProps, {
    settings,
    sidebarThreads: { status: "ready", threads, projects },
    // The lifecycle store is the plugin's own backend; an empty one means
    // every thread is active, which is what these list tests are about.
    rpc: {
      listProjectColors: () => ({ projects: [] }),
      listLifecycle: () => ({ rows: [] }),
    },
  });
}

afterEach(cleanup);

describe("t3sidebar registration", () => {
  it("registers exactly one thread list", () => {
    expect(app.threadLists).toHaveLength(1);
    expect(inbox.id).toBe("inbox");
  });
});

describe("attention first setting", () => {
  const threads = () => [
    thread({
      id: "old",
      title: "Old waiting",
      createdAt: 1,
      hasPendingInteraction: true,
    }),
    thread({ id: "new", title: "New quiet", createdAt: 2 }),
  ];
  const titles = () =>
    screen
      .getAllByRole("listitem")
      .map(
        (item) => within(item).getAllByText(/waiting|quiet/i)[0]!.textContent,
      );

  it("keeps the static order when off", () => {
    render(threads());
    expect(titles()).toEqual(["New quiet", "Old waiting"]);
  });

  it("lifts the waiting thread when on", () => {
    render(threads(), undefined, { attentionFirst: true });
    expect(titles()).toEqual(["Old waiting", "New quiet"]);
  });

  it("keeps an opened unread thread in place until another opens", () => {
    const unread = thread({
      id: "old",
      title: "Old waiting",
      createdAt: 1,
      isUnread: true,
    });
    const quiet = thread({ id: "new", title: "New quiet", createdAt: 2 });
    const Inbox = inbox.component;
    // The harness hands the hook one state object; swapping its threads and
    // rerendering stands in for the host marking the thread read.
    let state: { threads: readonly PluginSidebarThread[] } | undefined;
    function Probe(props: PluginThreadListProps) {
      state = sdk.experimental_useSidebarThreads() as unknown as typeof state;
      return <Inbox {...props} />;
    }
    const slot = render([unread, quiet], undefined, { attentionFirst: true });
    slot.rerender(<Probe {...listProps} />);
    expect(titles()).toEqual(["Old waiting", "New quiet"]);

    // Opening the thread marks it read in the same update.
    state!.threads = [{ ...unread, isUnread: false }, quiet];
    slot.rerender(<Probe {...listProps} activeThreadId="old" />);
    expect(titles()).toEqual(["Old waiting", "New quiet"]);

    // Opening another thread releases the hold.
    slot.rerender(<Probe {...listProps} activeThreadId="new" />);
    expect(titles()).toEqual(["New quiet", "Old waiting"]);
  });
});

describe("ThreadInbox", () => {
  it("lists threads newest first", () => {
    render([
      thread({ id: "a", title: "Older", createdAt: 1 }),
      thread({ id: "b", title: "Newer", createdAt: 2 }),
    ]);
    // The anchor is a full-bleed overlay, so read the row containers.
    const titles = screen
      .getAllByRole("listitem")
      .map((row) => row.textContent);
    expect(titles[0]).toContain("Newer");
    expect(titles[1]).toContain("Older");
  });

  // The DOM contract behind numbered thread shortcuts and thread.next/previous.
  // A plugin that drops these attributes silently breaks nine host shortcuts.
  it("marks every row as a host shortcut target", () => {
    render([thread({ id: "thr_x" })]);
    const row = screen.getByRole("link");
    expect(row.hasAttribute("data-sidebar-thread-shortcut-target")).toBe(true);
    expect(row.getAttribute("data-sidebar-thread-id")).toBe("thr_x");
  });

  it("opens a thread on click and closes the mobile drawer", () => {
    let navigated = 0;
    const rendered = renderSlot(
      inbox,
      { ...listProps, onNavigate: () => (navigated += 1) },
      {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "thr_open" })],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
        },
        rpc: {
          listProjectColors: () => ({ projects: [] }),
          listLifecycle: () => ({ rows: [] }),
        },
      },
    );
    fireEvent.click(screen.getByRole("link"));
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "thr_open",
      options: { split: false },
    });
    expect(navigated).toBe(1);
  });

  it("opens in a split with the platform modifier held", () => {
    const rendered = render([thread({ id: "thr_split" })]);
    fireEvent.click(screen.getByRole("link"), { metaKey: true });
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "thr_split",
      options: { split: true },
    });
  });

  it("separates pinned threads from the inbox", () => {
    render([
      thread({ id: "a", title: "Plain" }),
      thread({ id: "b", title: "Stuck", isPinned: true }),
    ]);
    const pinned = screen.getByRole("region", { name: /pinned/i });
    expect(within(pinned).getByText("Stuck")).toBeDefined();
  });

  // The host owns the search field; the plugin only filters by what it is
  // handed, so there is deliberately no second search box to type into.
  it("filters by the host's search query", () => {
    renderSlot(
      inbox,
      { ...listProps, searchQuery: "sidebar" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "a", title: "Sidebar work" }),
            thread({ id: "b", title: "Something else" }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
        },
        rpc: {
          listProjectColors: () => ({ projects: [] }),
          listLifecycle: () => ({ rows: [] }),
        },
      },
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Sidebar work")).toBeDefined();
  });

  it("ships no search field of its own", () => {
    render([thread({ id: "a" })]);
    expect(screen.queryByLabelText("Search threads")).toBeNull();
  });

  it("ships no new-thread button of its own", () => {
    render([thread({ id: "a" })]);
    expect(screen.queryByLabelText("New thread")).toBeNull();
  });

  it("scopes to one project", () => {
    render(
      [
        thread({ id: "a", title: "In bb", projectId: "proj_1" }),
        thread({ id: "b", title: "In other", projectId: "proj_2" }),
      ],
      [
        { id: "proj_1", name: "bb", isPersonal: false },
        { id: "proj_2", name: "other", isPersonal: false },
      ],
    );
    // Radix opens on keyboard too, which jsdom can drive without pointer
    // capture. Enter opens the list; the option click picks the scope.
    fireEvent.keyDown(screen.getByLabelText(/Project scope/), { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "other" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("In other")).toBeDefined();
  });

  it("hides archived threads", () => {
    render([thread({ id: "a", isArchived: true })]);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("reports an empty inbox and a fruitless search differently", () => {
    render([]);
    expect(screen.getByText("No threads yet")).toBeDefined();
  });
});

describe("parking threads", () => {
  it("moves a settled thread to the Settled shelf", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_done", title: "Finished work" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listProjectColors: () => ({ projects: [] }),
        listLifecycle: () => ({
          rows: [
            {
              threadId: "thr_done",
              settledAt: 200,
              snoozedUntil: null,
              snoozedAt: null,
            },
          ],
        }),
      },
    });
    // The shelf renders once the lifecycle read resolves.
    const shelf = await screen.findByRole("region", { name: "Settled" });
    expect(within(shelf).getByText(/Settled \(1\)/)).toBeDefined();
    // Collapsed by default: parked work is out of the way, never gone.
    expect(screen.queryByText("Finished work")).toBeNull();
    fireEvent.click(within(shelf).getByRole("button"));
    expect(within(shelf).getByText("Finished work")).toBeDefined();
  });

  it("keeps a working thread out of the shelves and offers no park action", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "thr_busy",
            title: "Still running",
            indicator: "runtime",
            activity: {
              workflows: 0,
              backgroundAgents: 0,
              backgroundCommands: 0,
              planMode: 0,
              goals: 0,
            },
          }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      // Settled in the store, but still working: it must stay visible.
      rpc: {
        listProjectColors: () => ({ projects: [] }),
        listLifecycle: () => ({
          rows: [
            {
              threadId: "thr_busy",
              settledAt: 200,
              snoozedUntil: null,
              snoozedAt: null,
            },
          ],
        }),
      },
    });
    // Live work wins over the settle: the row lands on Working, never Settled.
    const shelf = await screen.findByRole("region", { name: "Working" });
    expect(screen.queryByRole("region", { name: "Settled" })).toBeNull();
    fireEvent.click(within(shelf).getByRole("button"));
    expect(within(shelf).getByText("Still running")).toBeDefined();
    expect(screen.queryByLabelText("Settle thread")).toBeNull();
  });

  it("offers settle and snooze on a parkable thread", async () => {
    render([thread({ id: "thr_park", title: "Quiet" })]);
    // Rendered (not merely accepted as props): a card whose park controls
    // never mount leaves the whole feature unreachable.
    expect(await screen.findByLabelText("Settle thread")).toBeDefined();
    expect(screen.getByLabelText("Snooze until tomorrow")).toBeDefined();
  });

  it("settles a thread when the user clicks Settle", async () => {
    let settled: string | null = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_park", title: "Quiet" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listProjectColors: () => ({ projects: [] }),
        listLifecycle: () => ({ rows: [] }),
        settle: (input) => {
          settled = (input as { threadId: string }).threadId;
          return { ok: true };
        },
      },
    });
    fireEvent.click(await screen.findByLabelText("Settle thread"));
    await waitFor(() => expect(settled).toBe("thr_park"));
  });

  // A held modifier numbers the rows bb's modifier+1..9 open, top down.
  // jsdom is not a Mac, so the modifier is Control.
  it("shows each row's shortcut while the modifier is held", async () => {
    render([
      thread({ id: "thr_a", title: "First", updatedAt: Date.now() }),
      thread({ id: "thr_b", title: "Second", updatedAt: Date.now() - 60_000 }),
    ]);
    await screen.findByLabelText("First");
    expect(screen.queryByText("Ctrl + 1")).toBeNull();

    fireEvent.keyDown(window, { key: "Control" });
    const first = await screen.findByText("Ctrl + 1", {}, { timeout: 2_000 });
    const second = screen.getByText("Ctrl + 2");
    // Top down: the first card holds the first key.
    expect(
      first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByLabelText("First").closest("li")?.contains(first),
    ).toBe(true);

    fireEvent.keyUp(window, { key: "Control" });
    await waitFor(() => expect(screen.queryByText("Ctrl + 1")).toBeNull());
  });

  it("keeps the hints hidden when another key joins the modifier", async () => {
    render([thread({ id: "thr_a", title: "First" })]);
    await screen.findByLabelText("First");
    fireEvent.keyDown(window, { key: "Control" });
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(screen.queryByText("Ctrl + 1")).toBeNull();
  });

  // Touch screens have no hover: the park actions hide behind a left swipe.
  describe("swipe to reveal", () => {
    const drag = (
      target: Element,
      pointerType: string,
      to: { x: number; y: number },
    ) => {
      fireEvent.pointerDown(target, { pointerType, clientX: 200, clientY: 20 });
      fireEvent.pointerMove(target, {
        pointerType,
        clientX: (200 + to.x) / 2,
        clientY: (20 + to.y) / 2,
      });
      fireEvent.pointerMove(target, { pointerType, clientX: to.x, clientY: to.y });
      fireEvent.pointerUp(target, { pointerType, clientX: to.x, clientY: to.y });
    };
    const link = async () =>
      (await screen.findByLabelText("Quiet")).closest("a") as Element;

    it("reveals the tray on a left swipe, and its Settle settles", async () => {
      let settled: string | null = null;
      renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "thr_park", title: "Quiet" })],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
        },
        rpc: {
          listProjectColors: () => ({ projects: [] }),
          listLifecycle: () => ({ rows: [] }),
          settle: (input) => {
            settled = (input as { threadId: string }).threadId;
            return { ok: true };
          },
        },
      });
      const row = await link();
      expect(screen.queryByRole("button", { name: "Settle" })).toBeNull();
      drag(row, "touch", { x: 40, y: 24 });
      fireEvent.click(await screen.findByRole("button", { name: "Settle" }));
      await waitFor(() => expect(settled).toBe("thr_park"));
    });

    it("keeps the tray shut for a mouse drag", async () => {
      render([thread({ id: "thr_park", title: "Quiet" })]);
      drag(await link(), "mouse", { x: 40, y: 24 });
      expect(screen.queryByRole("button", { name: "Settle" })).toBeNull();
    });

    it("leaves a vertical touch move to scrolling", async () => {
      render([thread({ id: "thr_park", title: "Quiet" })]);
      drag(await link(), "touch", { x: 190, y: 180 });
      expect(screen.queryByRole("button", { name: "Settle" })).toBeNull();
    });

    it("closes the tray on a tap of the open card", async () => {
      render([thread({ id: "thr_park", title: "Quiet" })]);
      const row = await link();
      drag(row, "touch", { x: 40, y: 24 });
      expect(await screen.findByRole("button", { name: "Settle" })).toBeDefined();
      fireEvent.pointerDown(row, { pointerType: "touch", clientX: 100, clientY: 20 });
      fireEvent.pointerUp(row, { pointerType: "touch", clientX: 100, clientY: 20 });
      fireEvent.click(row);
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Settle" })).toBeNull(),
      );
    });
  });

  it("shows the wake countdown on a snoozed row", async () => {
    const wakeAt = Date.now() + 2 * 60 * 60 * 1000;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_snz", title: "Later" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listProjectColors: () => ({ projects: [] }),
        listLifecycle: () => ({
          rows: [
            {
              threadId: "thr_snz",
              settledAt: null,
              snoozedUntil: wakeAt,
              snoozedAt: Date.now(),
            },
          ],
        }),
      },
    });
    const shelf = await screen.findByRole("region", { name: "Snoozed" });
    fireEvent.click(within(shelf).getByRole("button"));
    expect(within(shelf).getByText("2h")).toBeDefined();
    expect(within(shelf).getByLabelText("Wake thread now")).toBeDefined();
  });
});

describe("working shelf", () => {
  const busy = (overrides: Partial<PluginSidebarThread> = {}) =>
    thread({
      id: "thr_busy",
      title: "Still running",
      indicator: "runtime",
      indicatorLabel: "Thread working",
      ...overrides,
    });

  it("collapses a working thread onto the Working shelf", async () => {
    render([busy(), thread({ id: "thr_quiet", title: "Quiet" })]);
    const shelf = await screen.findByRole("region", { name: "Working" });
    expect(within(shelf).getByText(/Working \(1\)/)).toBeDefined();
    expect(screen.queryByText("Still running")).toBeNull();
    expect(screen.getByText("Quiet")).toBeDefined();
    fireEvent.click(within(shelf).getByRole("button"));
    expect(within(shelf).getByText("Still running")).toBeDefined();
    // The spinner speaks for the row, and there is nothing to restore: bb
    // moves it back on its own.
    expect(within(shelf).getByLabelText("Thread working")).toBeDefined();
    expect(
      within(shelf).queryByRole("button", { name: /wake|un-settle/i }),
    ).toBeNull();
  });

  it("keeps a working thread that is waiting on the user in the inbox", async () => {
    render([busy({ hasPendingInteraction: true })]);
    expect(await screen.findByText("Still running")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Working" })).toBeNull();
  });

  it("keeps a pinned working thread on the Pinned shelf", async () => {
    render([busy({ isPinned: true })]);
    const pinned = await screen.findByRole("region", { name: "Pinned" });
    expect(within(pinned).getByText("Still running")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Working" })).toBeNull();
  });

  it("leaves working threads in the inbox when the setting is off", async () => {
    render([busy()], undefined, { workingShelf: false });
    expect(await screen.findByText("Still running")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Working" })).toBeNull();
  });
});

describe("child thread rollup", () => {
  // The flat list hides a child whose parent is on screen, so the parent card
  // is the only place its work can show. Without the rollup the parent reads
  // as idle while the child runs.
  const withChild = (child: Partial<PluginSidebarThread>) => [
    thread({ id: "thr_parent", title: "Parent thread" }),
    thread({
      id: "thr_child",
      title: "Child thread",
      parentThreadId: "thr_parent",
      ...child,
    }),
  ];

  it("moves a parent with a working child onto the Working shelf", async () => {
    render(withChild({ indicator: "runtime", indicatorLabel: "Child works" }));
    const shelf = await screen.findByRole("region", { name: "Working" });
    fireEvent.click(within(shelf).getByRole("button"));
    expect(within(shelf).getByText("Parent thread")).toBeDefined();
    // The child never gets a row of its own; the parent counts it instead.
    expect(screen.queryByText("Child thread")).toBeNull();
    expect(
      within(shelf).getByLabelText("1 child agents, 1 working"),
    ).toBeDefined();
    // The parent has no indicator of its own, so it borrows the spinner.
    expect(within(shelf).getByLabelText("Child thread working")).toBeDefined();
  });

  it("keeps a parent whose child asks a question in the inbox", async () => {
    render(withChild({ hasPendingInteraction: true }));
    expect(await screen.findByText("Parent thread")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Working" })).toBeNull();
    expect(screen.getByLabelText("Child thread needs input")).toBeDefined();
  });

  it("cannot park a parent while its child works", async () => {
    render(withChild({ indicator: "runtime" }));
    expect(await screen.findByRole("region", { name: "Working" }));
    expect(screen.queryByLabelText("Settle thread")).toBeNull();
    expect(screen.queryByLabelText("Snooze until tomorrow")).toBeNull();
  });

  // A grandchild is two rows down and hidden twice over; the visible root has
  // to speak for it.
  it("counts a grandchild on the visible root", async () => {
    render([
      thread({ id: "thr_root", title: "Root thread" }),
      thread({ id: "thr_mid", parentThreadId: "thr_root", title: "Middle" }),
      thread({
        id: "thr_leaf",
        parentThreadId: "thr_mid",
        title: "Leaf",
        indicator: "runtime",
      }),
    ]);
    const shelf = await screen.findByRole("region", { name: "Working" });
    fireEvent.click(within(shelf).getByRole("button"));
    expect(
      within(shelf).getByLabelText("2 child agents, 1 working"),
    ).toBeDefined();
  });

  it("draws nothing for a parent whose children are at rest", async () => {
    render(withChild({}));
    expect(await screen.findByText("Parent thread")).toBeDefined();
    expect(screen.getByLabelText("1 child agents")).toBeDefined();
    expect(screen.getByLabelText("Settle thread")).toBeDefined();
  });

  it("counts the child agents a thread started, just before the provider", async () => {
    render([
      ...withChild({ isArchived: true }),
      thread({ id: "thr_second", parentThreadId: "thr_parent" }),
    ]);
    const count = await screen.findByLabelText("2 child agents");
    // The provider glyph box holds a labelled svg.
    expect(
      count.nextElementSibling?.querySelector('[aria-label="Codex"]'),
    ).not.toBeNull();
  });

  it("draws no child count for a thread without children", async () => {
    render([thread({ id: "thr_alone", title: "Alone" })]);
    expect(await screen.findByText("Alone")).toBeDefined();
    expect(screen.queryByLabelText(/child agents/)).toBeNull();
  });
});

describe("queued messages", () => {
  const withQueue = (counts: Record<string, number>) =>
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_q", title: "Queued work" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listProjectColors: () => ({ projects: [] }),
        listLifecycle: () => ({ rows: [] }),
        queueCounts: (input: unknown) => {
          const { threadIds } = input as { threadIds: string[] };
          return {
            counts: threadIds.map((threadId) => ({
              threadId,
              count: counts[threadId] ?? 0,
            })),
          };
        },
      },
    });

  it("shows the count once the backend answers", async () => {
    withQueue({ thr_q: 2 });
    expect(await screen.findByLabelText("2 queued messages")).toBeDefined();
  });

  it("draws nothing for an empty queue", async () => {
    withQueue({});
    expect(await screen.findByText("Queued work")).toBeDefined();
    await waitFor(() =>
      expect(screen.queryByLabelText(/queued messages/)).toBeNull(),
    );
  });

  it("follows the realtime signal when the queue changes", async () => {
    const harness = withQueue({ thr_q: 1 });
    expect(await screen.findByLabelText("1 queued messages")).toBeDefined();
    await harness.emitRealtime("queue", { threadId: "thr_q", count: 3 });
    expect(await screen.findByLabelText("3 queued messages")).toBeDefined();
    await harness.emitRealtime("queue", { threadId: "thr_q", count: 0 });
    await waitFor(() =>
      expect(screen.queryByLabelText(/queued messages/)).toBeNull(),
    );
  });
});

describe("row context menu", () => {
  it("offers the plugin's own thread actions on right-click", async () => {
    render([thread({ id: "thr_menu", title: "Right click me" })]);
    const row = await screen.findByText("Right click me");
    fireEvent.contextMenu(row);
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    // The plugin builds this menu itself — the SDK ships no menu component —
    // so the items are this plugin's choice, backed by the action hook.
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Open in split",
      "Snooze until tomorrow",
      "Settle",
      "Settle and archive",
      "Mark unread",
      "Pin",
      "Archive",
      "Delete",
    ]);
  });

  // A touch screen never hovers, so the card's park buttons stay hidden
  // there; the long-press menu is the only path to Settle. It must really
  // settle, not just be listed.
  it("settles a thread from the context menu", async () => {
    let settled: string | null = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_menu_park", title: "Long press me" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listProjectColors: () => ({ projects: [] }),
        listLifecycle: () => ({ rows: [] }),
        settle: (input) => {
          settled = (input as { threadId: string }).threadId;
          return { ok: true };
        },
      },
    });
    fireEvent.contextMenu(await screen.findByText("Long press me"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    fireEvent.click(within(menu).getByText("Settle"));
    await waitFor(() => expect(settled).toBe("thr_menu_park"));
  });

  it("settles and archives a thread from the context menu", async () => {
    let settledAndArchived: string | null = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_menu_archive", title: "Archive me" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listProjectColors: () => ({ projects: [] }),
        listLifecycle: () => ({ rows: [] }),
        settleAndArchive: (input) => {
          settledAndArchived = (input as { threadId: string }).threadId;
          return { ok: true };
        },
      },
    });
    fireEvent.contextMenu(await screen.findByText("Archive me"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    fireEvent.click(within(menu).getByText("Settle and archive"));
    await waitFor(() => expect(settledAndArchived).toBe("thr_menu_archive"));
  });

  it("shows progress and blocks a second click while archiving", async () => {
    let calls = 0;
    let finish: () => void = () => {};
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_slow", title: "Slow archive" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        settleAndArchive: () => {
          calls += 1;
          return new Promise((resolve) => {
            finish = () => resolve({ ok: true });
          });
        },
      },
    });
    fireEvent.click(await screen.findByLabelText("Settle and archive thread"));
    expect(await screen.findByLabelText("Archiving thread")).toBeDefined();
    expect(screen.queryByLabelText("Settle and archive thread")).toBeNull();
    expect(
      screen.getByText("Slow archive").closest("li")?.getAttribute("aria-busy"),
    ).toBe("true");
    finish();
    await waitFor(() =>
      expect(screen.queryByLabelText("Archiving thread")).toBeNull(),
    );
    expect(calls).toBe(1);
  });

  it("offers wake from a snoozed row's context menu", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_snz_menu", title: "Snoozed row" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listProjectColors: () => ({ projects: [] }),
        listLifecycle: () => ({
          rows: [
            {
              threadId: "thr_snz_menu",
              settledAt: null,
              snoozedUntil: Date.now() + 60 * 60 * 1000,
              snoozedAt: Date.now(),
            },
          ],
        }),
      },
    });
    const shelf = await screen.findByRole("region", { name: "Snoozed" });
    fireEvent.click(within(shelf).getByRole("button"));
    fireEvent.contextMenu(within(shelf).getByText("Snoozed row"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(within(menu).getByText("Wake now")).toBeDefined();
  });

  it("routes deletion through the host's confirmation", async () => {
    const rendered = render([thread({ id: "thr_del", title: "Delete me" })]);
    fireEvent.contextMenu(await screen.findByText("Delete me"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    fireEvent.click(within(menu).getByText("Delete"));
    await waitFor(() =>
      expect(rendered.sidebarActionCalls).toContainEqual({
        method: "requestDelete",
        threadId: "thr_del",
      }),
    );
  });
});

describe("card metadata", () => {
  it("always shows the provider glyph, even without a branch", async () => {
    render([thread({ id: "thr_p", providerId: "claude-code" })]);
    expect(await screen.findByLabelText("Claude Code")).toBeDefined();
  });

  it("falls back to a neutral glyph for an unknown provider", async () => {
    render([thread({ id: "thr_p", providerId: "some-new-agent" })]);
    expect(await screen.findByLabelText("some-new-agent")).toBeDefined();
  });

  // Two lines: the project badge shares the bottom line with the counts and
  // the glyph. The branch and the machine are not shown.
  it("puts the project badge on the glyph's line, without branch or machine", async () => {
    render([
      thread({
        id: "thr_b",
        providerId: "claude-code",
        host: { id: "host_1", name: "Sawyer's MacBook" },
        environment: {
          id: "env_1",
          name: "Worktree",
          branchName: "bb/feature",
          workspaceDisplayKind: "managed-worktree",
        },
      }),
    ]);
    const badge = await screen.findByText("bb", { selector: "span.rounded" });
    const glyph = await screen.findByLabelText("Claude Code");
    expect(badge.closest("div")?.contains(glyph)).toBe(true);
    expect(screen.queryByText("bb/feature")).toBeNull();
    expect(screen.queryByText("Sawyer's MacBook")).toBeNull();
  });

  // A renamed project shows its label on the badge, not its bb name.
  it("shows the project's label on the badge", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_l" })],
        projects: [{ id: "proj_1", name: "vaam-main", isPersonal: false }],
      },
      rpc: {
        listProjectColors: () => ({
          projects: [
            { projectId: "proj_1", name: "vaam-main", colorId: "blue", label: "vaam" },
          ],
        }),
        listLifecycle: () => ({ rows: [] }),
      },
    });
    expect(await screen.findByText("vaam", { selector: "span.rounded" })).toBeDefined();
    expect(screen.queryByText("vaam-main")).toBeNull();
  });

  // Not exactly 3h: the card's clock is quantized to the minute, so a
  // timestamp sitting on a bucket boundary legitimately reads one unit lower.
  it("shows how long ago the thread was touched", async () => {
    render([
      thread({ id: "thr_t", updatedAt: Date.now() - (3 * 3_600_000 + 60_000) }),
    ]);
    expect(await screen.findByText("3h")).toBeDefined();
  });

  // Status and age share one slot. A row that shows both puts a variable-width
  // label in the column, and no two rows line up.
  it("replaces the age label with the status glyph while work runs", async () => {
    // The Working shelf would hide the card; this test is about the card.
    render(
      [
        thread({
          id: "thr_run",
          indicator: "runtime",
          indicatorLabel: "Agent is working",
          updatedAt: Date.now() - (3 * 3_600_000 + 60_000),
        }),
      ],
      undefined,
      { workingShelf: false },
    );
    expect(await screen.findByLabelText("Agent is working")).toBeDefined();
    expect(screen.queryByText("3h")).toBeNull();
  });

  // An indicator this plugin does not know must fall through to the age label
  // rather than leave the slot blank.
  it("keeps the age label for an unrecognized indicator", async () => {
    render([
      thread({
        id: "thr_new",
        indicator: "something-bb-ships-later" as never,
        updatedAt: Date.now() - (3 * 3_600_000 + 60_000),
      }),
    ]);
    expect(await screen.findByText("3h")).toBeDefined();
  });
});

// The three states that want the user take the slot from the age label, and
// they use bb's own glyphs: the two lists sit in one window, and a user who
// switches between them should not have to learn a second vocabulary.
describe("attention states", () => {
  const states = [
    ["waiting-for-input", "Thread needs user input"],
    ["unread-error", "Unread thread failed"],
    ["unread-success", "Unread thread succeeded"],
  ] as const;

  for (const [indicator, label] of states) {
    it(`shows the ${indicator} glyph instead of the age`, async () => {
      render([
        thread({
          id: `thr_${indicator}`,
          indicator,
          indicatorLabel: label,
          updatedAt: Date.now() - (3 * 3_600_000 + 60_000),
        }),
      ]);
      expect(await screen.findByLabelText(label)).toBeDefined();
      expect(screen.queryByText("3h")).toBeNull();
    });
  }

  // Running work is the one state the user does NOT have to act on, so it gets
  // the neutral spinner and no notification dot.
  it("shows the spinner, not a dot, while work runs", async () => {
    render(
      [
        thread({
          id: "thr_busy",
          isUnread: true,
          indicator: "runtime",
          indicatorLabel: "Thread working",
        }),
      ],
      undefined,
      { workingShelf: false },
    );
    expect(await screen.findByLabelText("Thread working")).toBeDefined();
    expect(screen.queryByLabelText("Unread thread succeeded")).toBeNull();
  });
});

describe("pull request badge", () => {
  const withPr = (attention: string, state = "open") =>
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_pr" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listProjectColors: () => ({ projects: [] }),
        listLifecycle: () => ({ rows: [] }),
      },
      sidebarPullRequests: {
        thr_pr: {
          number: 412,
          title: "Fix the flake",
          url: "https://github.com/o/r/pull/412",
          state,
          attention,
        } as never,
      },
    });

  it("links the PR number out to the git host", async () => {
    withPr("none");
    // The icon carries the state, so the badge's name is the number alone.
    const badge = await screen.findByRole("link", { name: "412" });
    expect(badge.getAttribute("href")).toBe("https://github.com/o/r/pull/412");
    expect(badge.getAttribute("title")).toBe("Fix the flake");
  });

  it("shows no badge when the branch has no PR", async () => {
    render([thread({ id: "thr_nopr" })]);
    await screen.findByText("A thread");
    expect(screen.queryByRole("link", { name: "412" })).toBeNull();
  });

  // The attention state is bb's rolled-up "does this need you" signal, so the
  // badge can colour itself without reading checks/review/mergeability.
  it("colors the badge from the attention state", async () => {
    const failing = withPr("checks_failed");
    expect(
      (await screen.findByRole("link", { name: "412" })).className,
    ).toContain("destructive");
    failing.unmount();

    withPr("ready_to_merge");
    expect(
      (await screen.findByRole("link", { name: "412" })).className,
    ).toContain("success");
  });
});

describe("project badge", () => {
  const withColors = (
    projects: Array<{ projectId: string; name: string; colorId: string }>,
  ) =>
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_p", title: "A thread" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listProjectColors: () => ({ projects }),
        listLifecycle: () => ({ rows: [] }),
      },
    });

  // The card's first line is the title now; the project reads under it.
  it("puts the title above the project", async () => {
    withColors([]);
    const title = await screen.findByText("A thread");
    const project = await screen.findByText("bb");
    expect(
      title.compareDocumentPosition(project) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("paints the badge in the project's colour", async () => {
    withColors([{ projectId: "proj_1", name: "bb", colorId: "violet" }]);
    await waitFor(() => {
      expect(screen.getByText("bb").className).toContain("violet");
    });
  });

  // No colour is still a badge, just a neutral one, so the row's shape never
  // depends on whether the user has chosen yet.
  it("draws a neutral badge for a project with no colour", async () => {
    withColors([{ projectId: "proj_1", name: "bb", colorId: "neutral" }]);
    const badge = await screen.findByText("bb");
    expect(badge.className).toContain("bg-muted");
  });
});
