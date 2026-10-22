// The board rpcs, against a synthetic SITREP transport and a temporary Base
// with two postures. The load-bearing parts are the exact read-only SITREP
// command, the source states (current, partial, stale, unavailable), the warm
// snapshot (one read at a time, served without waiting), and the scope order
// (saved pick > Crew > posture).
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { redact, type SitrepResult, type SitrepRunner } from "./server";

// The real execFile, behind a spy: a test can read the options the default
// runner passes, or answer one call as a run that timed out.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

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

/** The command the installed board is meant to run, from the Base root. */
const SITREP_ARGS = [
  "scripts/sitrep.sh",
  "--project",
  "all",
  "--commander",
  "thr_9mhukyfy2t",
  "--recent-closed",
  "50",
  "--json",
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

function loadPlugin(settings: Record<string, string> = {}) {
  const root = baseRoot();
  const sitrep = {
    calls: [] as { args: string[]; cwd: string }[],
    /** While true, a run waits for `release()`. */
    hold: false,
    release: () => {},
    /** The next run's result; a function may throw, as a runner bug would. */
    result: (): SitrepResult => ({
      exitCode: 0,
      stdout: JSON.stringify(rows),
      stderr: "",
    }),
  };
  const runSitrep: SitrepRunner = async (args, { cwd }) => {
    sitrep.calls.push({ args, cwd });
    if (sitrep.hold) {
      await new Promise<void>((resolve) => {
        sitrep.release = resolve;
      });
    }
    return sitrep.result();
  };
  const fake = createFakePluginHost({
    pluginId: "starbase",
    settings: {
      commanderProjectIds: COMMANDER_PROJECT,
      baseRoot: root,
      ...settings,
    },
    sdk: {
      threads: {
        get: threadsGet,
        list: threadsList,
        interactions: { list: () => [] },
      },
    },
  });
  plugin(fake.bb, { runSitrep });
  return { fake, sitrep, root };
}

interface Board {
  project: string;
  refreshing: boolean;
  columns: {
    id: string;
    total: number;
    cards: (Record<string, unknown> & { id: string; column: string })[];
  }[];
  projects: string[];
  source: string;
  error: string | null;
  generatedAt: number;
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

/** The automatic-read floor: five minutes after the last run finished. */
const FLOOR_MS = 5 * 60_000;

/** Board calls every 30 seconds from `startMs` to `untilMs`, the last at `untilMs`. */
async function useBoardUntil(
  fake: ReturnType<typeof loadPlugin>["fake"],
  startMs: number,
  untilMs: number,
) {
  for (let at = startMs; at < untilMs; ) {
    const step = Math.min(30_000, untilMs - at);
    await vi.advanceTimersByTimeAsync(step);
    at += step;
    await fake.harness.callRpc("board", { project: "all" });
  }
}

describe("board rpc", () => {
  it("runs the read-only SITREP in the Base and places every row", async () => {
    const { fake, sitrep, root } = loadPlugin();
    const board = (await fake.harness.callRpc("board", {
      project: "vaam-main",
    })) as Board;
    expect(sitrep.calls).toEqual([{ args: SITREP_ARGS, cwd: root }]);
    expect(board).toMatchObject({
      refreshing: false,
      source: "current",
      error: null,
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
    const { fake } = loadPlugin();
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
    const { fake } = loadPlugin();
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
    const { fake } = loadPlugin();
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
    const { fake } = loadPlugin();
    await fake.harness.callRpc("board", { project: "all" });
    expect(fake.harness.sdk.callsTo("threads.get")).toHaveLength(0);
  });

  it("refuses a project that is not a slug", async () => {
    const { fake } = loadPlugin();
    await expect(
      fake.harness.callRpc("board", { project: "../etc" }),
    ).rejects.toThrow();
  });

  it("does not pass a Commander setting that is not a thread id", async () => {
    const { fake, sitrep } = loadPlugin({ sitrepCommander: "thr_x --full" });
    const board = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    expect(sitrep.calls).toHaveLength(0);
    expect(board.source).toBe("unavailable");
    expect(board.error).toMatch(/not a thread id/);
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
      const { fake, sitrep } = loadPlugin();
      sitrep.result = () => ({
        exitCode: run.exit_code,
        stdout: JSON.stringify(run.stdout),
        stderr: run.stderr,
      });
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

  it("files a completion with failed target evidence in Blocked, not Done", async () => {
    const run = fullRun("changed-verified-target");
    const { fake, sitrep } = loadPlugin();
    sitrep.result = () => ({
      exitCode: run.exit_code,
      stdout: JSON.stringify(run.stdout),
      stderr: "",
    });
    const board = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    expect(board).toMatchObject({
      source: "partial",
      error: "partial source failure",
    });
    expect(column(board, "blocked")?.cards[0]).toMatchObject({
      stage: "Complete",
      tone: "alert",
      attention: [expect.objectContaining({ kind: "verification-failed" })],
      flags: ["source-error"],
    });
    expect(column(board, "done")?.cards).toEqual([]);
  });

  it("is unavailable, not empty, when the first run fails", async () => {
    const { fake, sitrep } = loadPlugin();
    sitrep.result = () => ({
      exitCode: 2,
      stdout: "",
      stderr: "usage: bash scripts/sitrep.sh --project <slug|all>",
    });
    const board = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    expect(board).toMatchObject({
      source: "unavailable",
      error: "usage: bash scripts/sitrep.sh --project <slug|all>",
    });
    expect(board.columns.every((entry) => entry.total === 0)).toBe(true);
  });

  it("keeps the last good rows marked stale, with their own read time", async () => {
    const { fake, sitrep } = loadPlugin();
    const good = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    await new Promise((resolve) => setTimeout(resolve, 5));
    sitrep.result = () => ({ exitCode: 1, stdout: "", stderr: "bd failed" });
    const stale = (await fake.harness.callRpc("board", {
      project: "all",
      force: true,
    })) as Board;
    expect(stale).toMatchObject({ source: "stale", error: "bd failed" });
    expect(stale.generatedAt).toBe(good.generatedAt);
    expect(stale.columns).toEqual(good.columns);

    // Still stale after a second failure; current again after a good run.
    sitrep.result = () => {
      throw new Error("runner broke");
    };
    const still = (await fake.harness.callRpc("board", {
      project: "all",
      force: true,
    })) as Board;
    expect(still).toMatchObject({ source: "stale", error: "runner broke" });
    expect(still.generatedAt).toBe(good.generatedAt);
    sitrep.result = () => ({
      exitCode: 0,
      stdout: JSON.stringify(rows),
      stderr: "",
    });
    const again = (await fake.harness.callRpc("board", {
      project: "all",
      force: true,
    })) as Board;
    expect(again).toMatchObject({ source: "current", error: null });
    expect(again.generatedAt).toBeGreaterThan(good.generatedAt);
  });

  it("fails the whole run on an unsupported contract version", async () => {
    const { fake, sitrep } = loadPlugin();
    sitrep.result = () => ({
      exitCode: 0,
      stdout: JSON.stringify([...rows, { ...rows[0], contract_version: 2 }]),
      stderr: "",
    });
    const board = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    expect(board).toMatchObject({
      source: "unavailable",
      error: "source unavailable",
    });
  });

  it("shows a row from a SITREP without mission state as pre-v1, in review", async () => {
    const { fake, sitrep } = loadPlugin();
    sitrep.result = () => ({
      exitCode: 0,
      stdout: JSON.stringify([
        { bead: "sb-9", mission: "build", project: "fia", title: "Old row" },
      ]),
      stderr: "",
    });
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

describe("default SITREP runner", () => {
  it("runs bash with the exact arguments and keeps a partial run's rows", async () => {
    const root = baseRoot();
    mkdirSync(join(root, "scripts"));
    // A synthetic SITREP: it prints its arguments as a pre-v1 row title,
    // reports a partial failure on stderr, and exits 1.
    writeFileSync(
      join(root, "scripts", "sitrep.sh"),
      [
        'printf \'[{"bead":"sb-9","mission":"build","project":"fia","title":"%s"}]\' "$*"',
        "echo 'SOURCE FAILED: bb thread list' >&2",
        "exit 1",
      ].join("\n"),
    );
    const fake = createFakePluginHost({
      pluginId: "starbase",
      settings: { commanderProjectIds: COMMANDER_PROJECT, baseRoot: root },
      sdk: { threads: { get: threadsGet, list: threadsList } },
    });
    plugin(fake.bb);
    const board = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    expect(board).toMatchObject({
      source: "partial",
      error: "SOURCE FAILED: bb thread list",
    });
    expect(column(board, "review")?.cards[0]).toMatchObject({
      id: "sb-9",
      title: SITREP_ARGS.slice(1).join(" "),
      integrity: "Pre-v1 row",
    });
  });

  it("gives the SITREP five minutes, and says so when a run times out", async () => {
    const run = vi.mocked(execFile);
    run.mockClear();
    run.mockImplementationOnce(((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error,
        stdout: string,
        stderr: string,
      ) => void;
      // What execFile reports when it kills a run at its timeout.
      callback(
        Object.assign(new Error("Command failed"), {
          killed: true,
          signal: "SIGTERM",
        }),
        "",
        "",
      );
      return {};
    }) as never);
    const fake = createFakePluginHost({
      pluginId: "starbase",
      settings: { commanderProjectIds: COMMANDER_PROJECT, baseRoot: baseRoot() },
      sdk: { threads: { get: threadsGet, list: threadsList } },
    });
    plugin(fake.bb);
    const board = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    const sitrepCall = run.mock.calls.find((call) => call[0] === "bash");
    expect(sitrepCall?.[1]).toEqual(SITREP_ARGS);
    expect(sitrepCall?.[2]).toMatchObject({ timeout: 300_000 });
    expect(board).toMatchObject({
      source: "unavailable",
      error: "The SITREP did not finish in 300s.",
    });
  });
});

describe("board snapshot", () => {
  it("serves a second call from the snapshot, for any project", async () => {
    const { fake, sitrep } = loadPlugin();
    await fake.harness.callRpc("board", { project: "all" });
    await fake.harness.callRpc("board", { project: "fia" });
    await fake.harness.callRpc("panel", { threadId: "thr_crew_1" });
    expect(sitrep.calls).toHaveLength(1);
  });

  it("runs one read for calls that arrive together", async () => {
    const { fake, sitrep } = loadPlugin();
    await Promise.all([
      fake.harness.callRpc("board", { project: "all" }),
      fake.harness.callRpc("board", { project: "fia" }),
      fake.harness.callRpc("panel", { threadId: COMMANDER }),
    ]);
    expect(sitrep.calls).toHaveLength(1);
  });

  it("reads again behind a call once the last run is five minutes old", async () => {
    vi.useFakeTimers();
    const { fake, sitrep } = loadPlugin();
    // The first run finishes 10 seconds in, off the timer's 30-second beat.
    await vi.advanceTimersByTimeAsync(10_000);
    await fake.harness.callRpc("board", { project: "all" });
    await vi.advanceTimersByTimeAsync(FLOOR_MS - 1_000);
    await fake.harness.callRpc("board", { project: "all" });
    expect(sitrep.calls).toHaveLength(1);

    // At the floor, a call answers from the old snapshot and reads behind it.
    sitrep.hold = true;
    await vi.advanceTimersByTimeAsync(1_000);
    const old = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    expect(old.refreshing).toBe(true);
    expect(old.source).toBe("current");
    expect(sitrep.calls).toHaveLength(2);

    // A call in the meantime joins the running read; it does not start another.
    const joined = (await fake.harness.callRpc("panel", {
      threadId: COMMANDER,
    })) as Panel;
    expect(joined.board?.refreshing).toBe(true);
    expect(sitrep.calls).toHaveLength(2);

    sitrep.hold = false;
    sitrep.release();
    await vi.waitFor(async () => {
      const fresh = (await fake.harness.callRpc("board", {
        project: "all",
      })) as Board;
      expect(fresh.refreshing).toBe(false);
    });
    expect(sitrep.calls).toHaveLength(2);
  });

  it("reads again on the timer only once the last run is five minutes old", async () => {
    vi.useFakeTimers();
    const { fake, sitrep } = loadPlugin();
    // No read before the first call.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sitrep.calls).toHaveLength(0);
    await fake.harness.callRpc("board", { project: "all" });
    // The ticks at 30 seconds ... 300 seconds find the run too recent.
    await vi.advanceTimersByTimeAsync(300_000 - 10_000);
    expect(sitrep.calls).toHaveLength(1);
    // The tick at 330 seconds finds it 320 seconds old.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sitrep.calls).toHaveLength(2);
    await fake.harness.dispose();
    await vi.advanceTimersByTimeAsync(2 * FLOOR_MS);
    expect(sitrep.calls).toHaveLength(2);
  });

  it("counts the five minutes from when a slow run finished", async () => {
    vi.useFakeTimers();
    const { fake, sitrep } = loadPlugin();
    // A first run of 152 seconds, as a full SITREP of a large Base takes.
    sitrep.hold = true;
    const first = fake.harness.callRpc("board", { project: "all" });
    await vi.advanceTimersByTimeAsync(152_000);
    sitrep.hold = false;
    sitrep.release();
    await first;
    await useBoardUntil(fake, 152_000, 152_000 + FLOOR_MS - 1_000);
    expect(sitrep.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await fake.harness.callRpc("board", { project: "all" });
    expect(sitrep.calls).toHaveLength(2);
  });

  it("starts no read on thread changes before the five minutes pass", async () => {
    vi.useFakeTimers();
    const { fake, sitrep } = loadPlugin();
    await fake.harness.callRpc("board", { project: "all" });
    for (const event of ["thread.active", "thread.archived"] as const) {
      await fake.harness.emitThreadEvent(event, crewEvent("thr_crew_1"));
    }
    await vi.advanceTimersByTimeAsync(60_000);
    await fake.harness.callRpc("board", { project: "all" });
    await fake.harness.callRpc("panel", { threadId: "thr_crew_1" });
    expect(sitrep.calls).toHaveLength(1);
  });

  it("waits five minutes after a failed run too, and keeps its error", async () => {
    vi.useFakeTimers();
    const { fake, sitrep } = loadPlugin();
    const good = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    await vi.advanceTimersByTimeAsync(10_000);
    sitrep.result = () => ({ exitCode: 1, stdout: "", stderr: "bd failed" });
    await fake.harness.callRpc("board", { project: "all", force: true });
    expect(sitrep.calls).toHaveLength(2);

    // Until the floor, every call shows the old rows as stale, with the error.
    await useBoardUntil(fake, 10_000, 10_000 + FLOOR_MS - 1_000);
    const stale = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    expect(stale).toMatchObject({ source: "stale", error: "bd failed" });
    expect(stale.generatedAt).toBe(good.generatedAt);
    expect(sitrep.calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1_000);
    await fake.harness.callRpc("board", { project: "all" });
    expect(sitrep.calls).toHaveLength(3);
  });

  it("waits for a new read on force", async () => {
    const { fake, sitrep } = loadPlugin();
    await fake.harness.callRpc("board", { project: "all" });
    await fake.harness.callRpc("board", { project: "all", force: true });
    expect(sitrep.calls).toHaveLength(2);
    await fake.harness.callRpc("panel", { threadId: COMMANDER, force: true });
    expect(sitrep.calls).toHaveLength(3);
  });

  it("joins a running read on force, and starts no second one", async () => {
    const { fake, sitrep } = loadPlugin();
    await fake.harness.callRpc("board", { project: "all" });
    sitrep.hold = true;
    const forced = fake.harness.callRpc("board", { project: "all", force: true });
    const again = fake.harness.callRpc("panel", {
      threadId: COMMANDER,
      force: true,
    });
    const plain = (await fake.harness.callRpc("board", {
      project: "all",
    })) as Board;
    expect(plain.refreshing).toBe(true);
    await vi.waitFor(() => expect(sitrep.calls).toHaveLength(2));
    sitrep.hold = false;
    sitrep.release();
    const [first, second] = (await Promise.all([forced, again])) as [
      Board,
      Panel,
    ];
    expect(first.refreshing).toBe(false);
    expect(second.board?.refreshing).toBe(false);
    expect(sitrep.calls).toHaveLength(2);
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

  it("finds a Commander's project from a root discussion it owns", async () => {
    const { fake, sitrep } = loadPlugin();
    const root = fullRow("survey-decision", {
      bead: "sb-root",
      title: "Root discussion",
      thread: ROOT_COMMANDER,
      project: "fia",
    });
    sitrep.result = () => ({
      exitCode: 0,
      stdout: JSON.stringify([...rows, root]),
      stderr: "",
    });
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

describe("publish", () => {
  it("stores a valid snapshot", async () => {
    const { fake } = loadPlugin();
    const result = await fake.harness.runCli(publishArgs(snapshot()));
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toBe(
      `Stored the snapshot for all from titan at 2026-10-22T08:00:00.000Z: ${rows.length} row(s), exit code 0.`,
    );
  });

  it("joins every --snapshot part in order", async () => {
    const { fake } = loadPlugin();
    const args = publishArgs(snapshot(), 1000);
    expect(args.length).toBeGreaterThan(10);
    const result = await fake.harness.runCli(args);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${rows.length} row(s)`);
  });

  it("ignores an older snapshot, and replaces on an equal or newer one", async () => {
    const { fake } = loadPlugin();
    await fake.harness.runCli(publishArgs(snapshot()));
    const older = await fake.harness.runCli(
      publishArgs(snapshot({ generated_at: "2026-10-22T07:59:59Z" })),
    );
    expect(older).toMatchObject({ exitCode: 0 });
    expect(older.stdout).toMatch(/^Ignored: the stored snapshot for all is newer/);
    const equal = await fake.harness.runCli(publishArgs(snapshot()));
    expect(equal.stdout).toMatch(/^Stored/);
  });

  it("refuses an invalid snapshot with one line", async () => {
    const { fake } = loadPlugin();
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
  });
});
