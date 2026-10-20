// The Starbase mission-state contract v1, as the board consumes it.
//
// The Starbase core owns the state: it stores it, checks every update and
// projects one `mission_state` per SITREP row. The board is a view. It reads
// the projection, checks its shape, and maps it to a column and a few labels.
// It never derives lifecycle, `pending_attention` or `archive_allowed` itself.
//
// The rules here follow `docs/mission-state-v1.md` in the Starbase core. The
// pinned copies of its synthetic fixtures in `fixtures/mission-state-v1/` are
// the executable contract the tests check against.

import type { ColumnId } from "./board.js";

/** The only SITREP contract version this board reads. */
export const CONTRACT_VERSION = 1;

export const INTEGRITIES = ["valid", "legacy", "invalid", "conflict"] as const;
export type Integrity = (typeof INTEGRITIES)[number];

export const LIFECYCLES = [
  "active",
  "source-ready",
  "ready-for-deploy",
  "awaiting-decision",
  "blocked",
  "complete",
  "cancelled",
  "unverified",
] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export const ATTENTION_KINDS = [
  "blocker",
  "verification-failed",
  "decision",
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export interface MissionOwner {
  thread: string;
  role: "crew" | "commander";
}

export interface MissionTarget {
  name: string;
  commit: string | null;
  status: "pending" | "verified";
}

export interface MissionAttention {
  id: string;
  revision: number;
  kind: AttentionKind;
  summary: string;
  /** Set when the event was surfaced to the Commander. It never resolves it. */
  surfaced: boolean;
}

export interface MissionDisposition {
  action: "act" | "defer" | "reject";
  implementationMission: string | null;
}

/**
 * The fields of one `mission_state` the board shows. Evidence, receipts and
 * report details stay in the core; the board only needs to know they exist.
 */
export interface MissionState {
  integrity: Integrity;
  problems: string[];
  revision: number | null;
  lifecycle: Lifecycle;
  owner: MissionOwner | null;
  ownerActive: boolean;
  nextAction: string | null;
  targets: MissionTarget[];
  disposition: MissionDisposition | null;
  pendingAttention: MissionAttention[];
  /** `report.verdict`, or null with no report. A Crew verdict proves nothing. */
  reportVerdict: string | null;
  archiveAllowed: boolean;
}

/** The exact field set of a v1 `mission_state`. */
const STATE_FIELDS = [
  "integrity",
  "problems",
  "revision",
  "lifecycle",
  "owner",
  "owner_active",
  "next_action",
  "evidence",
  "targets",
  "disposition",
  "attention",
  "pending_attention",
  "report",
  "archive_allowed",
] as const;

type Json = Record<string, unknown>;

class ShapeError extends Error {}

function fail(message: string): never {
  throw new ShapeError(message);
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, what: string): Json {
  return isObject(value) ? value : fail(`${what} is not an object`);
}

function array(value: unknown, what: string): unknown[] {
  return Array.isArray(value) ? value : fail(`${what} is not an array`);
}

function nonEmpty(value: unknown, what: string): string {
  return typeof value === "string" && value !== ""
    ? value
    : fail(`${what} is not a nonempty string`);
}

function nullableString(value: unknown, what: string): string | null {
  return value === null ? null : nonEmpty(value, what);
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string,
): T {
  return allowed.includes(value as T)
    ? (value as T)
    : fail(`${what} is not one of ${allowed.join(", ")}`);
}

function positiveInt(value: unknown, what: string): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fail(`${what} is not a positive integer`);
}

function boolean(value: unknown, what: string): boolean {
  return typeof value === "boolean" ? value : fail(`${what} is not a boolean`);
}

function attention(value: unknown, what: string): MissionAttention {
  const item = object(value, what);
  return {
    id: nonEmpty(item.id, `${what}.id`),
    revision: positiveInt(item.revision, `${what}.revision`),
    kind: oneOf(item.kind, ATTENTION_KINDS, `${what}.kind`),
    summary: nonEmpty(item.summary, `${what}.summary`),
    surfaced: item.receipt !== null && item.receipt !== undefined,
  };
}

function toState(value: unknown): MissionState {
  const raw = object(value, "mission_state");
  const keys = Object.keys(raw);
  const missing = STATE_FIELDS.filter((key) => !(key in raw));
  if (missing.length > 0) fail(`mission_state lacks ${missing.join(", ")}`);
  const extra = keys.filter(
    (key) => !(STATE_FIELDS as readonly string[]).includes(key),
  );
  if (extra.length > 0) fail(`mission_state has unknown ${extra.join(", ")}`);

  const owner =
    raw.owner === null
      ? null
      : (() => {
          const o = object(raw.owner, "owner");
          return {
            thread: nonEmpty(o.thread, "owner.thread"),
            role: oneOf(o.role, ["crew", "commander"] as const, "owner.role"),
          };
        })();
  const disposition =
    raw.disposition === null
      ? null
      : (() => {
          const d = object(raw.disposition, "disposition");
          return {
            action: oneOf(
              d.action,
              ["act", "defer", "reject"] as const,
              "disposition.action",
            ),
            implementationMission:
              d.implementation_mission === undefined
                ? null
                : nullableString(
                    d.implementation_mission,
                    "disposition.implementation_mission",
                  ),
          };
        })();
  const report = raw.report === null ? null : object(raw.report, "report");
  array(raw.evidence, "evidence");
  array(raw.attention, "attention").forEach((item, i) =>
    attention(item, `attention[${i}]`),
  );

  return {
    integrity: oneOf(raw.integrity, INTEGRITIES, "integrity"),
    problems: array(raw.problems, "problems").map((p, i) =>
      nonEmpty(p, `problems[${i}]`),
    ),
    revision:
      raw.revision === null ? null : positiveInt(raw.revision, "revision"),
    lifecycle: oneOf(raw.lifecycle, LIFECYCLES, "lifecycle"),
    owner,
    ownerActive: boolean(raw.owner_active, "owner_active"),
    nextAction: nullableString(raw.next_action, "next_action"),
    targets: array(raw.targets, "targets").map((value, i) => {
      const t = object(value, `targets[${i}]`);
      return {
        name: nonEmpty(t.name, `targets[${i}].name`),
        commit: nullableString(t.commit, `targets[${i}].commit`),
        status: oneOf(
          t.status,
          ["pending", "verified"] as const,
          `targets[${i}].status`,
        ),
      };
    }),
    disposition,
    pendingAttention: array(raw.pending_attention, "pending_attention").map(
      (item, i) => attention(item, `pending_attention[${i}]`),
    ),
    reportVerdict:
      report === null ? null : nonEmpty(report.verdict, "report.verdict"),
    archiveAllowed: boolean(raw.archive_allowed, "archive_allowed"),
  };
}

/**
 * What one SITREP row says about its mission state:
 *   v1           a well-formed v1 `mission_state`;
 *   pre-v1       a row with no `contract_version`, from a SITREP that does not
 *                project state yet;
 *   unsupported  a `contract_version` this board does not read;
 *   unreadable   a v1 row whose `mission_state` breaks the contract.
 * Only `v1` carries a state. The others never default to healthy.
 */
export type RowState =
  | { kind: "v1"; state: MissionState; beadStatus: string | null }
  | { kind: "pre-v1" }
  | { kind: "unsupported"; version: unknown }
  | { kind: "unreadable"; problem: string };

export function readRowState(row: Json): RowState {
  if (!("contract_version" in row)) return { kind: "pre-v1" };
  if (row.contract_version !== CONTRACT_VERSION) {
    return { kind: "unsupported", version: row.contract_version };
  }
  try {
    return {
      kind: "v1",
      state: toState(row.mission_state),
      beadStatus: typeof row.bead_status === "string" ? row.bead_status : null,
    };
  } catch (error) {
    if (error instanceof ShapeError) {
      return { kind: "unreadable", problem: error.message };
    }
    throw error;
  }
}

/**
 * One SITREP run, read the way the core's `consume_result` reads it.
 *
 *   exit 0 + a row array   current rows; the only way to show an empty queue.
 *   exit 1 + a row array   current but partial rows: `incomplete`.
 *   anything else          the prior rows, marked `stale`, with the error; no
 *                          prior rows gives `rows: null`, "unavailable".
 * A row with an unsupported `contract_version` fails the whole run.
 */
export interface SitrepRead<Row = Json> {
  rows: Row[] | null;
  incomplete: boolean;
  stale: boolean;
  error: string | null;
}

function parseRows(stdout: string): Json[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every(isObject)) return null;
  const supported = parsed.every(
    (row) =>
      !("contract_version" in row) || row.contract_version === CONTRACT_VERSION,
  );
  return supported ? parsed : null;
}

export function consumeSitrep<Row = Json>(
  exitCode: number,
  stdout: string,
  stderr: string,
  prior: Row[] | null,
): SitrepRead<Row | Json> {
  const rows = parseRows(stdout);
  if (exitCode === 0 && rows !== null) {
    return { rows, incomplete: false, stale: false, error: null };
  }
  if (exitCode === 1 && rows !== null) {
    return {
      rows,
      incomplete: true,
      stale: false,
      error: stderr || "partial source failure",
    };
  }
  return {
    rows: prior,
    incomplete: true,
    stale: prior !== null,
    error: stderr || "source unavailable",
  };
}

/** How a card reads at a glance. Only `alert` asks for the user's eye. */
export type MissionTone = "alert" | "warn" | "working" | "waiting" | "quiet";

export interface MissionView {
  column: ColumnId;
  /** The lifecycle in words, with the target count where it matters. */
  stage: string;
  tone: MissionTone;
  nextAction: string | null;
  /** "Crew thr_x" or "Commander thr_y"; null when the state names no owner. */
  owner: string | null;
  ownerThread: string | null;
  /** True when an owner is named but bb does not show it active right now. */
  ownerIdle: boolean;
  /** Pending events, decisions first. Surfaced ones stay until resolved. */
  attention: MissionAttention[];
  /** A short label for non-valid integrity; null when the state is valid. */
  integrity: string | null;
  problems: string[];
}

const STAGES: Record<Lifecycle, string> = {
  active: "Active",
  "source-ready": "Source ready, not deployed",
  "ready-for-deploy": "Ready for deploy",
  "awaiting-decision": "Awaiting decision",
  blocked: "Blocked",
  complete: "Complete",
  cancelled: "Cancelled",
  unverified: "Unverified",
};

const LIFECYCLE_COLUMNS: Record<Lifecycle, ColumnId> = {
  active: "progress",
  "source-ready": "deploy",
  "ready-for-deploy": "deploy",
  "awaiting-decision": "waiting",
  blocked: "blocked",
  complete: "done",
  cancelled: "done",
  unverified: "review",
};

const INTEGRITY_LABELS: Record<Exclude<Integrity, "valid">, string> = {
  legacy: "Legacy record",
  invalid: "Invalid record",
  conflict: "Changed outside checked update",
};

const ATTENTION_ORDER: Record<AttentionKind, number> = {
  decision: 0,
  blocker: 1,
  "verification-failed": 2,
};

/**
 * The column and labels for one v1 mission state.
 *
 * Precedence, strongest first:
 *   1. a record that is not valid goes to Commander review, whatever its
 *      lifecycle says: the board cannot trust it;
 *   2. a pending decision goes to Waiting on you, a pending blocker or failed
 *      verification to Blocked, even on a mission marked complete;
 *   3. otherwise the lifecycle picks the column.
 * Source-ready and ready-for-deploy have their own column, so merged code
 * never reads as done.
 */
export function viewMission(state: MissionState): MissionView {
  const attention = [...state.pendingAttention].sort(
    (a, b) => ATTENTION_ORDER[a.kind] - ATTENTION_ORDER[b.kind],
  );
  let column = LIFECYCLE_COLUMNS[state.lifecycle];
  if (state.integrity !== "valid") column = "review";
  else if (attention.some((a) => a.kind === "decision")) column = "waiting";
  else if (attention.length > 0) column = "blocked";

  const verified = state.targets.filter((t) => t.status === "verified").length;
  const total = state.targets.length;
  let stage = STAGES[state.lifecycle];
  if (
    total > 0 &&
    (state.lifecycle === "source-ready" ||
      state.lifecycle === "ready-for-deploy")
  ) {
    stage += ` · ${verified}/${total} targets verified`;
  }

  // Problems are shown, never raised: only canonical attention and the
  // lifecycle make a card ask for the user's eye.
  let tone: MissionTone;
  if (column === "waiting" || column === "blocked") tone = "alert";
  else if (column === "review") tone = "warn";
  else if (column === "progress" && state.ownerActive) tone = "working";
  else if (column === "done") tone = "quiet";
  else tone = "waiting";

  return {
    column,
    stage,
    tone,
    nextAction: state.nextAction,
    owner:
      state.owner === null
        ? null
        : `${state.owner.role === "crew" ? "Crew" : "Commander"} ${state.owner.thread}`,
    ownerThread: state.owner?.thread ?? null,
    ownerIdle: state.owner !== null && !state.ownerActive,
    attention,
    integrity:
      state.integrity === "valid" ? null : INTEGRITY_LABELS[state.integrity],
    problems: state.problems,
  };
}
