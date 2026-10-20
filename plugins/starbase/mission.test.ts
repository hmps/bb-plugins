import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  consumeSitrep,
  readRowState,
  viewMission,
  type MissionState,
  type RowState,
} from "./mission";

// The pinned copies of the Starbase core fixtures. `expected` in a mission
// fixture is the exact `mission_state` the core projects for its inputs.
const FIXTURES = join(import.meta.dirname, "fixtures/mission-state-v1");

type Json = Record<string, unknown>;

function fixture(name: string): Json {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

function projected(name: string): Json {
  return fixture(name).expected as Json;
}

function row(missionState: unknown, extra: Json = {}): Json {
  return {
    bead: "fixture-abc",
    contract_version: 1,
    bead_status: "open",
    mission_state: missionState,
    ...extra,
  };
}

function state(
  name: string,
  change: (raw: Json) => void = () => {},
): MissionState {
  const raw = structuredClone(projected(name));
  change(raw);
  const read = readRowState(row(raw));
  if (read.kind !== "v1")
    throw new Error(`${name} did not read: ${JSON.stringify(read)}`);
  return read.state;
}

const MISSION_FIXTURES = readdirSync(FIXTURES)
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.replace(/\.json$/, ""))
  .filter((name) => {
    const expected = fixture(name).expected;
    return (
      typeof expected === "object" &&
      expected !== null &&
      "lifecycle" in expected
    );
  });

describe("readRowState", () => {
  it("reads every projected fixture as a v1 state", () => {
    expect(MISSION_FIXTURES).toHaveLength(17);
    for (const name of MISSION_FIXTURES) {
      const read = readRowState(row(projected(name)));
      expect(read.kind, name).toBe("v1");
      const expected = projected(name);
      if (read.kind !== "v1") continue;
      expect(read.state.lifecycle, name).toBe(expected.lifecycle);
      expect(read.state.integrity, name).toBe(expected.integrity);
      expect(
        read.state.pendingAttention.map((a) => a.id),
        name,
      ).toEqual((expected.pending_attention as Json[]).map((a) => a.id));
    }
  });

  it("keeps a row from a SITREP without state, or an unsupported version, explicit", () => {
    expect(readRowState({ bead: "fixture-abc" })).toEqual({ kind: "pre-v1" });
    const future = fixture("unsupported-contract-version");
    expect(
      readRowState({ ...future, mission_state: projected("quiet-complete") }),
    ).toEqual({
      kind: "unsupported",
      version: 2,
    });
  });

  it("marks a v1 state that breaks the contract unreadable, not healthy", () => {
    const missing = structuredClone(projected("quiet-complete"));
    delete missing.pending_attention;
    const extra = { ...projected("quiet-complete"), healthy: true };
    const badLifecycle = { ...projected("quiet-complete"), lifecycle: "done" };
    for (const value of [null, "complete", missing, extra, badLifecycle]) {
      const read: RowState = readRowState(row(value));
      expect(read.kind).toBe("unreadable");
    }
  });
});

describe("consumeSitrep", () => {
  it("matches every core subprocess fixture", () => {
    const names = readdirSync(FIXTURES)
      .filter((file) => file.startsWith("subprocess-"))
      .map((file) => file.replace(/\.json$/, ""));
    expect(names).toHaveLength(5);
    for (const name of names) {
      const f = fixture(name);
      expect(
        consumeSitrep(
          f.exit_code as number,
          f.stdout as string,
          f.stderr as string,
          f.prior as Json[],
        ),
        name,
      ).toEqual(f.expected);
    }
  });

  it("is unavailable, not empty, when a first read fails", () => {
    expect(consumeSitrep(1, "", "bd failed", null)).toEqual({
      rows: null,
      incomplete: true,
      stale: false,
      error: "bd failed",
    });
  });

  it("fails the whole read on an unsupported contract version", () => {
    const prior = [{ bead: "prior" }];
    expect(consumeSitrep(0, '[{"contract_version":2}]', "", prior)).toEqual({
      rows: prior,
      incomplete: true,
      stale: true,
      error: "source unavailable",
    });
  });
});

describe("viewMission", () => {
  it("keeps merged but undeployed work open, with its target count", () => {
    for (const name of [
      "source-ready",
      "ready-for-deploy",
      "partially-deployed",
    ]) {
      expect(viewMission(state(name)).column, name).toBe("deploy");
    }
    expect(viewMission(state("source-ready")).stage).toBe(
      "Source ready, not deployed · 0/1 targets verified",
    );
    expect(viewMission(state("partially-deployed")).stage).toBe(
      "Ready for deploy · 1/2 targets verified",
    );
  });

  it("puts a returned survey report in Waiting on you", () => {
    const view = viewMission(state("awaiting-survey-decision"));
    expect(view.column).toBe("waiting");
    expect(view.tone).toBe("alert");
    expect(view.attention.map((a) => a.kind)).toEqual(["decision"]);
  });

  it("keeps a surfaced but unresolved decision visible", () => {
    // The receipt moves the event out of pending_attention; the lifecycle
    // still says a decision is open.
    const surfaced = state("awaiting-survey-decision", (raw) => {
      raw.pending_attention = [];
    });
    const view = viewMission(surfaced);
    expect(view.column).toBe("waiting");
    expect(view.stage).toBe("Awaiting decision");
    expect(view.nextAction).toBe("Check acceptance");
  });

  it("shows a new blocker after an old report", () => {
    const view = viewMission(state("pending-new-blocker-after-old-report"));
    expect(view.attention.map((a) => a.kind)).toEqual(["blocker"]);
    expect(view.column).toBe("blocked");
    expect(view.tone).toBe("alert");
    expect(view.problems).toContain(
      "current report fingerprint is not recorded",
    );
  });

  it("keeps a newer event pending after an older receipt", () => {
    const view = viewMission(state("full-fingerprint-receipt-race"));
    expect(view.column).toBe("blocked");
    expect(view.attention.map((a) => [a.kind, a.surfaced])).toEqual([
      ["blocker", false],
    ]);
  });

  it("files a quiet verified completion in Done with nothing to answer", () => {
    const view = viewMission(state("quiet-complete"));
    expect(view).toMatchObject({
      column: "done",
      stage: "Complete",
      tone: "quiet",
      attention: [],
      integrity: null,
      problems: [],
    });
  });

  it("does not file a completion with a failed source as quietly done", () => {
    const view = viewMission(state("current-failed-source"));
    expect(view.column).toBe("blocked");
    expect(view.attention.map((a) => a.kind)).toEqual(["verification-failed"]);
    expect(view.tone).toBe("alert");
    expect(view.problems).toEqual(["source failure: bb-unreachable"]);
  });

  it("sends a record the board cannot trust to Commander review", () => {
    const labels: Record<string, string> = {
      "stale-conflict": "Changed outside checked update",
      legacy: "Legacy record",
      "legacy-new-blocker-after-old-outcome": "Legacy record",
      malformed: "Invalid record",
      "unsupported-schema-version": "Invalid record",
      "cross-project-scope": "Invalid record",
    };
    for (const [name, label] of Object.entries(labels)) {
      const view = viewMission(state(name));
      expect(view.column, name).toBe("review");
      expect(view.integrity, name).toBe(label);
      expect(view.tone, name).not.toBe("quiet");
      expect(view.problems.length, name).toBeGreaterThan(0);
    }
    // A legacy mission with a new blocker still shows the blocker.
    expect(
      viewMission(state("legacy-new-blocker-after-old-outcome")).attention,
    ).toHaveLength(1);
  });

  it("keeps a direct root discussion visible under its Commander", () => {
    const view = viewMission(state("direct-root-discussion"));
    expect(view).toMatchObject({
      column: "waiting",
      owner: "Commander thr_root",
      ownerThread: "thr_root",
      nextAction: "Record Governor choice",
    });
  });

  it("does not read an idle owner as progress", () => {
    expect(viewMission(state("active"))).toMatchObject({
      column: "progress",
      tone: "working",
      ownerIdle: false,
    });
    const idle = viewMission(
      state("active", (raw) => {
        raw.owner_active = false;
      }),
    );
    expect(idle.column).toBe("progress");
    expect(idle.ownerIdle).toBe(true);
    expect(idle.tone).not.toBe("working");
  });

  it("shows a cancellation in Done as cancelled, not complete", () => {
    expect(viewMission(state("cancelled"))).toMatchObject({
      column: "done",
      stage: "Cancelled",
    });
  });
});
