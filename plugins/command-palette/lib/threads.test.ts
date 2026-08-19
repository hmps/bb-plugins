import { describe, expect, it } from "vitest";
import { isListable, searchValue, toPaletteThreads, type SourceThread } from "./threads";

function thread(over: Partial<SourceThread> = {}): SourceThread {
  return {
    id: "th_1",
    title: "Ship the palette",
    titleFallback: null,
    projectId: "proj_1",
    updatedAt: 100,
    latestAttentionAt: 100,
    lastReadAt: 100,
    pinnedAt: null,
    archivedAt: null,
    visibility: "visible",
    ...over,
  };
}

const names = new Map([["proj_1", "bb-plugins"]]);

describe("isListable", () => {
  it("drops archived and hidden threads", () => {
    expect(isListable(thread())).toBe(true);
    expect(isListable(thread({ archivedAt: 1 }))).toBe(false);
    expect(isListable(thread({ visibility: "hidden" }))).toBe(false);
  });
});

describe("toPaletteThreads", () => {
  it("maps a row and resolves its project name", () => {
    const [row] = toPaletteThreads([thread()], names, []);
    expect(row).toEqual({
      id: "th_1",
      title: "Ship the palette",
      projectId: "proj_1",
      projectName: "bb-plugins",
      updatedAt: 100,
      isPinned: false,
      isUnread: false,
      settled: false,
      snoozedUntil: null,
    });
  });

  it("falls back through titleFallback to a placeholder", () => {
    const rows = toPaletteThreads(
      [
        thread({ id: "a", title: null, titleFallback: "Fallback" }),
        thread({ id: "b", title: null, titleFallback: null, updatedAt: 50 }),
      ],
      names,
      [],
    );
    expect(rows.map((row) => row.title)).toEqual(["Fallback", "Untitled thread"]);
  });

  it("marks unread from attention newer than the read mark", () => {
    const rows = toPaletteThreads(
      [
        thread({ id: "a", lastReadAt: 10, latestAttentionAt: 20 }),
        thread({ id: "b", lastReadAt: null }),
        thread({ id: "c", lastReadAt: 20, latestAttentionAt: 20 }),
      ],
      names,
      [],
    );
    expect(rows.map((row) => row.isUnread)).toEqual([true, true, false]);
  });

  it("marks pinned from pinnedAt", () => {
    const [row] = toPaletteThreads([thread({ pinnedAt: 5 })], names, []);
    expect(row.isPinned).toBe(true);
  });

  it("joins the lifecycle rows it is given", () => {
    const rows = toPaletteThreads(
      [thread({ id: "a" }), thread({ id: "b", updatedAt: 50 })],
      names,
      [
        { threadId: "a", settledAt: 7, snoozedUntil: null },
        { threadId: "b", settledAt: null, snoozedUntil: 900 },
      ],
    );
    expect(rows[0]).toMatchObject({ id: "a", settled: true, snoozedUntil: null });
    expect(rows[1]).toMatchObject({ id: "b", settled: false, snoozedUntil: 900 });
  });

  it("leaves lifecycle flags off when no rows are given", () => {
    const [row] = toPaletteThreads([thread()], names, []);
    expect(row.settled).toBe(false);
    expect(row.snoozedUntil).toBeNull();
  });

  it("sorts newest first and blanks an unknown project", () => {
    const rows = toPaletteThreads(
      [
        thread({ id: "old", updatedAt: 10 }),
        thread({ id: "new", updatedAt: 900, projectId: "proj_gone" }),
      ],
      names,
      [],
    );
    expect(rows.map((row) => row.id)).toEqual(["new", "old"]);
    expect(rows[1].projectName).toBe("bb-plugins");
    expect(rows[0].projectName).toBe("");
  });
});

describe("searchValue", () => {
  it("matches on title and project", () => {
    const [row] = toPaletteThreads([thread()], names, []);
    expect(searchValue(row)).toBe("Ship the palette bb-plugins");
  });
});
