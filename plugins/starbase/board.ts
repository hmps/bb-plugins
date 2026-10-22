// The Mission Queue board, as pure functions.
//
// The server stores the snapshots a Starbase SITREP publishes; everything
// between a snapshot's row array and the columns the panel renders lives
// here, so the column rules are testable without the SITREP, bd, or bb.
//
// A card is one SITREP row: a mission bead, or a Crew thread under the
// Commander that no mission bead claims. The core decides which rows exist
// (every open mission and the most recent closed ones) and projects a
// `mission_state` for each; mission.ts maps that state to a column. The board
// derives no state of its own.

import {
  readRowState,
  viewMission,
  type MissionTone,
  type MissionView,
} from "./mission.js";

/** The most cards one column returns. The rest are counted, not sent. */
export const COLUMN_CARD_LIMIT = 150;

/** How much of a title, a stage line, or a detail line one card carries. */
const TITLE_MAX_CHARS = 200;
const LINE_MAX_CHARS = 240;
const DETAIL_MAX_CHARS = 600;
/**
 * The next action is an instruction, and an open card shows all of it. This
 * bound only keeps one runaway row from filling the payload.
 */
const NEXT_ACTION_MAX_CHARS = 2000;

/** The wide-layout order, left to right. */
export const COLUMN_IDS = [
  "progress",
  "waiting",
  "blocked",
  "review",
  "deploy",
  "done",
] as const;
export type ColumnId = (typeof COLUMN_IDS)[number];

export const COLUMN_TITLES: Record<ColumnId, string> = {
  progress: "In progress",
  waiting: "Waiting on you",
  blocked: "Blocked",
  review: "Commander review",
  deploy: "Awaiting deploy",
  done: "Done",
};

/**
 * SITREP row flags that the card does not show. `ok` says nothing, and
 * `output-not-recorded` is the Commander's own bookkeeping: the core turns an
 * unrecorded report into attention when it needs some.
 */
const HIDDEN_FLAGS = new Set(["ok", "output-not-recorded"]);

/** The SITREP's word for "no value" in a progress field. */
const NO_VALUE = new Set(["", "-", "unknown"]);

/** One pending event, as the card shows it. */
export interface CardAttention {
  kind: string;
  summary: string;
  /** The Commander saw it. It is still pending until resolved. */
  surfaced: boolean;
}

export interface BoardCard {
  /** The bead id, or the thread id for a thread that no bead claims. */
  id: string;
  /** Null for a thread that no bead claims. */
  bead: string | null;
  title: string;
  /** `build` or `survey`; null for a thread that no bead claims. */
  mission: string | null;
  project: string;
  threadId: string | null;
  /** bb's status for the thread, as the SITREP read it. */
  threadStatus: string | null;
  pr: { url: string; state: string } | null;
  /** SITREP row flags, as written, except the ones in HIDDEN_FLAGS. */
  flags: string[];
  column: ColumnId;
  stage: string;
  tone: MissionTone;
  nextAction: string | null;
  owner: string | null;
  ownerIdle: boolean;
  attention: CardAttention[];
  /** A short label when the board cannot trust the record; else null. */
  integrity: string | null;
  problems: string[];
  outcome: string | null;
  note: string | null;
}

export interface BoardColumn {
  id: ColumnId;
  title: string;
  /** Every card in the column, also the ones past the limit. */
  total: number;
  cards: BoardCard[];
}

/** `"all"` or one project slug. */
export type BoardScope = string;

type Json = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Cut free text down to a bounded length. */
export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** A SITREP field, or null for "-" and empty. */
function present(value: unknown): string | null {
  const found = text(value).trim();
  return found === "" || found === "-" ? null : found;
}

/**
 * The SITREP `pr` field: `<url> <state>` when the forge gave one, else a
 * marker (`none`, `-`, `?`, `n/a`) that the card shows as no PR.
 */
export function parsePr(value: unknown): { url: string; state: string } | null {
  const field = text(value).trim();
  const space = field.lastIndexOf(" ");
  if (space <= 0) return null;
  const url = field.slice(0, space);
  const state = field.slice(space + 1);
  return /^https:\/\/\S+$/.test(url) && state !== "" ? { url, state } : null;
}

/**
 * The view of a row that has no v1 state the board can read. It goes to
 * Commander review, never to a column that reads as healthy.
 */
function untrustedView(integrity: string, problem: string): MissionView {
  return {
    column: "review",
    stage: "No readable mission state",
    tone: "warn",
    nextAction: null,
    owner: null,
    ownerThread: null,
    ownerIdle: false,
    attention: [],
    integrity,
    problems: [problem],
  };
}

function viewRow(row: Json): MissionView {
  const read = readRowState(row);
  switch (read.kind) {
    case "v1":
      return viewMission(read.state);
    case "pre-v1":
      return untrustedView(
        "Pre-v1 row",
        "The SITREP row has no contract_version.",
      );
    case "unsupported":
      return untrustedView(
        "Unsupported contract",
        `The SITREP row has contract_version ${JSON.stringify(read.version)}.`,
      );
    case "unreadable":
      return untrustedView("Unreadable record", read.problem);
  }
}

/** One SITREP row as a card. A row that is not an object gives null. */
export function toCard(row: unknown): BoardCard | null {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    return null;
  }
  const raw = row as Json;
  const bead = present(raw.bead);
  const threadId = present(raw.thread);
  const id = bead ?? threadId;
  if (id === null) return null;
  const view = viewRow(raw);
  const progress =
    typeof raw.progress === "object" && raw.progress !== null
      ? (raw.progress as Json)
      : {};
  const detail = (value: unknown) => {
    const found = text(value).trim();
    return NO_VALUE.has(found) ? null : clip(found, DETAIL_MAX_CHARS);
  };
  return {
    id,
    bead,
    title: clip(text(raw.title).replace(/\s+/g, " ").trim(), TITLE_MAX_CHARS),
    mission: bead === null ? null : present(raw.mission),
    project: text(raw.project),
    threadId,
    threadStatus: present(raw.status),
    pr: parsePr(raw.pr),
    flags: (Array.isArray(raw.flags) ? raw.flags.map(text) : []).filter(
      (flag) => flag !== "" && !HIDDEN_FLAGS.has(flag),
    ),
    column: view.column,
    stage: clip(view.stage, LINE_MAX_CHARS),
    tone: view.tone,
    nextAction:
      view.nextAction === null
        ? null
        : clip(view.nextAction, NEXT_ACTION_MAX_CHARS),
    owner: view.owner,
    ownerIdle: view.ownerIdle,
    attention: view.attention.map((event) => ({
      kind: event.kind,
      summary: clip(event.summary, LINE_MAX_CHARS),
      surfaced: event.surfaced,
    })),
    integrity: view.integrity,
    problems: view.problems.map((problem) => clip(problem, DETAIL_MAX_CHARS)),
    outcome: detail(progress.outcome),
    note: detail(progress.note),
  };
}

/** Every row of one SITREP run as a card, in the SITREP's order. */
export function toCards(rows: readonly unknown[]): BoardCard[] {
  return rows.map(toCard).filter((card): card is BoardCard => card !== null);
}

export function inScope(card: BoardCard, scope: BoardScope): boolean {
  return scope === "all" || card.project === scope;
}

/**
 * The columns for one scope. Cards keep the SITREP's order: open missions
 * first, then closed ones, newest close first.
 */
export function buildBoard(
  cards: readonly BoardCard[],
  scope: BoardScope,
  limit = COLUMN_CARD_LIMIT,
): BoardColumn[] {
  const byColumn = new Map<ColumnId, BoardCard[]>(
    COLUMN_IDS.map((id) => [id, []]),
  );
  for (const card of cards) {
    if (inScope(card, scope)) byColumn.get(card.column)?.push(card);
  }
  return COLUMN_IDS.map((id) => {
    const found = byColumn.get(id) ?? [];
    return {
      id,
      title: COLUMN_TITLES[id],
      total: found.length,
      cards: found.slice(0, limit),
    };
  });
}

/**
 * The project a Commander commands: the most common project among the
 * missions its Crew threads hold. A tie goes to the slug that sorts first, so
 * the answer is stable. Null when no mission names a Crew thread.
 */
export function inferProject(
  cards: readonly BoardCard[],
  crewThreadIds: ReadonlySet<string>,
): string | null {
  const counts = new Map<string, number>();
  for (const card of cards) {
    if (card.bead === null || card.threadId === null) continue;
    if (!crewThreadIds.has(card.threadId)) continue;
    counts.set(card.project, (counts.get(card.project) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [project, count] of [...counts].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (count > bestCount) {
      best = project;
      bestCount = count;
    }
  }
  return best;
}

/** One `key = "value"` from a flat posture file, as lib.sh `posture_get` reads it. */
export function postureValue(toml: string, key: string): string | null {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m");
  return toml.match(pattern)?.[1] ?? null;
}
