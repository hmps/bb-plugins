import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  actionLine,
  boardMessage,
  buildBoard,
  inferProject,
  parsePr,
  postureValue,
  toCard,
  toCards,
  withSent,
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
      lifecycle: "active",
      commanderRoot: null,
      actions: [],
      actionNote:
        "No board actions: the snapshot names no Commander thread to answer.",
      sent: [],
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

describe("postureValue", () => {
  it("reads a quoted posture value", () => {
    const toml = 'slug = "vaam-main"\nproject_id = "proj_abc"\n';
    expect(postureValue(toml, "project_id")).toBe("proj_abc");
    expect(postureValue(toml, "missing")).toBeNull();
  });
});

const ROOT = "thr_commanderroot";
const DECISION = { id: "d5ead93f8671645367df1271", revision: 1 };
const BLOCKER = { id: "0a3e71fe16b96271e920e7bc", revision: 1 };

/** A row with its first `attention` event surfaced by `ref`. */
function surfaced(name: string, ref: string, change: Row = {}): Row {
  const row = fullRow(name, change);
  const state = structuredClone(row.mission_state) as Row & {
    attention: Row[];
    pending_attention: Row[];
  };
  const [first] = state.attention;
  state.attention[0] = { ...first, receipt: { message_ref: ref } };
  state.pending_attention = state.pending_attention.filter(
    (event) => event.id !== first?.id,
  );
  return { ...row, mission_state: state };
}

function offered(found: BoardCard) {
  return found.actions.map((action) => [
    action.kind,
    action.attention?.id ?? null,
    action.text,
    action.target,
  ]);
}

describe("card actions", () => {
  it("offers Go and an answer for a decision, the survey choices, and Close and Cancel", () => {
    expect(
      offered(card("survey-decision", { commander_root: ROOT })),
    ).toEqual([
      ["go", DECISION.id, "none", ROOT],
      ["decision", DECISION.id, "required", ROOT],
      ["survey-act", null, "optional", ROOT],
      ["survey-defer", null, "optional", ROOT],
      ["survey-reject", null, "optional", ROOT],
      ["close", null, "required", ROOT],
      ["cancel", null, "required", ROOT],
    ]);
  });

  it("offers a reply for a blocker and a failed verification, and no end to a complete mission", () => {
    expect(
      offered(card("new-blocker", { commander_root: ROOT, mission: "build" })),
    ).toEqual([
      ["go", DECISION.id, "none", ROOT],
      ["decision", DECISION.id, "required", ROOT],
      ["reply", BLOCKER.id, "required", ROOT],
      ["close", null, "required", ROOT],
      ["cancel", null, "required", ROOT],
    ]);
    expect(
      offered(card("missing-verified-target", { commander_root: ROOT })),
    ).toEqual([["reply", "bf3f36ab6fb8e59ba8dfa8b9", "required", ROOT]]);
    expect(card("quiet-complete", { commander_root: ROOT }).actions).toEqual(
      [],
    );
  });

  it("answers a surfaced event in the thread of its receipt, over commander_root", () => {
    const found = toCard(
      surfaced("survey-decision", "@thread:thr_receipt#msg=12", {
        commander_root: ROOT,
      }),
    );
    expect(found?.attention[0]).toMatchObject({
      surfaced: true,
      messageRef: "@thread:thr_receipt#msg=12",
    });
    expect(offered(found as BoardCard).slice(0, 2)).toEqual([
      ["go", DECISION.id, "none", "thr_receipt"],
      ["decision", DECISION.id, "required", "thr_receipt"],
    ]);
    expect(found?.actions.at(-1)?.target).toBe(ROOT);
  });

  it("offers only what has a target, and says why the rest is missing", () => {
    const none = card("survey-decision");
    expect(none.actions).toEqual([]);
    expect(none.actionNote).toBe(
      "No board actions: the snapshot names no Commander thread to answer.",
    );
    const receiptOnly = toCard(
      surfaced("survey-decision", "@thread:thr_receipt#msg=12"),
    ) as BoardCard;
    expect(receiptOnly.actions.map((action) => action.kind)).toEqual([
      "go",
      "decision",
    ]);
    expect(receiptOnly.actionNote).not.toBeNull();
    expect(
      card("survey-decision", { commander_root: "not a thread" }).actions,
    ).toEqual([]);
  });

  it("offers nothing on a stray thread or a row with no readable state", () => {
    const stray = card("stale-conflict", {
      bead: "-",
      mission: "-",
      commander_root: ROOT,
      flags: ["thread-without-bead"],
    });
    expect([stray.actions, stray.actionNote]).toEqual([[], null]);
    const preV1 = card("active", { commander_root: ROOT, mission_state: undefined });
    expect([preV1.actions, preV1.actionNote]).toEqual([[], null]);
  });
});

describe("withSent", () => {
  const base = card("survey-decision", { commander_root: ROOT });
  const sent = (
    kind: "go" | "survey-defer" | "close",
    attention: typeof DECISION | null,
    generatedAt: number,
  ) => ({ kind, attention, line: `line ${kind}`, sentAt: 5, generatedAt });

  it("hides every action for an answered event while the snapshot holds it", () => {
    const after = withSent(base, [sent("go", DECISION, 100)], 200);
    expect(after.actions.map((action) => action.kind)).toEqual([
      "survey-act",
      "survey-defer",
      "survey-reject",
      "close",
      "cancel",
    ]);
    expect(after.sent).toEqual([
      { kind: "go", attention: DECISION, line: "line go", sentAt: 5 },
    ]);
  });

  it("offers the event again once a newer revision replaces it", () => {
    const after = withSent(base, [sent("go", { ...DECISION, revision: 9 }, 100)], 200);
    expect(after).toBe(base);
  });

  it("holds one survey choice and one end per snapshot", () => {
    const now = withSent(
      base,
      [sent("survey-defer", null, 100), sent("close", null, 100)],
      100,
    );
    expect(now.actions.map((action) => action.kind)).toEqual(["go", "decision"]);
    expect(now.sent.map((action) => action.kind)).toEqual([
      "survey-defer",
      "close",
    ]);
    const newer = withSent(base, [sent("close", null, 100)], 101);
    expect(newer).toBe(base);
  });
});

describe("board message", () => {
  const event = {
    id: DECISION.id,
    revision: 1,
    kind: "decision",
    summary: "Check acceptance",
    fingerprint: "f".repeat(64),
    surfaced: false,
    messageRef: null,
  };
  const mission = { title: "Fixture mission", bead: "fixture-abc" };

  it("is the header, one action line, and the attention marker", () => {
    const line = actionLine("go", "");
    expect(line).toEqual({ line: "Decision: go" });
    expect(boardMessage(mission, event, "Decision: go")).toBe(
      "Board answer · Fixture mission (fixture-abc)\n" +
        "Decision: go\n" +
        `<!-- attention:${DECISION.id}@1#${"f".repeat(64)} -->`,
    );
    expect(boardMessage(mission, null, "Cancel this mission: dup")).toBe(
      "Board answer · Fixture mission (fixture-abc)\nCancel this mission: dup",
    );
  });

  it("writes each action line exactly, as one line", () => {
    expect(actionLine("decision", "  Ship\n it  ")).toEqual({
      line: "Decision: Ship it",
    });
    expect(actionLine("survey-act", "")).toEqual({
      line: "Survey disposition: act",
    });
    expect(actionLine("survey-defer", "after Q1")).toEqual({
      line: "Survey disposition: defer — after Q1",
    });
    expect(actionLine("survey-reject", "no")).toEqual({
      line: "Survey disposition: reject — no",
    });
    expect(actionLine("close", "done")).toEqual({
      line: "Close this mission: done",
    });
    expect(actionLine("cancel", "dup")).toEqual({
      line: "Cancel this mission: dup",
    });
    expect(actionLine("reply", "on it")).toEqual({ line: "Reply: on it" });
  });

  it("refuses text that does not fit the action", () => {
    expect(actionLine("go", "but")).toHaveProperty("error");
    for (const kind of ["decision", "close", "cancel", "reply"] as const) {
      expect(actionLine(kind, " \n "), kind).toHaveProperty("error");
    }
    expect(actionLine("reply", "x".repeat(2001))).toHaveProperty("error");
  });
});
