// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Item } from "./contract";
import { resetInboxStore } from "./hooks/use-inbox";

const app = await loadPluginApp(() => import("./app"));
const panel = app.navPanels[0]!;

afterEach(() => {
  cleanup();
  resetInboxStore();
});

describe("rail icon", () => {
  it("points the nav panel at the registered tray icon, not a missing built-in", () => {
    expect(panel.icon).toBe("inbox/tray");
    expect(app.icons.map((icon) => icon.name)).toContain("inbox/tray");
  });
});

const NOW = Date.now();
const DETECTION = { enabled: false, reason: "no OpenAI API key set", model: "gpt-6-luna" };

function item(change: Partial<Item> = {}): Item {
  return {
    id: "inb_0000000001",
    threadId: "thr_a",
    projectId: "p1",
    threadTitle: "Fix login",
    projectName: "web",
    parentThreadId: null,
    kind: "decide",
    question: "Ship it now?",
    context: null,
    options: null,
    recommendation: null,
    ref: null,
    source: "tool",
    card: null,
    status: "open",
    createdAt: NOW - 60 * 60_000,
    updatedAt: NOW - 60 * 60_000,
    lastAskedAt: NOW - 60 * 60_000,
    askCount: 1,
    readAt: null,
    snoozedUntil: null,
    closedAt: null,
    closeReason: null,
    answer: null,
    messageSeq: null,
    ...change,
  };
}

const idOf = (input: unknown) => (input as { id: string }).id;

function rpcFor(items: Item[]): Record<string, (input: unknown) => unknown> {
  return {
    items_list: () => ({ items, detection: DETECTION }),
    items_mark_read: (input) => ({
      ...items.find((it) => it.id === idOf(input))!,
      readAt: NOW,
    }),
    items_answer: (input) => ({
      ...items.find((it) => it.id === idOf(input))!,
      status: "closed",
      closeReason: "answered",
    }),
  };
}

function callsTo(slot: ReturnType<typeof renderSlot>, method: string) {
  return slot.inspection.rpcCalls
    .filter((call) => call.method === method)
    .map((call) => call.input);
}

describe("badge", () => {
  function Probe() {
    const badge = panel.experimental_useBadge!();
    return <pre data-testid="badge">{JSON.stringify(badge)}</pre>;
  }

  it("counts open items, not snoozed ones, with warning tone while one is unread", async () => {
    renderSlot({ component: Probe }, {}, {
      rpc: rpcFor([
        item({ id: "a", readAt: null }),
        item({ id: "b", readAt: NOW }),
        item({ id: "c", status: "snoozed", snoozedUntil: NOW + 3_600_000 }),
      ]),
    });
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId("badge").textContent!)).toEqual({
        count: 2,
        label: "2 waiting",
        tone: "warning",
      }),
    );
  });

  it("is null when nothing waits", async () => {
    const slot = renderSlot({ component: Probe }, {}, { rpc: rpcFor([]) });
    await waitFor(() => expect(callsTo(slot, "items_list")).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toBe("null"));
  });
});

describe("sidebar", () => {
  it("puts unread first, then newest ask, and hides snoozed items in a collapsed group", async () => {
    const items = [
      item({ id: "read-new", question: "Read and new", readAt: NOW, lastAskedAt: NOW - 1_000 }),
      item({ id: "unread-old", question: "Unread and old", lastAskedAt: NOW - 86_400_000 }),
      item({ id: "unread-new", question: "Unread and new", lastAskedAt: NOW - 5_000, askCount: 3 }),
      item({ id: "sleeping", question: "Sleeping", status: "snoozed", snoozedUntil: NOW + 3_600_000 }),
    ];
    const slot = renderSlot(
      { component: panel.experimental_sidebar! },
      { subPath: "unread-old" },
      { rpc: rpcFor(items) },
    );

    const waiting = await screen.findByRole("list", { name: "Waiting" });
    const rows = within(waiting).getAllByRole("button");
    expect(rows.map((row) => row.dataset.itemId)).toEqual([
      "unread-new",
      "unread-old",
      "read-new",
    ]);
    expect(rows[1]!.getAttribute("aria-current")).toBe("page");
    expect(within(rows[0]!).getByText("×3")).toBeTruthy();
    expect(screen.queryByText("Sleeping")).toBeNull();

    const group = screen.getByRole("button", { name: /Snoozed \(1\)/ });
    expect(group.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(group);
    expect(screen.getByText("Sleeping")).toBeTruthy();

    fireEvent.click(rows[2]!);
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({
      method: "toPluginPanel",
      path: "inbox",
      options: { subPath: "read-new" },
    });
  });

  it("shows the empty state", async () => {
    renderSlot({ component: panel.experimental_sidebar! }, { subPath: "" }, { rpc: rpcFor([]) });
    expect(await screen.findByText("All clear")).toBeTruthy();
  });
});

describe("page", () => {
  it("shows the empty state and the detection status with no item selected", async () => {
    renderSlot(panel, { subPath: "" }, { rpc: rpcFor([]) });
    expect(
      await screen.findByRole("heading", { name: "Nothing waits on you." }),
    ).toBeTruthy();
    expect(
      await screen.findByText(
        "Final replies are not scanned for asks: no OpenAI API key set",
      ),
    ).toBeTruthy();
  });

  it("marks a tool item read once and answers it with the option text", async () => {
    const tool = item({ options: ["Ship it", "Wait"], recommendation: "Ship it" });
    const slot = renderSlot(panel, { subPath: tool.id }, { rpc: rpcFor([tool]) });

    await screen.findByRole("heading", { name: "Ship it now?" });
    await waitFor(() =>
      expect(callsTo(slot, "items_mark_read")).toEqual([{ id: tool.id }]),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Wait/ }));
    await waitFor(() =>
      expect(callsTo(slot, "items_answer")).toEqual([{ id: tool.id, text: "Wait" }]),
    );
    expect(await screen.findByText("Answered: Wait")).toBeTruthy();
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({
      method: "toPluginPanel",
      path: "inbox",
      options: { subPath: "" },
    });
    expect(callsTo(slot, "items_mark_read")).toHaveLength(1);
  });

  it("answers a one-decision card with the option index, or accepts the recommendation", async () => {
    const card = item({
      source: "card",
      readAt: NOW,
      card: {
        interactionId: "int_1",
        headline: "Pick a database",
        decisions: [
          {
            question: "Pick a database",
            context: "",
            options: [
              { label: "Postgres", does: "Use the managed one" },
              { label: "SQLite", does: "Keep it local" },
            ],
            suggested: 0,
            links: [],
          },
        ],
      },
    });
    const slot = renderSlot(panel, { subPath: card.id }, { rpc: rpcFor([card]) });

    fireEvent.click(await screen.findByRole("button", { name: /^SQLite/ }));
    await waitFor(() =>
      expect(callsTo(slot, "items_answer")).toEqual([
        { id: card.id, answers: [{ option: 1 }] },
      ]),
    );
    cleanup();
    resetInboxStore();

    const again = renderSlot(panel, { subPath: card.id }, { rpc: rpcFor([card]) });
    fireEvent.click(await screen.findByRole("button", { name: "Accept recommendation" }));
    await waitFor(() =>
      expect(callsTo(again, "items_answer")).toEqual([
        { id: card.id, acceptRecommendation: true },
      ]),
    );
    expect(callsTo(again, "items_mark_read")).toEqual([]);
  });

  it("submits one answer per decision for a multi-decision card", async () => {
    const decision = (question: string, suggested: number | null) => ({
      question,
      context: "",
      options: [
        { label: `${question} A`, does: "" },
        { label: `${question} B`, does: "" },
      ],
      suggested,
      links: [],
    });
    const card = item({
      source: "card",
      question: "Two choices",
      card: {
        interactionId: "int_2",
        headline: "Two choices",
        decisions: [decision("First", 0), decision("Second", null)],
      },
    });
    const slot = renderSlot(panel, { subPath: card.id }, { rpc: rpcFor([card]) });

    const submit = await screen.findByRole("button", { name: "Submit answers" });
    // No Accept: the second decision has no suggested option. No Reply either.
    expect(screen.queryByRole("button", { name: "Accept recommendation" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Own answer" })).toBeNull();
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /First B/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Own answer for decision 2" }), {
      target: { value: "Neither" },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(callsTo(slot, "items_answer")).toEqual([
        { id: card.id, answers: [{ option: 1 }, { text: "Neither" }] },
      ]),
    );
  });

  it("shows an RPC error inline and keeps the item", async () => {
    const tool = item({ readAt: NOW });
    renderSlot(panel, { subPath: tool.id }, {
      rpc: {
        ...rpcFor([tool]),
        items_dismiss: () => {
          throw new Error("server down");
        },
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect((await screen.findByRole("alert")).textContent).toContain("server down");
    expect(screen.getByRole("heading", { name: "Ship it now?" })).toBeTruthy();
  });
});
