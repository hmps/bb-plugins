// The board rpcs, against an injected `bd` runner and a temporary Base with
// two postures. The load-bearing parts are the read-only bd call, the warm
// snapshot (one read at a time, served without waiting), the scope order
// (saved pick > Crew > posture), and a missing thread staying on the board.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { redact, type BdRunner } from "./server";

const COMMANDER_PROJECT = "proj_commander";
const COMMANDER = "thr_commander";
const NEW_COMMANDER = "thr_new_commander";

function baseRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "starbase-board-"));
  for (const [slug, projectId] of [
    ["fia", "proj_fia"],
    ["vaam-main", "proj_vaam"],
  ]) {
    mkdirSync(join(root, "projects", slug), { recursive: true });
    writeFileSync(
      join(root, "projects", slug, "posture.toml"),
      `slug = "${slug}"\nproject_id = "${projectId}"\n`,
    );
  }
  return root;
}

const recent = new Date().toISOString();

const beads = [
  {
    id: "sb-1",
    title: "Working mission",
    status: "in_progress",
    labels: ["project:vaam-main", "mission:build"],
    notes: "thread=thr_crew_1 env=env_1 mode=worktree",
    updated_at: recent,
  },
  {
    id: "sb-2",
    title: "Lost mission",
    status: "open",
    labels: ["project:vaam-main", "mission:survey"],
    notes: "thread=thr_gone env=env_2",
    updated_at: recent,
  },
  {
    id: "sb-3",
    title: "Shipped mission",
    status: "closed",
    labels: ["project:vaam-main", "mission:build"],
    notes: "thread=thr_crew_old env=env_3\noutcome=merged",
    updated_at: recent,
    closed_at: recent,
  },
  {
    id: "sb-4",
    title: "Fia epic, not a mission",
    status: "open",
    labels: ["project:fia"],
    updated_at: recent,
  },
];

function notFound() {
  const error = new Error("HTTP 404: Thread not found") as Error & {
    status: number;
  };
  error.name = "BbHttpError";
  error.status = 404;
  return error;
}

function threadsGet({ threadId }: { threadId: string }) {
  if (threadId === "thr_gone") throw notFound();
  if (threadId === COMMANDER || threadId === NEW_COMMANDER) {
    return makeThreadResponse({
      id: threadId,
      projectId: COMMANDER_PROJECT,
      parentThreadId: null,
    });
  }
  if (threadId === "thr_outsider") {
    return makeThreadResponse({
      id: threadId,
      projectId: "proj_fia",
      parentThreadId: null,
    });
  }
  return makeThreadResponse({
    id: threadId,
    projectId: "proj_vaam",
    parentThreadId: COMMANDER,
    environmentId: "env_1",
    status: "active",
  });
}

function threadsList(args?: { parentThreadId?: string; archived?: boolean }) {
  if (args?.parentThreadId !== COMMANDER) return [];
  return args.archived === true
    ? [{ id: "thr_crew_old" }]
    : [{ id: "thr_crew_1" }];
}

function loadPlugin() {
  const bd = {
    calls: [] as string[][],
    /** While true, a bd read waits for `release()`. */
    hold: false,
    release: () => {},
  };
  const runBd: BdRunner = async (args) => {
    bd.calls.push(args);
    if (bd.hold) {
      await new Promise<void>((resolve) => {
        bd.release = resolve;
      });
    }
    return JSON.stringify(beads);
  };
  const fake = createFakePluginHost({
    pluginId: "starbase",
    settings: { commanderProjectIds: COMMANDER_PROJECT, baseRoot: baseRoot() },
    sdk: {
      threads: {
        get: threadsGet,
        list: threadsList,
        interactions: { list: () => [] },
      },
      environments: {
        pullRequest: () => ({
          outcome: "available",
          pullRequest: { url: "https://github.com/x/y/pull/7", state: "open" },
        }),
      },
    },
  });
  plugin(fake.bb, { runBd });
  return { fake, bd };
}

interface Board {
  project: string;
  refreshing: boolean;
  columns: {
    id: string;
    total: number;
    cards: { id: string; flags: string[]; pr: unknown }[];
  }[];
  projects: string[];
}

interface Panel {
  scope: {
    scope: string | null;
    source: string;
    commanderId: string | null;
    canSave: boolean;
  };
  board: Board | null;
}

function column(board: Board, id: string) {
  return board.columns.find((entry) => entry.id === id);
}

function crewEvent(threadId: string) {
  return { thread: makeThreadResponse({ id: threadId, status: "active" }) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("board rpc", () => {
  it("runs bd read-only and places every mission", async () => {
    const { fake, bd } = loadPlugin();
    const board = (await fake.harness.callRpc("board", {
      project: "vaam-main",
    })) as Board;
    expect(bd.calls).toEqual([
      ["--readonly", "list", "--all", "--json", "--limit", "0"],
    ]);
    expect(board.refreshing).toBe(false);
    expect(board.columns.map((entry) => entry.id)).toEqual([
      "queued",
      "progress",
      "waiting",
      "blocked",
      "review",
      "done",
    ]);
    expect(column(board, "progress")?.cards.map((card) => card.id)).toEqual([
      "sb-1",
    ]);
    expect(column(board, "progress")?.cards[0].pr).toEqual({
      url: "https://github.com/x/y/pull/7",
      state: "open",
    });
    expect(column(board, "review")?.cards).toEqual([
      expect.objectContaining({ id: "sb-2", flags: ["thread-gone"] }),
    ]);
    expect(column(board, "done")?.cards.map((card) => card.id)).toEqual([
      "sb-3",
    ]);
    expect(board.projects).toEqual(["fia", "vaam-main"]);
  });

  it("leaves out every bead that is not a mission", async () => {
    const { fake } = loadPlugin();
    const board = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    const ids = board.columns.flatMap((entry) =>
      entry.cards.map((card) => card.id),
    );
    expect(ids.sort()).toEqual(["sb-1", "sb-2", "sb-3"]);
  });

  it("does not read the thread of a closed mission", async () => {
    const { fake } = loadPlugin();
    await fake.harness.callRpc("board", { project: "all" });
    const read = fake.harness.sdk
      .callsTo("threads.get")
      .map((call) => (call[0] as { threadId: string }).threadId);
    expect(read).toContain("thr_crew_1");
    expect(read).not.toContain("thr_crew_old");
  });

  it("refuses a project that is not a slug", async () => {
    const { fake } = loadPlugin();
    await expect(
      fake.harness.callRpc("board", { project: "../etc" }),
    ).rejects.toThrow();
  });
});

describe("board snapshot", () => {
  it("serves a second call from the snapshot, for any project", async () => {
    const { fake, bd } = loadPlugin();
    await fake.harness.callRpc("board", { project: "all" });
    await fake.harness.callRpc("board", { project: "fia" });
    await fake.harness.callRpc("panel", { threadId: "thr_crew_1" });
    expect(bd.calls).toHaveLength(1);
  });

  it("runs one read for calls that arrive together", async () => {
    const { fake, bd } = loadPlugin();
    await Promise.all([
      fake.harness.callRpc("board", { project: "all" }),
      fake.harness.callRpc("board", { project: "fia" }),
      fake.harness.callRpc("panel", { threadId: COMMANDER }),
    ]);
    expect(bd.calls).toHaveLength(1);
  });

  it("answers at once from a stale snapshot while one read runs behind it", async () => {
    const { fake, bd } = loadPlugin();
    await fake.harness.callRpc("board", { project: "all" });

    // A Crew thread on the board changes: the snapshot is stale.
    bd.hold = true;
    await fake.harness.emitThreadEvent(
      "thread.active",
      crewEvent("thr_crew_1"),
    );
    const stale = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    expect(stale.refreshing).toBe(true);
    expect(bd.calls).toHaveLength(2);

    // A third call joins the running read; it does not start another.
    const third = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    expect(third.refreshing).toBe(true);
    expect(bd.calls).toHaveLength(2);

    bd.hold = false;
    bd.release();
    await vi.waitFor(async () => {
      const fresh = (await fake.harness.callRpc("board", {
        project: "all",
      })) as Board;
      expect(fresh.refreshing).toBe(false);
    });
    expect(bd.calls).toHaveLength(2);
  });

  it("ignores an event for a thread that is not on the board", async () => {
    const { fake, bd } = loadPlugin();
    await fake.harness.callRpc("board", { project: "all" });
    await fake.harness.emitThreadEvent("thread.active", crewEvent("thr_other"));
    await fake.harness.callRpc("board", { project: "all" });
    expect(bd.calls).toHaveLength(1);
  });

  it("waits for a new read on force", async () => {
    const { fake, bd } = loadPlugin();
    await fake.harness.callRpc("board", { project: "all" });
    await fake.harness.callRpc("board", { project: "all", force: true });
    expect(bd.calls).toHaveLength(2);
    await fake.harness.callRpc("panel", { threadId: COMMANDER, force: true });
    expect(bd.calls).toHaveLength(3);
  });

  it("reads again in the background while used, and stops on unload", async () => {
    vi.useFakeTimers();
    const { fake, bd } = loadPlugin();
    // No read before the first call.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(bd.calls).toHaveLength(0);
    await fake.harness.callRpc("board", { project: "all" });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(bd.calls).toHaveLength(2);
    await fake.harness.dispose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(bd.calls).toHaveLength(2);
  });
});

describe("panel rpc", () => {
  it("gives a Crew thread its Commander's project and that board", async () => {
    const { fake } = loadPlugin();
    const panel = (await fake.harness.callRpc("panel", {
      threadId: "thr_crew_1",
    })) as Panel;
    expect(panel.scope).toMatchObject({
      scope: "vaam-main",
      source: "commander",
      commanderId: COMMANDER,
      canSave: false,
    });
    expect(panel.board?.project).toBe("vaam-main");
  });

  it("shows a picked project, and keeps the scope", async () => {
    const { fake } = loadPlugin();
    const panel = (await fake.harness.callRpc("panel", {
      threadId: COMMANDER,
      project: "all",
    })) as Panel;
    expect(panel.scope.scope).toBe("vaam-main");
    expect(panel.board?.project).toBe("all");
  });

  it("reads a Commander's Crew once, then from the cache", async () => {
    const { fake } = loadPlugin();
    await fake.harness.callRpc("panel", { threadId: COMMANDER });
    await fake.harness.callRpc("panel", { threadId: COMMANDER });
    // One live and one archived listing.
    expect(fake.harness.sdk.callsTo("threads.list")).toHaveLength(2);
  });

  it("asks on a Commander with no Crew, then uses its saved pick", async () => {
    const { fake } = loadPlugin();
    const unresolved = (await fake.harness.callRpc("panel", {
      threadId: NEW_COMMANDER,
    })) as Panel;
    expect(unresolved.scope).toMatchObject({
      scope: null,
      source: "unresolved",
      canSave: true,
    });
    expect(unresolved.board).toBeNull();
    await expect(
      fake.harness.callRpc("saveScope", {
        threadId: NEW_COMMANDER,
        project: "fia",
      }),
    ).resolves.toEqual({ saved: true });
    const saved = (await fake.harness.callRpc("panel", {
      threadId: NEW_COMMANDER,
    })) as Panel;
    expect(saved.scope).toMatchObject({ scope: "fia", source: "saved" });
    expect(saved.board?.project).toBe("fia");
  });

  it("lets a saved pick override the Crew majority, also for its Crew", async () => {
    const { fake } = loadPlugin();
    await fake.harness.callRpc("saveScope", {
      threadId: COMMANDER,
      project: "fia",
    });
    await expect(
      fake.harness.callRpc("panel", { threadId: COMMANDER }),
    ).resolves.toMatchObject({ scope: { scope: "fia", source: "saved" } });
    await expect(
      fake.harness.callRpc("panel", { threadId: "thr_crew_1" }),
    ).resolves.toMatchObject({ scope: { scope: "fia", source: "saved" } });
  });

  it("matches a thread outside Starbase to a posture, and saves nothing for it", async () => {
    const { fake } = loadPlugin();
    await expect(
      fake.harness.callRpc("panel", { threadId: "thr_outsider" }),
    ).resolves.toMatchObject({
      scope: { scope: "fia", source: "posture", commanderId: null },
    });
    await expect(
      fake.harness.callRpc("saveScope", {
        threadId: "thr_outsider",
        project: "fia",
      }),
    ).resolves.toEqual({ saved: false });
  });
});

describe("redact", () => {
  it("removes every copy of the secret", () => {
    expect(redact("dsn=root:pw@host pw", "pw")).toBe("dsn=root:***@host ***");
    expect(redact("nothing", null)).toBe("nothing");
  });
});
