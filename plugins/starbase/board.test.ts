import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBoard,
  credentialPassword,
  inferProject,
  parsePr,
  postureValue,
  toCard,
  toCards,
  type BoardCard,
} from "./board";

// The pinned core full rows: one SITREP row per case, exactly as the core
// prints it.
const FULL_ROWS = join(
  import.meta.dirname,
  "fixtures/mission-state-v1/full-rows",
);

type Row = Record<string, unknown>;

function fullRow(name: string, change: Row = {}): Row {
  const run = JSON.parse(
    readFileSync(join(FULL_ROWS, `${name}.json`), "utf8"),
  ) as { stdout: Row[] };
  return { ...run.stdout[0], ...change };
}

function card(name: string, change: Row = {}): BoardCard {
  const found = toCard(fullRow(name, change));
  if (found === null) throw new Error(`no card for ${name}`);
  return found;
}

describe("parsePr", () => {
  it("splits the url from the state at the last space", () => {
    expect(parsePr("https://github.com/x/y/pull/7 merged")).toEqual({
      url: "https://github.com/x/y/pull/7",
      state: "merged",
    });
  });

  it("reads every no-PR marker, and a url that is not https, as no PR", () => {
    for (const value of ["none", "-", "?", "n/a", "", undefined, 7]) {
      expect(parsePr(value)).toBeNull();
    }
    expect(parsePr("javascript:alert(1) open")).toBeNull();
    expect(parsePr("https://github.com/x/y/pull/7")).toBeNull();
  });
});

describe("toCard", () => {
  it("carries the row fields, the view, and the progress details", () => {
    expect(
      card("active", {
        pr: "https://github.com/x/y/pull/7 open",
        progress: {
          decision: "-",
          note: "Halfway",
          outcome: "unknown",
          report: "-",
          verdict: "-",
        },
      }),
    ).toEqual({
      id: "fixture-abc",
      bead: "fixture-abc",
      title: expect.any(String),
      mission: "build",
      project: "example",
      threadId: "thr_crew",
      threadStatus: expect.any(String),
      pr: { url: "https://github.com/x/y/pull/7", state: "open" },
      flags: [],
      column: "progress",
      stage: "Active",
      tone: "working",
      nextAction: "Check acceptance",
      owner: "Crew thr_crew",
      ownerIdle: false,
      attention: [],
      integrity: null,
      problems: [],
      outcome: null,
      note: "Halfway",
    });
  });

  it("shows a closed mission's bead status apart from its lifecycle", () => {
    const closed = fullRow("recent-closed");
    expect(closed.bead_status).toBe("closed");
    expect(card("recent-closed")).toMatchObject({
      column: "done",
      tone: "quiet",
      attention: [],
    });
  });

  it("does not raise attention the core did not record", () => {
    expect(card("quiet-complete")).toMatchObject({
      column: "done",
      attention: [],
    });
    expect(card("active").attention).toEqual([]);
  });

  it("keeps the core's failed-verification attention, and the source-error flag", () => {
    expect(card("missing-verified-target")).toMatchObject({
      column: "blocked",
      tone: "alert",
      flags: ["source-error"],
      attention: [
        {
          kind: "verification-failed",
          summary: expect.stringContaining("base-main"),
          surfaced: expect.any(Boolean),
        },
      ],
    });
  });

  it("puts a Crew thread that no bead claims on the board by its thread id", () => {
    expect(
      card("stale-conflict", {
        bead: "-",
        mission: "-",
        flags: ["thread-without-bead"],
      }),
    ).toMatchObject({
      id: "thr_crew",
      bead: null,
      mission: null,
      threadId: "thr_crew",
      flags: ["thread-without-bead"],
    });
  });

  it("files a row the board cannot read in Commander review, never in a healthy column", () => {
    const {
      contract_version: _version,
      mission_state: _state,
      ...preV1
    } = fullRow("quiet-complete");
    expect(toCard(preV1)).toMatchObject({
      column: "review",
      tone: "warn",
      integrity: "Pre-v1 row",
    });
    expect(
      toCard(fullRow("quiet-complete", { contract_version: 2 })),
    ).toMatchObject({
      column: "review",
      integrity: "Unsupported contract",
    });
    expect(
      toCard(fullRow("quiet-complete", { mission_state: "complete" })),
    ).toMatchObject({ column: "review", integrity: "Unreadable record" });
  });

  it("drops a value that is no row, or a row with neither bead nor thread", () => {
    expect(
      toCards([null, "x", [], fullRow("active", { bead: "-", thread: "-" })]),
    ).toEqual([]);
  });

  it("clips a long title", () => {
    expect(card("active", { title: "x".repeat(500) }).title).toHaveLength(200);
  });

  it("carries a long next action whole, for the open card", () => {
    const base = fullRow("active").mission_state as Row;
    const nextAction = `${"Check the deploy target. ".repeat(12)}Then ask the Governor before deployment.`;
    const found = card("active", {
      mission_state: { ...base, next_action: nextAction },
    });
    expect(nextAction.length).toBeGreaterThan(240);
    expect(found.nextAction).toBe(nextAction);
  });
});

describe("buildBoard", () => {
  const cards = toCards([
    fullRow("active", { bead: "sb-1", project: "fia" }),
    fullRow("survey-decision", { bead: "sb-2" }),
    fullRow("recent-closed", { bead: "sb-3" }),
    fullRow("quiet-complete", { bead: "sb-4" }),
  ]);

  it("returns every column in the wide order, with no Queued column", () => {
    const board = buildBoard(cards, "all");
    expect(board.map((column) => column.id)).toEqual([
      "progress",
      "waiting",
      "blocked",
      "review",
      "deploy",
      "done",
    ]);
  });

  it("filters by project and keeps the SITREP order", () => {
    const done = buildBoard(cards, "example").find((c) => c.id === "done");
    expect(done?.cards.map((c) => c.id)).toEqual(["sb-3", "sb-4"]);
    const fia = buildBoard(cards, "fia");
    expect(fia.flatMap((c) => c.cards.map((card) => card.id))).toEqual([
      "sb-1",
    ]);
  });

  it("caps a column and still counts every card", () => {
    const done = buildBoard(cards, "all", 1).find((c) => c.id === "done");
    expect(done).toMatchObject({ total: 2 });
    expect(done?.cards.map((c) => c.id)).toEqual(["sb-3"]);
  });
});

describe("inferProject", () => {
  it("takes the majority project among the Crew's missions", () => {
    const cards = toCards([
      fullRow("active", { bead: "a", thread: "thr_1", project: "fia" }),
      fullRow("active", { bead: "b", thread: "thr_2", project: "fia" }),
      fullRow("active", { bead: "c", thread: "thr_3", project: "vaam-main" }),
    ]);
    expect(inferProject(cards, new Set(["thr_1", "thr_2", "thr_3"]))).toBe(
      "fia",
    );
  });

  it("breaks a tie by slug order, and skips a thread no bead claims", () => {
    const cards = toCards([
      fullRow("active", { bead: "a", thread: "thr_1", project: "vaam-main" }),
      fullRow("active", { bead: "b", thread: "thr_2", project: "fia" }),
      fullRow("active", { bead: "-", thread: "thr_3", project: "zeta" }),
      fullRow("active", { bead: "-", thread: "thr_4", project: "zeta" }),
    ]);
    const crew = new Set(["thr_1", "thr_2", "thr_3", "thr_4"]);
    expect(inferProject(cards, crew)).toBe("fia");
    expect(inferProject(cards, new Set(["thr_none"]))).toBeNull();
  });
});

describe("file readers", () => {
  it("reads a quoted posture value", () => {
    const toml = 'slug = "vaam-main"\nproject_id = "proj_abc"\n';
    expect(postureValue(toml, "project_id")).toBe("proj_abc");
    expect(postureValue(toml, "missing")).toBeNull();
  });

  it("reads the password from the named section only", () => {
    const ini =
      "[other:1]\npassword=nope\n\n[host:3307]\nuser=root\npassword=s3cret\n";
    expect(credentialPassword(ini, "host:3307")).toBe("s3cret");
    expect(credentialPassword(ini, "absent")).toBeNull();
  });
});
