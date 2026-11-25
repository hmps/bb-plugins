import { experimental_BbHttpError } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import {
  DECISIONS_PLUGIN_ID,
  DECISIONS_RENDERER_ID,
  ITEMS_CHANGED,
  PUSH_METHOD,
  PUSH_PLUGIN_ID,
  TOOL_NAME,
  cliItemSchema,
  type DetectorOptions,
  type DetectionInput,
  type DetectionResult,
  type Item,
} from "./contract";
import { createDetector as createOpenAiDetector } from "./detection";
import { createInboxPlugin } from "./server";

const T0 = 1_800_000_000_000;

function result(overrides: Partial<DetectionResult> = {}): DetectionResult {
  return {
    outcome: "no-ask",
    scores: { ask: 0.1, novelty: null, resolved: {} },
    passTwoRan: false,
    asks: [],
    resolvedItemIds: [],
    error: null,
    durationMs: 12,
    ...overrides,
  };
}

function card(overrides: Record<string, unknown> = {}) {
  return {
    id: "pint_1",
    threadId: "thr_a",
    status: "pending",
    createdAt: T0,
    expiresAt: T0 + 7 * 86_400_000,
    origin: { kind: "plugin", pluginId: DECISIONS_PLUGIN_ID, rendererId: DECISIONS_RENDERER_ID },
    payload: {
      kind: "plugin",
      title: "Decide",
      data: {
        headline: "Pick a database",
        decisions: [
          {
            question: "Which database?",
            context: "We need one.",
            options: [
              { label: "Pick A", does: "a" },
              { label: "Pick B", does: "b" },
            ],
            suggested: 1,
            links: [{ label: "Doc", href: "https://example.com" }],
          },
        ],
      },
    },
    resolution: null,
    resolvedAt: null,
    statusReason: null,
    turnId: null,
    ...overrides,
  };
}

async function setup(options: {
  settings?: Record<string, unknown>;
  parents?: Record<string, string>;
  fetch?: typeof fetch;
} = {}) {
  const clock = { now: T0 };
  const detect = vi.fn(async (_input: DetectionInput): Promise<DetectionResult> => result());
  const createDetector = vi.fn((config: DetectorOptions) => ({
    detect,
    checkAnswer: createOpenAiDetector({ ...config, fetch: options.fetch }).checkAnswer,
  }));
  const parents = options.parents ?? {};
  const thread = (id: string) =>
    makeThreadResponse({ id, projectId: "proj_1", title: `Thread ${id}`, parentThreadId: parents[id] ?? null });

  const { bb, harness } = createFakePluginHost({
    pluginId: "inbox",
    settings: { pings: true, ...options.settings },
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => thread(threadId),
        send: async () => ({}),
        list: async () => [],
        interactions: {
          respond: async () => card({ status: "resolved" }),
          get: async () => card(),
          cancel: async () => ({}),
          list: async () => [],
        },
      },
      projects: { get: async () => ({ id: "proj_1", name: "Project" }) },
      plugins: { callRpc: async () => ({ ok: true, channels: ["web"] }) },
    } as never,
  });
  await createInboxPlugin({ createDetector, now: () => clock.now })(bb);

  const calls = (path: string) => harness.inspection.sdk.callsTo(path) as Record<string, unknown>[][];
  const pings = () => calls("plugins.callRpc").map(([args]) => args!);
  const sends = () => calls("threads.send").map(([args]) => args!);
  const sentText = (index = -1) => {
    const send = sends().at(index) as { input: { text: string }[] };
    return send.input[0]!.text;
  };
  const list = async () =>
    ((await harness.behavior.callRpc("items_list", {})) as { items: Item[] }).items;
  const idle = (id: string, text: string | null) =>
    harness.behavior.emitThreadEvent("thread.idle", { thread: thread(id), lastAssistantText: text });

  return { bb, harness, clock, detect, createDetector, thread, calls, pings, sends, sentText, list, idle };
}

describe("answers in the thread", () => {
  const threadId = "thr_a";

  async function setupAnswers(settings: Record<string, unknown> = {}) {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const t = await setup({ settings: { openaiApiKey: "test-key", ...settings }, fetch });
    const add = async (question: string) => {
      await t.harness.behavior.callAgentTool(TOOL_NAME, {
        kind: "decide", question, options: ["Blue", "Green"], recommendation: "Blue",
      }, { threadId });
      return (await t.list()).find((item) => item.question === question)!;
    };
    const rows: { type: string; seq: number; createdAt: number; data: unknown }[] = [];
    t.harness.sdk.stub("threads.events.list", async ({ afterSeq, beforeSeq }) =>
      rows.filter(({ seq }) => seq > Number(afterSeq) && seq < Number(beforeSeq)).reverse() as never);
    const emit = (sequence: number) =>
      t.harness.behavior.emitThreadEvent("experimental_thread.events", { thread: t.thread(threadId), sequence });
    const append = (text: string, data: Record<string, unknown> = {}) => {
      const seq = rows.length + 1;
      rows.push({
        type: "client/turn/requested", seq, createdAt: t.clock.now,
        data: { initiator: "user", senderThreadId: null, input: [{ type: "text", text }], ...data },
      });
      return seq;
    };
    return { ...t, fetch, add, emit, append };
  }

  it("closes only the matching item before the turn ends and logs the close", async () => {
    const t = await setupAnswers({ answerThreshold: 0.9 });
    const oldSeq = t.append("Blue");
    t.clock.now++;
    const matching = await t.add("Which color should I use?");
    const other = await t.add("Which color should I use for the sidebar?");
    await t.harness.behavior.emitThreadEvent("interaction.pending", {
      thread: t.thread(threadId), interaction: card() as never,
    });
    await t.emit(oldSeq);
    expect(t.fetch).not.toHaveBeenCalled();

    t.fetch.mockResolvedValueOnce(Response.json({
      answers: [
        { type: "predicate", name: `answered_${matching.id}`, probability: 0.9 },
        { type: "predicate", name: `answered_${other.id}`, probability: 0.89 },
      ],
    }));
    const seq = t.append("Use green for the header.");
    await Promise.all([t.emit(seq), t.emit(seq)]);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    const [url, request] = t.fetch.mock.calls[0]!;
    expect(url).toMatch(/\/decisions$/);
    const body = JSON.parse(String(request?.body));
    expect(body.questions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: `answered_${matching.id}`, type: "predicate" }),
      expect.objectContaining({ name: `answered_${other.id}`, type: "predicate" }),
    ]));
    expect(body.questions).toHaveLength(2);
    expect(JSON.parse(body.input)).toEqual({
      message: "Use green for the header.",
      openItems: expect.arrayContaining([{
        id: matching.id, question: matching.question, options: ["Blue", "Green"], recommendation: "Blue",
      }]),
    });
    expect((await t.list()).map((item) => item.source).sort()).toEqual(["card", "tool"]);
    expect(await t.harness.behavior.callRpc("items_get", { id: matching.id })).toMatchObject({
      status: "closed", closeReason: "answered-in-thread", answer: "Use green for the header.",
    });
    const log = await t.harness.behavior.runCli(["detections"]);
    expect(log.stdout).toContain("answered-in-thread");
    expect(log.stdout).toContain(matching.id);
    expect(log.stdout).not.toContain(other.id);
    expect(t.detect).not.toHaveBeenCalled();
  });

  it("leaves the item open for unrelated user messages", async () => {
    const t = await setupAnswers();
    const item = await t.add("Which color should I use?");
    t.fetch.mockResolvedValueOnce(Response.json({
      answers: [{ type: "predicate", name: `answered_${item.id}`, probability: 0.1 }],
    }));
    await t.emit(t.append("What is the time?"));
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(await t.list()).toEqual([item]);
  });

  it("ignores inbox replies and agent messages", async () => {
    const t = await setupAnswers();
    const item = await t.add("Which color should I use?");
    const other = await t.add("Which color should I use for the sidebar?");
    await t.harness.behavior.callRpc("items_answer", { id: item.id, text: "Blue" });
    t.append(t.sentText());
    t.append("Use green", { originPluginId: "inbox" });
    t.append("Use green", { senderThreadId: "thr_other" });
    t.append("Use green", { initiator: "agent" });
    await t.emit(t.append("[bb message from thread:thr_other]\nUse green"));
    expect(t.fetch).not.toHaveBeenCalled();
    expect(await t.list()).toEqual([other]);
  });

  it("makes no OpenAI or event history call without a key", async () => {
    const t = await setupAnswers({ openaiApiKey: "" });
    const item = await t.add("Which color should I use?");
    await t.emit(t.append("Use green"));
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.calls("threads.events.list")).toHaveLength(0);
    expect(await t.list()).toEqual([item]);
  });
});

describe("card mirror", () => {
  it("mirrors a pending card into one item with parsed fields", async () => {
    const t = await setup();
    const event = { thread: t.thread("thr_a"), interaction: card() as never };
    await t.harness.behavior.emitThreadEvent("interaction.pending", event);
    await t.harness.behavior.emitThreadEvent("interaction.pending", event);

    const items = await t.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: "card",
      kind: "decide",
      question: "Which database?",
      options: ["Pick A", "Pick B"],
      recommendation: "Pick B",
      threadTitle: "Thread thr_a",
      projectName: "Project",
      status: "open",
    });
    expect(items[0]!.context).toContain("We need one.");
    expect(items[0]!.context).toContain("[Doc](https://example.com)");
    expect(items[0]!.card?.interactionId).toBe("pint_1");
    expect(t.pings()).toHaveLength(1);
    expect(t.harness.realtimeSignals.at(-1)).toMatchObject({
      channel: ITEMS_CHANGED,
      payload: { openCount: 1, unreadCount: 1 },
    });
  });

  it("answers the card through threads.interactions.respond", async () => {
    const t = await setup();
    await t.harness.behavior.emitThreadEvent("interaction.pending", {
      thread: t.thread("thr_a"),
      interaction: card() as never,
    });
    const [item] = await t.list();

    const answered = (await t.harness.behavior.callRpc("items_answer", {
      id: item!.id,
      acceptRecommendation: true,
    })) as Item;

    expect(t.calls("threads.interactions.respond")[0]![0]).toEqual({
      threadId: "thr_a",
      interactionId: "pint_1",
      value: { answers: [{ option: 1 }] },
    });
    expect(answered).toMatchObject({
      status: "closed",
      closeReason: "answered",
      answer: "Decision 1 — Which database?: Pick B",
    });
  });

  it("closes with card-settled when the card settled outside the inbox", async () => {
    const t = await setup();
    await t.harness.behavior.emitThreadEvent("interaction.pending", {
      thread: t.thread("thr_a"),
      interaction: card() as never,
    });
    t.harness.sdk.stub("threads.interactions.get", async () =>
      card({
        status: "resolved",
        resolution: {
          kind: "plugin_submitted",
          description: { title: "Decided: Pick a database", detail: "- Decision 1 — Which database?: Pick A" },
        },
      }),
    );
    await t.idle("thr_a", null);

    const [item] = (await t.harness.behavior.callRpc("items_list", { includeClosed: true }) as { items: Item[] }).items;
    expect(item).toMatchObject({
      status: "closed",
      closeReason: "card-settled",
      answer: "- Decision 1 — Which database?: Pick A",
    });
  });

  it("closes with card-settled when respond fails on a settled card", async () => {
    const t = await setup();
    await t.harness.behavior.emitThreadEvent("interaction.pending", {
      thread: t.thread("thr_a"),
      interaction: card() as never,
    });
    const [item] = await t.list();
    t.harness.sdk.stub("threads.interactions.respond", async () => {
      throw new experimental_BbHttpError({ status: 409, code: "not_pending", body: null, message: "not pending" } as never);
    });
    t.harness.sdk.stub("threads.interactions.get", async () => card({ status: "interrupted" }));

    await expect(
      t.harness.behavior.callRpc("items_answer", { id: item!.id, answers: [{ option: 0 }] }),
    ).rejects.toThrow(/already settled/);
    const closed = (await t.harness.behavior.callRpc("items_get", { id: item!.id })) as Item;
    expect(closed).toMatchObject({ status: "closed", closeReason: "card-settled" });
  });

  it("reports no conflict when a network error hides a landed answer", async () => {
    const t = await setup();
    await t.harness.behavior.emitThreadEvent("interaction.pending", {
      thread: t.thread("thr_a"),
      interaction: card() as never,
    });
    const [item] = await t.list();
    t.harness.sdk.stub("threads.interactions.respond", async () => {
      throw new TypeError("fetch failed");
    });
    t.harness.sdk.stub("threads.interactions.get", async () => card({ status: "resolved" }));
    const closed = (await t.harness.behavior.callRpc("items_answer", {
      id: item!.id,
      answers: [{ option: 0 }],
    })) as Item;
    expect(closed).toMatchObject({ status: "closed", closeReason: "card-settled" });
  });

  it("keeps the item open when the cancel fails and the card still waits", async () => {
    const t = await setup();
    await t.harness.behavior.emitThreadEvent("interaction.pending", {
      thread: t.thread("thr_a"),
      interaction: card() as never,
    });
    const [item] = await t.list();
    t.harness.sdk.stub("threads.interactions.cancel", async () => {
      throw new Error("fetch failed");
    });
    await expect(t.harness.behavior.callRpc("items_dismiss", { id: item!.id })).rejects.toThrow();
    expect(await t.list()).toHaveLength(1);
  });
});

describe("races and archived threads", () => {
  it("sends one answer when two clients answer at once", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool(TOOL_NAME, { kind: "decide", question: "Ship?" }, { threadId: "thr_a" });
    const [item] = await t.list();
    let release!: () => void;
    t.harness.sdk.stub("threads.send", () => new Promise((resolve) => (release = () => resolve({}))));
    const first = t.harness.behavior.callRpc("items_answer", { id: item!.id, text: "Yes" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(
      t.harness.behavior.callRpc("items_answer", { id: item!.id, text: "No" }),
    ).rejects.toThrow(/being handled/);
    release();
    expect(await first).toMatchObject({ status: "closed", answer: "Yes" });
    expect(t.calls("threads.send")).toHaveLength(1);
  });

  it("refuses bb inbox ask for an archived thread", async () => {
    const t = await setup();
    t.harness.sdk.stub("threads.get", async () => ({ ...t.thread("thr_a"), archivedAt: T0 }));
    const run = t.harness.behavior
      .runCli(["ask", "--kind", "do", "--question", "Late"], {
        threadId: "thr_a",
        signal: new AbortController().signal,
      })
      .then((out) => out.exitCode, () => 1);
    expect(await run).not.toBe(0);
    expect(await t.list()).toHaveLength(0);
  });

  it("adds no detected item when the thread was archived during detection", async () => {
    const t = await setup({ settings: { openaiApiKey: "sk-test" } });
    t.detect.mockImplementationOnce(async () => {
      await t.harness.behavior.emitThreadEvent("thread.archived", { thread: t.thread("thr_a") });
      return result({
        outcome: "asks",
        passTwoRan: true,
        asks: [
          { kind: "approve", question: "Merge?", options: null, recommendation: null, context: null, repeatOfItemId: null },
        ],
      });
    });
    await t.idle("thr_a", "May I merge?");
    expect(t.detect).toHaveBeenCalledTimes(1);
    expect(await t.list()).toHaveLength(0);
    expect(t.pings()).toHaveLength(0);
  });
});

describe("inbox_ask", () => {
  it("creates an item and pings; a repeat bumps it without a ping", async () => {
    const t = await setup();
    const input = {
      kind: "approve",
      question: "Deploy to prod?",
      recommendation: "Yes",
      ref: "ENG-1",
    };
    const first = await t.harness.behavior.callAgentTool(TOOL_NAME, input, { threadId: "thr_a" });
    expect(String(first)).toMatch(/Added to the user's inbox as inb_\w+/);
    expect(t.pings()).toEqual([
      expect.objectContaining({
        pluginId: PUSH_PLUGIN_ID,
        method: PUSH_METHOD,
        input: { title: "Inbox · Approve", body: "Deploy to prod?", threadId: "thr_a" },
      }),
    ]);

    t.clock.now += 5000;
    const second = await t.harness.behavior.callAgentTool(TOOL_NAME, { ...input, question: "deploy to prod" }, { threadId: "thr_a" });
    expect(String(second)).toContain("asked 2 times");
    const items = await t.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ askCount: 2, lastAskedAt: T0 + 5000, source: "tool" });
    expect(t.pings()).toHaveLength(1);
  });

  it("sends the answer to the thread and closes the item", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool(
      TOOL_NAME,
      { kind: "decide", question: "Which name?", ref: "ENG-2" },
      { threadId: "thr_a" },
    );
    const [item] = await t.list();
    const closed = (await t.harness.behavior.callRpc("items_answer", { id: item!.id, text: "Call it Atlas" })) as Item;

    expect(t.sends()[0]).toMatchObject({ threadId: "thr_a", mode: "auto" });
    expect(t.sentText()).toBe(`[Inbox] Answer to ${item!.id} (ref: ENG-2): Which name?\n\nCall it Atlas`);
    expect(closed).toMatchObject({ status: "closed", closeReason: "answered", answer: "Call it Atlas" });
  });

  it("hands an item to the parent thread", async () => {
    const t = await setup({ parents: { thr_child: "thr_parent" } });
    await t.harness.behavior.callAgentTool(TOOL_NAME, { kind: "do", question: "Rotate the key" }, { threadId: "thr_child" });
    const [item] = await t.list();
    const closed = (await t.harness.behavior.callRpc("items_hand_to_parent", { id: item!.id, note: "you do it" })) as Item;
    expect(t.sends()[0]).toMatchObject({ threadId: "thr_parent" });
    expect(t.sentText()).toContain("@thread:thr_child");
    expect(closed.closeReason).toBe("handed");
  });

  it("closes a thread's items when the thread is archived", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool(TOOL_NAME, { kind: "do", question: "Rotate the key" }, { threadId: "thr_a" });
    await t.harness.behavior.emitThreadEvent("thread.archived", { thread: t.thread("thr_a") });
    expect(await t.list()).toHaveLength(0);
  });
});

describe("detection", () => {
  const key = { openaiApiKey: "sk-test-key" };

  it("logs a turn with no ask and creates nothing", async () => {
    const t = await setup({ settings: key });
    await t.idle("thr_a", "All done.");
    expect(t.detect).toHaveBeenCalledWith(
      { threadId: "thr_a", reply: "All done.", openItems: [] },
      expect.anything(),
    );
    expect(await t.list()).toHaveLength(0);
    const rows = JSON.parse((await t.harness.behavior.runCli(["detections", "--json"])).stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ threadId: "thr_a", outcome: "no-ask", passTwoRan: false });
  });

  it("creates a new ask, bumps a repeat, and resolves an item", async () => {
    const t = await setup({ settings: key });
    const ask = {
      kind: "approve" as const,
      question: "May I merge PR 12?",
      options: null,
      recommendation: "Merge",
      context: null,
      repeatOfItemId: null,
    };
    t.detect.mockResolvedValueOnce(result({ outcome: "asks", passTwoRan: true, asks: [ask] }));
    await t.idle("thr_a", "May I merge PR 12?");
    const [created] = await t.list();
    expect(created).toMatchObject({ source: "detected", kind: "approve", question: "May I merge PR 12?", askCount: 1 });
    expect(t.pings()).toHaveLength(1);

    t.detect.mockResolvedValueOnce(
      result({ outcome: "asks", passTwoRan: true, asks: [{ ...ask, repeatOfItemId: created!.id }] }),
    );
    await t.idle("thr_a", "Again: may I merge PR 12?");
    expect(t.detect.mock.calls[1]![0].openItems).toEqual([
      expect.objectContaining({ id: created!.id, source: "detected", askCount: 1 }),
    ]);
    const [repeated] = await t.list();
    expect(repeated).toMatchObject({ id: created!.id, askCount: 2 });
    expect(t.pings()).toHaveLength(1);

    t.detect.mockResolvedValueOnce(result({ outcome: "resolved-only", resolvedItemIds: [created!.id] }));
    await t.idle("thr_a", "Merged it myself after all.");
    expect(await t.list()).toHaveLength(0);
    const closed = (await t.harness.behavior.callRpc("items_get", { id: created!.id })) as Item;
    expect(closed.closeReason).toBe("resolved");
  });

  it("is off without a key: no detector, status disabled", async () => {
    const t = await setup();
    await t.idle("thr_a", "Should I deploy?");
    expect(t.createDetector).not.toHaveBeenCalled();
    expect(t.detect).not.toHaveBeenCalled();
    const status = (await t.harness.behavior.callRpc("status", null)) as { detection: unknown };
    expect(status.detection).toEqual({ enabled: false, reason: "no OpenAI API key set", model: "gpt-6-luna" });
    const cli = JSON.parse((await t.harness.behavior.runCli(["status", "--json"])).stdout);
    expect(cli.detection.enabled).toBe(false);
  });

  it("skips a child thread and an empty reply", async () => {
    const t = await setup({ settings: key, parents: { thr_child: "thr_parent" } });
    await t.idle("thr_child", "Report for the parent.");
    await t.idle("thr_a", "   ");
    expect(t.detect).not.toHaveBeenCalled();
  });
});

describe("CLI", () => {
  it("lists open items as cliItemSchema JSON; --all adds snoozed", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool(TOOL_NAME, { kind: "do", question: "One" }, { threadId: "thr_a" });
    const ask = await t.harness.behavior.runCli(
      ["ask", "--kind", "decide", "--question", "Two", "--option", "A", "--option", "B", "--json"],
      { threadId: "thr_b", signal: new AbortController().signal },
    );
    expect(ask.exitCode).toBe(0);
    const snoozeId = JSON.parse(ask.stdout).item.id as string;
    await t.harness.behavior.callRpc("items_snooze", { id: snoozeId, until: T0 + 3_600_000 });

    const open = JSON.parse((await t.harness.behavior.runCli(["list", "--json"])).stdout) as unknown[];
    expect(open).toHaveLength(1);
    for (const row of open) {
      expect(Object.keys(row as object).sort()).toEqual(Object.keys(cliItemSchema.shape).sort());
      expect(cliItemSchema.strict().parse(row)).toEqual(row);
    }
    expect(open[0]).toMatchObject({ question: "One", status: "open", createdAt: new Date(T0).toISOString() });

    const all = JSON.parse((await t.harness.behavior.runCli(["list", "--all", "--json"])).stdout) as { status: string }[];
    expect(all.map((row) => row.status).sort()).toEqual(["open", "snoozed"]);
  });

  it("refuses ask without a thread and closes by id", async () => {
    const t = await setup();
    const noThread = await t.harness.behavior.runCli(["ask", "--kind", "do", "--question", "X"]);
    expect(noThread.exitCode).not.toBe(0);
    expect(noThread.stderr).toContain("--thread");

    await t.harness.behavior.runCli(["ask", "--kind", "do", "--question", "X", "--thread", "thr_a"]);
    const [item] = await t.list();
    const closed = await t.harness.behavior.runCli(["close", item!.id, "--json"]);
    expect(JSON.parse(closed.stdout)).toEqual({ id: item!.id, status: "closed", closeReason: "closed" });
    expect((await t.harness.behavior.runCli(["close", "inb_missing"])).exitCode).not.toBe(0);
  });
});
