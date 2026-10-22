// The board rpcs and `bb starbase publish`, against a temporary Base with
// two postures. Every snapshot reaches the board the way a SITREP sends it:
// through the CLI, in --snapshot parts. The load-bearing parts are the
// snapshot contract (strict, newest wins), the source states (current,
// partial, unavailable), which snapshot a project's board shows, and the
// scope order (saved pick > Crew > posture).
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const COMMANDER_PROJECT = "proj_commander";
const COMMANDER = "thr_commander";
const NEW_COMMANDER = "thr_new_commander";
/** A Commander with no Crew, whose own thread one mission bead links. */
const ROOT_COMMANDER = "thr_root_commander";

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

// Synthetic SITREP rows, made from the pinned core full-row fixtures: the
// exact row shape and mission_state the core prints, with the bead, thread,
// and project changed to place them on one board.
const FULL_ROWS = join(
  import.meta.dirname,
  "fixtures/mission-state-v1/full-rows",
);

type Row = Record<string, unknown>;

interface FullRun {
  exit_code: number;
  stdout: Row[];
  stderr: string;
}

function fullRun(name: string): FullRun {
  return JSON.parse(readFileSync(join(FULL_ROWS, `${name}.json`), "utf8"));
}

function fullRow(name: string, change: Row): Row {
  return { ...structuredClone(fullRun(name).stdout[0]), ...change };
}

const rows: Row[] = [
  fullRow("active", {
    bead: "sb-1",
    title: "Working mission",
    thread: "thr_crew_1",
    project: "vaam-main",
    pr: "https://github.com/x/y/pull/7 open",
  }),
  fullRow("survey-decision", {
    bead: "sb-2",
    title: "Survey waiting on a decision",
    thread: "thr_crew_2",
    project: "vaam-main",
  }),
  fullRow("ready-for-deploy", {
    bead: "sb-4",
    title: "Merged, not deployed",
    thread: "thr_crew_4",
    project: "fia",
    pr: "https://github.com/x/y/pull/9 merged",
  }),
  fullRow("recent-closed", {
    bead: "sb-3",
    title: "Shipped mission",
    thread: "thr_crew_old",
    project: "vaam-main",
  }),
  // A Crew thread that no mission bead claims, as the SITREP prints it.
  fullRow("stale-conflict", {
    bead: "-",
    mission: "-",
    bead_status: "unknown",
    title: "Stray Crew thread",
    thread: "thr_orphan",
    project: "Vaam Main",
    pr: "-",
    flags: ["thread-without-bead"],
  }),
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
  if (
    threadId === COMMANDER ||
    threadId === NEW_COMMANDER ||
    threadId === ROOT_COMMANDER
  ) {
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

/** A valid published snapshot of `rows`, with any field changed. */
function snapshot(change: Record<string, unknown> = {}) {
  return {
    version: 1,
    generated_at: "2026-10-22T08:00:00Z",
    host: "titan",
    project: "all",
    commander: "thr_9mhukyfy2t",
    exit_code: 0,
    rows,
    ...change,
  };
}

/** `bb starbase publish` with the document cut into parts of `size` chars. */
function publishArgs(document: unknown, size = 64 * 1024): string[] {
  const text = JSON.stringify(document);
  const args = ["publish"];
  for (let at = 0; at < text.length; at += size) {
    args.push("--snapshot", text.slice(at, at + size));
  }
  return args;
}

/** The plugin, with `published` sent through the CLI in order. */
async function loadPlugin(published: unknown[] = [snapshot()]) {
  const root = baseRoot();
  const fake = createFakePluginHost({
    pluginId: "starbase",
    settings: { commanderProjectIds: COMMANDER_PROJECT, baseRoot: root },
    sdk: {
      threads: {
        get: threadsGet,
        list: threadsList,
        interactions: { list: () => [] },
      },
    },
  });
  plugin(fake.bb);
  const publish = async (document: unknown) => {
    const result = await fake.harness.runCli(publishArgs(document));
    expect(result.exitCode, result.stderr).toBe(0);
    return result;
  };
  for (const document of published) await publish(document);
  return { fake, root, publish };
}

interface Board {
  project: string;
  host: string | null;
  columns: {
    id: string;
    total: number;
    cards: (Record<string, unknown> & { id: string; column: string })[];
  }[];
  projects: string[];
  source: string;
  error: string | null;
  generatedAt: number | null;
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

describe("board rpc", () => {
  it("shows the rows of a published snapshot, with its time and host", async () => {
    const { fake } = await loadPlugin();
    const board = (await fake.harness.callRpc("board", {
      project: "vaam-main",
    })) as Board;
    expect(board).toMatchObject({
      source: "current",
      error: null,
      host: "titan",
      generatedAt: Date.parse("2026-10-22T08:00:00Z"),
    });
    expect(board.columns.map((entry) => entry.id)).toEqual([
      "progress",
      "waiting",
      "blocked",
      "review",
      "deploy",
      "done",
    ]);
    const placed = Object.fromEntries(
      board.columns.map((entry) => [
        entry.id,
        entry.cards.map((card) => card.id),
      ]),
    );
    expect(placed).toEqual({
      progress: ["sb-1"],
      waiting: ["sb-2"],
      blocked: [],
      review: [],
      deploy: [],
      done: ["sb-3"],
    });
    expect(board.projects).toEqual(["fia", "vaam-main"]);
  });

  it("carries the next action, owner, and pending attention on a card", async () => {
    const { fake } = await loadPlugin();
    const board = (await fake.harness.callRpc("board", {
      project: "vaam-main",
    })) as Board;
    expect(column(board, "progress")?.cards[0]).toMatchObject({
      stage: "Active",
      tone: "working",
      nextAction: "Check acceptance",
      owner: "Crew thr_crew",
      ownerIdle: false,
      attention: [],
      pr: { url: "https://github.com/x/y/pull/7", state: "open" },
      flags: [],
    });
    expect(column(board, "waiting")?.cards[0]).toMatchObject({
      stage: "Awaiting decision",
      tone: "alert",
      owner: "Commander thr_root",
      ownerIdle: true,
      attention: [
        { kind: "decision", summary: "Check acceptance", surfaced: false },
      ],
      threadStatus: "idle",
    });
    expect(column(board, "done")?.cards[0]).toMatchObject({
      stage: "Complete",
      tone: "quiet",
      attention: [],
      integrity: null,
    });
  });

  it("keeps merged but undeployed work in Awaiting deploy", async () => {
    const { fake } = await loadPlugin();
    const board = (await fake.harness.callRpc("board", {
      project: "fia",
    })) as Board;
    expect(column(board, "deploy")?.cards).toEqual([
      expect.objectContaining({
        id: "sb-4",
        stage: expect.stringMatching(/^Ready for deploy/),
        pr: { url: "https://github.com/x/y/pull/9", state: "merged" },
      }),
    ]);
    expect(column(board, "done")?.cards).toEqual([]);
  });

  it("shows a Crew thread with no mission bead in Commander review", async () => {
    const { fake } = await loadPlugin();
    const board = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    expect(column(board, "review")?.cards).toEqual([
      expect.objectContaining({
        id: "thr_orphan",
        bead: null,
        mission: null,
        threadId: "thr_orphan",
        flags: ["thread-without-bead"],
        integrity: "Changed outside checked update",
      }),
    ]);
    // A bb project name is no slug: the picker leaves it out.
    expect(board.projects).toEqual(["fia", "vaam-main"]);
  });

  it("reads no thread through the SDK for the board", async () => {
    const { fake } = await loadPlugin();
    await fake.harness.callRpc("board", { project: "all" });
    expect(fake.harness.sdk.callsTo("threads.get")).toHaveLength(0);
  });

  it("refuses a project that is not a slug", async () => {
    const { fake } = await loadPlugin();
    await expect(
      fake.harness.callRpc("board", { project: "../etc" }),
    ).rejects.toThrow();
  });
});

describe("board source", () => {
  const COLUMNS: Record<string, string> = {
    active: "progress",
    "changed-verified-target": "blocked",
    "direct-root-discussion": "waiting",
    "missing-verified-target": "blocked",
    "new-blocker": "waiting",
    "partial-source-failure": "waiting",
    "quiet-complete": "done",
    "ready-for-deploy": "deploy",
    "recent-closed": "done",
    "stale-conflict": "review",
    "survey-decision": "waiting",
  };

  it("places every core full-row run, partial runs marked partial", async () => {
    const names = readdirSync(FULL_ROWS).map((file) =>
      file.replace(/\.json$/, ""),
    );
    expect(names.sort()).toEqual(Object.keys(COLUMNS).sort());
    for (const name of names) {
      const run = fullRun(name);
      const { fake } = await loadPlugin([
        snapshot({ exit_code: run.exit_code, rows: run.stdout }),
      ]);
      const board = (await fake.harness.callRpc("board", {
        project: "all",
      })) as Board;
      expect(board.source, name).toBe(
        run.exit_code === 0 ? "current" : "partial",
      );
      const card = board.columns.flatMap((entry) => entry.cards)[0];
      expect(card.column, name).toBe(COLUMNS[name]);
      // The card shows exactly the core's pending attention, no more.
      const state = run.stdout[0].mission_state as {
        pending_attention: { kind: string }[];
      };
      expect(
        (card.attention as { kind: string }[]).map((a) => a.kind).sort(),
        name,
      ).toEqual(state.pending_attention.map((a) => a.kind).sort());
    }
  });

  it("marks the rows of a failed source partial, never current", async () => {
    const run = fullRun("changed-verified-target");
    const { fake } = await loadPlugin([
      snapshot({ exit_code: run.exit_code, rows: run.stdout }),
    ]);
    const board = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    expect(run.exit_code).not.toBe(0);
    expect(board).toMatchObject({
      source: "partial",
      host: "titan",
      error: `The SITREP on titan exited ${run.exit_code}: a source could not be read, so some missions may be missing.`,
    });
    expect(column(board, "blocked")?.cards[0]).toMatchObject({
      stage: "Complete",
      tone: "alert",
      attention: [expect.objectContaining({ kind: "verification-failed" })],
      flags: ["source-error"],
    });
    expect(column(board, "done")?.cards).toEqual([]);
  });

  it("is unavailable, not empty, before any snapshot", async () => {
    const { fake } = await loadPlugin([]);
    const board = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    expect(board).toMatchObject({
      source: "unavailable",
      error: null,
      generatedAt: null,
      host: null,
      projects: ["fia", "vaam-main"],
    });
    expect(board.columns.every((entry) => entry.total === 0)).toBe(true);
  });

  it("keeps the stored rows when an older snapshot arrives", async () => {
    const { fake, publish } = await loadPlugin();
    const before = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    const ignored = await publish(
      snapshot({ generated_at: "2026-10-22T07:00:00Z", rows: [] }),
    );
    expect(ignored.stdout).toMatch(/^Ignored/);
    const after = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    expect(after).toEqual(before);
  });

  it("shows a row from a SITREP without mission state as pre-v1, in review", async () => {
    const { fake } = await loadPlugin([
      snapshot({
        rows: [
          { bead: "sb-9", mission: "build", project: "fia", title: "Old row" },
        ],
      }),
    ]);
    const board = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    expect(board.source).toBe("current");
    expect(column(board, "review")?.cards[0]).toMatchObject({
      id: "sb-9",
      integrity: "Pre-v1 row",
      tone: "warn",
      attention: [],
    });
  });
});

describe("board snapshot choice", () => {
  const fiaOnly = (generatedAt: string, title: string) =>
    snapshot({
      project: "fia",
      generated_at: generatedAt,
      host: "msi",
      rows: [{ ...rows[2], title }],
    });

  it("shows a project the newer of its own snapshot and the all one", async () => {
    const { fake, publish } = await loadPlugin([
      snapshot(),
      fiaOnly("2026-10-22T08:05:00Z", "Newer fia row"),
    ]);
    const fia = (await fake.harness.callRpc("board", {
      project: "fia",
    })) as Board;
    expect(fia.host).toBe("msi");
    expect(column(fia, "deploy")?.cards[0].title).toBe("Newer fia row");
    // The all board never shows a project's own snapshot.
    const all = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    expect(all.host).toBe("titan");

    await publish(snapshot({ generated_at: "2026-10-22T08:10:00Z" }));
    const again = (await fake.harness.callRpc("board", {
      project: "fia",
    })) as Board;
    expect(again.host).toBe("titan");
    expect(column(again, "deploy")?.cards[0].title).toBe("Merged, not deployed");
  });

  it("offers every project with a stored snapshot in the picker", async () => {
    const { fake } = await loadPlugin([
      snapshot({ project: "starbase-core", rows: [] }),
    ]);
    const board = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    expect(board.source).toBe("unavailable");
    expect(board.projects).toEqual(["fia", "starbase-core", "vaam-main"]);
  });
});

describe("panel rpc", () => {
  it("gives a Crew thread its Commander's project and that board", async () => {
    const { fake } = await loadPlugin();
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
    const { fake } = await loadPlugin();
    const panel = (await fake.harness.callRpc("panel", {
      threadId: COMMANDER,
      project: "all",
    })) as Panel;
    expect(panel.scope.scope).toBe("vaam-main");
    expect(panel.board?.project).toBe("all");
  });

  it("reads a Commander's Crew once, then from the cache", async () => {
    const { fake } = await loadPlugin();
    await fake.harness.callRpc("panel", { threadId: COMMANDER });
    await fake.harness.callRpc("panel", { threadId: COMMANDER });
    // One live and one archived listing.
    expect(fake.harness.sdk.callsTo("threads.list")).toHaveLength(2);
  });

  it("finds a Commander's project from a root discussion it owns", async () => {
    const root = fullRow("survey-decision", {
      bead: "sb-root",
      title: "Root discussion",
      thread: ROOT_COMMANDER,
      project: "fia",
    });
    const { fake } = await loadPlugin([snapshot({ rows: [...rows, root] })]);
    const panel = (await fake.harness.callRpc("panel", {
      threadId: ROOT_COMMANDER,
    })) as Panel;
    expect(panel.scope).toMatchObject({
      scope: "fia",
      source: "commander",
      commanderId: ROOT_COMMANDER,
    });
    expect(
      column(panel.board as Board, "waiting")?.cards.map((card) => card.id),
    ).toEqual(["sb-root"]);
  });

  it("asks on a Commander with no Crew, then uses its saved pick", async () => {
    const { fake } = await loadPlugin();
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
    const { fake } = await loadPlugin();
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
    const { fake } = await loadPlugin();
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

describe("publish", () => {
  it("stores a valid snapshot", async () => {
    const { fake } = await loadPlugin([]);
    const result = await fake.harness.runCli(publishArgs(snapshot()));
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toBe(
      `Stored the snapshot for all from titan at 2026-10-22T08:00:00.000Z: ${rows.length} row(s), exit code 0.`,
    );
  });

  it("joins every --snapshot part in order", async () => {
    const { fake } = await loadPlugin([]);
    const args = publishArgs(snapshot(), 1000);
    expect(args.length).toBeGreaterThan(10);
    const result = await fake.harness.runCli(args);
    expect(result.exitCode).toBe(0);
    const board = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    expect(board.columns.flatMap((entry) => entry.cards)).toHaveLength(
      rows.length,
    );
  });

  it("ignores an older snapshot, and replaces on an equal or newer one", async () => {
    const { fake } = await loadPlugin();
    const older = await fake.harness.runCli(
      publishArgs(snapshot({ generated_at: "2026-10-22T07:59:59Z" })),
    );
    expect(older).toMatchObject({ exitCode: 0 });
    expect(older.stdout).toMatch(/^Ignored: the stored snapshot for all is newer/);
    const equal = await fake.harness.runCli(
      publishArgs(snapshot({ host: "msi" })),
    );
    expect(equal.stdout).toMatch(/^Stored/);
    const board = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    expect(board.host).toBe("msi");
  });

  it("refuses an invalid snapshot with one line, and stores nothing", async () => {
    const { fake } = await loadPlugin([]);
    const cases: [string[], RegExp][] = [
      [["publish"], /no snapshot/],
      [["publish", "--snapshot"], /needs a value/],
      [["publish", "--snapshot", "{}", "extra"], /unknown argument/],
      [["publish", "--snapshot", '{"version":1,'], /not valid JSON/],
      [publishArgs(snapshot({ version: 2 })), /^publish: version: /],
      [publishArgs(snapshot({ password: "s3cret" })), /password/],
      [publishArgs(snapshot({ generated_at: "yesterday" })), /generated_at/],
      [publishArgs(snapshot({ project: "../etc" })), /project/],
      [publishArgs(snapshot({ commander: "thr_x --full" })), /commander/],
      [publishArgs(snapshot({ exit_code: 1.5 })), /exit_code/],
      [publishArgs(snapshot({ rows: [1] })), /rows/],
      [
        publishArgs(snapshot({ rows: [{ ...rows[0], contract_version: 2 }] })),
        /unsupported contract_version/,
      ],
    ];
    for (const [args, message] of cases) {
      const result = await fake.harness.runCli(args);
      expect(result.exitCode, args.join(" ")).toBe(1);
      expect(result.stderr, args.join(" ")).toMatch(message);
      expect(result.stderr).not.toContain("\n");
    }
    const board = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    expect(board.source).toBe("unavailable");
  });
});
