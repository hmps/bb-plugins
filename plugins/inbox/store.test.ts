import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { itemSchema } from "./contract";
import { DETECTION_LOG_KEEP, createStore, type NewItem } from "./store";

const T0 = 1_800_000_000_000;

function setup() {
  let clock = T0;
  const db = new Database(":memory:");
  const store = createStore(db, () => clock);
  return {
    store,
    db,
    advance(ms: number) {
      clock += ms;
    },
  };
}

const ask: NewItem = {
  threadId: "thr_a",
  projectId: "proj_1",
  threadTitle: "A thread",
  projectName: "Project",
  parentThreadId: null,
  kind: "approve",
  question: "Ship it?",
  context: "Some context",
  options: ["Yes", "No"],
  recommendation: "Yes",
  source: "tool",
};

describe("store lifecycle", () => {
  it("creates an open, unread item that matches the contract", () => {
    const { store } = setup();
    const item = store.insert(ask);
    expect(item.id).toMatch(/^inb_[A-Za-z0-9_-]{10}$/);
    expect(itemSchema.parse(item)).toEqual(item);
    expect(item).toMatchObject({ status: "open", readAt: null, askCount: 1, createdAt: T0 });
    expect(store.counts()).toEqual({ openCount: 1, snoozedCount: 0, unreadCount: 1 });
  });

  it("marks read without closing", () => {
    const { store } = setup();
    const item = store.insert(ask);
    const read = store.markRead(item.id);
    expect(read).toMatchObject({ status: "open", readAt: T0 });
    expect(store.counts()).toEqual({ openCount: 1, snoozedCount: 0, unreadCount: 0 });
  });

  it("snoozes and turns back open and unread when the time passes", () => {
    const { store, advance } = setup();
    const item = store.insert(ask);
    store.markRead(item.id);
    store.snooze(item.id, T0 + 60_000);
    expect(store.get(item.id)).toMatchObject({ status: "snoozed", snoozedUntil: T0 + 60_000 });
    expect(store.counts().openCount).toBe(0);

    advance(60_000);
    expect(store.wakeSnoozed()).toBe(1);
    expect(store.get(item.id)).toMatchObject({ status: "open", readAt: null, snoozedUntil: null });
    expect(store.counts()).toEqual({ openCount: 1, snoozedCount: 0, unreadCount: 1 });
  });

  it("bumps a repeat instead of adding a duplicate", () => {
    const { store, advance } = setup();
    const item = store.insert(ask);
    advance(1000);
    const repeat = store.findRepeat("thr_a", "  ship IT ", ["tool"]);
    expect(repeat?.id).toBe(item.id);
    const bumped = store.bump(item.id, { recommendation: "No", context: "Newer" });
    expect(bumped).toMatchObject({ askCount: 2, lastAskedAt: T0 + 1000, recommendation: "No", context: "Newer" });
    expect(store.list()).toHaveLength(1);
    expect(store.findRepeat("thr_b", "Ship it?", ["tool"])).toBeNull();
  });

  it("closes on answer and on thread archive", () => {
    const { store } = setup();
    const answered = store.insert(ask);
    const other = store.insert({ ...ask, question: "Other?" });
    const elsewhere = store.insert({ ...ask, threadId: "thr_b" });

    expect(store.close(answered.id, "answered", "Yes")).toMatchObject({
      status: "closed",
      closeReason: "answered",
      answer: "Yes",
      closedAt: T0,
    });
    expect(store.closeThread("thr_a", "archived")).toEqual([other.id]);
    expect(store.get(other.id)?.closeReason).toBe("archived");
    expect(store.list().map((item) => item.id)).toEqual([elsewhere.id]);
    expect(store.list({ includeClosed: true })).toHaveLength(3);
  });

  it("keeps the last detection log rows", () => {
    const { store, db } = setup();
    const row = {
      threadId: "thr_a",
      at: T0,
      outcome: "no-ask" as const,
      scores: { ask: 0.1, novelty: null, resolved: {} },
      passTwoRan: false,
      createdIds: [],
      repeatedIds: [],
      resolvedIds: [],
      durationMs: 5,
      error: null,
    };
    db.exec("BEGIN");
    for (let i = 0; i < DETECTION_LOG_KEEP + 3; i++) store.logDetection(row);
    db.exec("COMMIT");
    const count = db.prepare("SELECT COUNT(*) AS n FROM detection_log").get() as { n: number };
    expect(count.n).toBe(DETECTION_LOG_KEEP);
    expect(store.listDetections(1)[0]).toMatchObject({ outcome: "no-ask", scores: row.scores });
  });
});
