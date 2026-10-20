import { describe, expect, it } from "vitest";
import {
  COLUMN_CARD_LIMIT,
  DONE_WINDOW_MS,
  buildBoard,
  classify,
  credentialPassword,
  inferProject,
  parseNotes,
  postureValue,
  toMissionBead,
  type MissionBead,
  type RawBead,
  type ThreadInfo,
} from "./board";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function bead(
  overrides: Partial<RawBead> & { notes?: string } = {},
): MissionBead {
  const parsed = toMissionBead({
    id: "sb-1",
    title: "A mission",
    status: "open",
    labels: ["project:vaam-main", "mission:build"],
    updated_at: "2026-10-19T10:00:00Z",
    ...overrides,
  });
  if (parsed === null) throw new Error("fixture bead has no project label");
  return parsed;
}

function thread(
  overrides: Partial<Extract<ThreadInfo, { kind: "ok" }>> = {},
): ThreadInfo {
  return {
    kind: "ok",
    status: "idle",
    pendingInteraction: false,
    archived: false,
    pr: null,
    ...overrides,
  };
}

const DISPATCHED = "thread=thr_crew env=env_crew mode=worktree";

function reconciliation(fields: string): string {
  return `2026-10-16 15:00 reconciliation: ${fields}`;
}

describe("parseNotes", () => {
  it("takes the latest value of each record", () => {
    const notes = [
      "thread=thr_old env=env_old",
      "outcome=first try",
      "decision=merge?",
      "thread=thr_new env=env_new",
      "outcome=PR opened",
      "decision=none",
    ].join("\n");
    expect(parseNotes(notes)).toEqual({
      thread: "thr_new",
      env: "env_new",
      outcome: "PR opened",
      record: { kind: "decision", text: "none" },
      note: null,
    });
  });

  it("does not read a key=value inside prose as a record line", () => {
    const notes = [
      "outcome=done",
      "Asked owner=Hampus and decision=later in chat.",
    ].join("\n");
    const parsed = parseNotes(notes);
    expect(parsed.outcome).toBe("done");
    expect(parsed.record).toBeNull();
    expect(parsed.note).toBe("Asked owner=Hampus and decision=later in chat.");
  });

  it("keeps the latest hand note and skips blank lines", () => {
    expect(parseNotes("first note\n\noutcome=x\nsecond note  \n\n").note).toBe(
      "second note",
    );
  });

  it("reads an empty env token as absent, like lib.sh", () => {
    const parsed = parseNotes("thread=thr_a env= mode=worktree");
    expect(parsed.thread).toBe("thr_a");
    expect(parsed.env).toBeNull();
  });

  it("reads the fields of a reconciliation line, with ; inside the state", () => {
    const line = reconciliation(
      "disposition=external_blocker; owner=Platform team; state=waits on DNS; then a retry; next=ping them; evidence=PR #4",
    );
    expect(parseNotes(`${DISPATCHED}\n${line}`).record).toEqual({
      kind: "disposition",
      disposition: "external_blocker",
      owner: "Platform team",
      state: "waits on DNS; then a retry",
      line,
    });
  });

  it("lets the newest Commander record win, decision or disposition", () => {
    const disposition = reconciliation("disposition=progressing; state=x");
    expect(parseNotes(`decision=merge?\n${disposition}`).record?.kind).toBe(
      "disposition",
    );
    expect(parseNotes(`${disposition}\ndecision=merge?`).record).toEqual({
      kind: "decision",
      text: "merge?",
    });
  });
});

describe("toMissionBead", () => {
  it("drops a bead with no project label", () => {
    expect(toMissionBead({ id: "sb-2", labels: ["mission:build"] })).toBeNull();
  });

  it("drops a bead that is not a build or survey mission", () => {
    expect(toMissionBead({ id: "sb-3", labels: ["project:fia"] })).toBeNull();
    expect(
      toMissionBead({ id: "sb-4", labels: ["project:fia", "mission:epic"] }),
    ).toBeNull();
    expect(bead({ labels: ["project:fia", "mission:survey"] }).mission).toBe(
      "survey",
    );
  });
});

describe("classify", () => {
  const column = (notes: string, info?: ThreadInfo, status = "open") =>
    classify(bead({ notes, status }), info, NOW)?.column;

  it("puts an open mission with no thread in Queued", () => {
    expect(classify(bead(), undefined, NOW)).toEqual({
      column: "queued",
      flags: [],
    });
  });

  it("puts a closed mission in Done over every other signal", () => {
    const closed = bead({
      status: "closed",
      closed_at: "2026-10-18T00:00:00Z",
      notes: `${DISPATCHED}\ndecision=merge?`,
    });
    expect(classify(closed, thread({ pendingInteraction: true }), NOW)).toEqual(
      { column: "done", flags: [] },
    );
  });

  it("leaves out a mission closed longer ago than the Done window", () => {
    const old = bead({
      status: "closed",
      closed_at: new Date(NOW - DONE_WINDOW_MS - DAY).toISOString(),
    });
    expect(classify(old, undefined, NOW)).toBeNull();
  });

  it("follows the newest Commander record", () => {
    const progressing = reconciliation("disposition=progressing; state=x");
    // A decision after a disposition: the decision counts.
    expect(
      column(`${DISPATCHED}\n${progressing}\ndecision=merge?`, thread()),
    ).toBe("waiting");
    // A disposition after a decision: the disposition counts.
    expect(
      column(`${DISPATCHED}\ndecision=merge?\n${progressing}`, thread()),
    ).toBe("progress");
  });

  it("reads decision=none after governor_decision as nothing to wait on", () => {
    const governor = reconciliation("disposition=governor_decision; state=x");
    expect(column(`${DISPATCHED}\n${governor}`, thread())).toBe("waiting");
    expect(column(`${DISPATCHED}\n${governor}\ndecision=none`, thread())).toBe(
      "review",
    );
  });

  it("reads decision=none with a reason as nothing for the Governor", () => {
    const reason = "none; blocked on admin MCP capability; owner retained";
    expect(column(`${DISPATCHED}\ndecision=${reason}`, thread())).toBe(
      "blocked",
    );
    expect(column(`${DISPATCHED}\ndecision=none. PR merged`, thread())).toBe(
      "review",
    );
    const card = buildBoard(
      [bead({ notes: `${DISPATCHED}\ndecision=${reason}` })],
      new Map([["thr_crew", thread()]]),
      "all",
      NOW,
    ).find((entry) => entry.id === "blocked")?.cards[0];
    expect(card?.status).toBe("blocked on admin MCP capability; owner retained");
  });

  it("puts external_blocker in Blocked, with its owner on the card", () => {
    const blocker = reconciliation(
      "disposition=external_blocker; owner=Hampus; state=needs a key",
    );
    const beads = [bead({ notes: `${DISPATCHED}\n${blocker}` })];
    const blocked = buildBoard(
      beads,
      new Map([["thr_crew", thread()]]),
      "all",
      NOW,
    ).find((entry) => entry.id === "blocked");
    expect(blocked?.cards[0]).toMatchObject({
      status: "Blocked on Hampus",
      record: blocker,
    });
  });

  it("lets a live pending interaction beat the newest record", () => {
    const blocker = reconciliation("disposition=external_blocker; owner=x");
    expect(
      column(`${DISPATCHED}\n${blocker}`, thread({ pendingInteraction: true })),
    ).toBe("waiting");
  });

  it("puts a failed Crew thread in Blocked, over a pending decision", () => {
    expect(
      column(`${DISPATCHED}\ndecision=merge?`, thread({ status: "error" })),
    ).toBe("blocked");
  });

  it("puts an active thread, an in_progress bead, or progressing in In progress", () => {
    expect(column(DISPATCHED, thread({ status: "active" }))).toBe("progress");
    expect(column("", undefined, "in_progress")).toBe("progress");
    expect(
      column(
        `${DISPATCHED}\n${reconciliation("disposition=progressing")}`,
        thread(),
      ),
    ).toBe("progress");
  });

  it("puts an idle Crew thread, or a finished disposition, in Commander review", () => {
    expect(column(DISPATCHED, thread())).toBe("review");
    for (const disposition of [
      "complete_preserved",
      "complete_superseded_preserved",
      "preserve_state",
    ]) {
      expect(
        column(reconciliation(`disposition=${disposition}`), undefined),
      ).toBe("review");
    }
  });

  it("keeps a card whose thread is gone, unreadable, or archived, with a flag", () => {
    expect(
      classify(bead({ notes: DISPATCHED }), { kind: "gone" }, NOW),
    ).toEqual({ column: "review", flags: ["thread-gone"] });
    expect(
      classify(bead({ notes: DISPATCHED }), { kind: "unreadable" }, NOW),
    ).toEqual({ column: "review", flags: ["thread-unreadable"] });
    expect(classify(bead({ notes: DISPATCHED }), undefined, NOW)).toEqual({
      column: "review",
      flags: ["thread-unreadable"],
    });
    expect(
      classify(
        bead({ notes: DISPATCHED }),
        thread({ status: "active", archived: true }),
        NOW,
      ),
    ).toEqual({ column: "review", flags: ["thread-archived"] });
  });
});

describe("buildBoard", () => {
  it("filters by project, sorts newest first, and caps a column with a total", () => {
    const beads = [
      bead({ id: "sb-a", updated_at: "2026-10-19T01:00:00Z" }),
      bead({ id: "sb-b", updated_at: "2026-10-19T03:00:00Z" }),
      bead({ id: "sb-c", updated_at: "2026-10-19T02:00:00Z" }),
      bead({ id: "sb-d", labels: ["project:fia", "mission:build"] }),
    ];
    const board = buildBoard(beads, new Map(), "vaam-main", NOW, 2);
    expect(board.map((entry) => entry.id)).toEqual([
      "queued",
      "progress",
      "waiting",
      "blocked",
      "review",
      "done",
    ]);
    const queued = board.find((entry) => entry.id === "queued");
    expect(queued?.total).toBe(3);
    expect(queued?.cards.map((card) => card.id)).toEqual(["sb-b", "sb-c"]);
    expect(buildBoard(beads, new Map(), "all", NOW)[0].total).toBe(4);
    expect(COLUMN_CARD_LIMIT).toBeGreaterThan(0);
  });

  it("carries the PR, the status line, and the expand details on a card", () => {
    const beads = [
      bead({
        notes: `${DISPATCHED}\noutcome=PR opened\nwaiting on CI\ndecision=merge PR #1?`,
      }),
    ];
    const threads = new Map<string, ThreadInfo>([
      [
        "thr_crew",
        thread({ pr: { url: "https://github.com/x/y/pull/1", state: "open" } }),
      ],
    ]);
    const card = buildBoard(beads, threads, "all", NOW).find(
      (entry) => entry.id === "waiting",
    )?.cards[0];
    expect(card).toEqual({
      id: "sb-1",
      title: "A mission",
      mission: "build",
      project: "vaam-main",
      status: "merge PR #1?",
      threadId: "thr_crew",
      pr: { url: "https://github.com/x/y/pull/1", state: "open" },
      flags: [],
      outcome: "PR opened",
      note: "waiting on CI",
      record: "decision=merge PR #1?",
      updatedAt: "2026-10-19T10:00:00Z",
      closedAt: null,
    });
  });

  it("uses the disposition state as the status line", () => {
    const line = reconciliation(
      "disposition=progressing; owner=crew; state=tests run; next=wait",
    );
    const card = buildBoard(
      [bead({ notes: `${DISPATCHED}\n${line}` })],
      new Map([["thr_crew", thread()]]),
      "all",
      NOW,
    ).find((entry) => entry.id === "progress")?.cards[0];
    expect(card?.status).toBe("tests run");
  });
});

describe("inferProject", () => {
  const crew = new Set(["thr_1", "thr_2", "thr_3"]);

  it("takes the majority project among the Crew's beads", () => {
    const beads = [
      bead({
        id: "a",
        labels: ["project:fia", "mission:build"],
        notes: "thread=thr_1",
      }),
      bead({
        id: "b",
        labels: ["project:vaam-main", "mission:build"],
        notes: "thread=thr_2",
      }),
      bead({
        id: "c",
        labels: ["project:vaam-main", "mission:build"],
        notes: "thread=thr_3",
      }),
      bead({
        id: "d",
        labels: ["project:fia", "mission:build"],
        notes: "thread=thr_other",
      }),
      bead({
        id: "e",
        labels: ["project:fia", "mission:build"],
        notes: "thread=thr_other2",
      }),
    ];
    expect(inferProject(beads, crew)).toBe("vaam-main");
  });

  it("breaks a tie by slug order, and is null with no Crew bead", () => {
    const beads = [
      bead({
        id: "a",
        labels: ["project:vaam-main", "mission:build"],
        notes: "thread=thr_1",
      }),
      bead({
        id: "b",
        labels: ["project:fia", "mission:build"],
        notes: "thread=thr_2",
      }),
    ];
    expect(inferProject(beads, crew)).toBe("fia");
    expect(inferProject(beads, new Set(["thr_none"]))).toBeNull();
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
