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
//
// A card can also offer actions. An action never writes state here: it is
// one message to the Commander root thread, in the exact format below, and
// the Commander records the answer through the Base scripts.

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
  id: string;
  revision: number;
  kind: string;
  summary: string;
  fingerprint: string;
  /** The Commander saw it. It is still pending until resolved. */
  surfaced: boolean;
  /** The receipt's message, `@thread:<id>#msg=<seq>`; null with no receipt. */
  messageRef: string | null;
}

export const ACTION_KINDS = [
  "go",
  "decision",
  "survey-act",
  "survey-defer",
  "survey-reject",
  "close",
  "cancel",
  "reply",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** One action a card offers now. */
export interface CardAction {
  kind: ActionKind;
  /** The pending event it answers; null for a mission-level action. */
  attention: { id: string; revision: number } | null;
  /** Whether the action takes text: an answer, a reply, a note, a reason. */
  text: "none" | "optional" | "required";
  /** The Commander root thread the message goes to. */
  target: string;
}

/** One sent action that the Commander has not answered yet. */
export interface SentAction {
  kind: ActionKind;
  attention: { id: string; revision: number } | null;
  /** The action line of the message, as sent. */
  line: string;
  sentAt: number;
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
  /** The core's lifecycle; null when the row has no readable v1 state. */
  lifecycle: string | null;
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
  /** The SITREP row's `commander_root`: the Commander root thread, or null. */
  commanderRoot: string | null;
  actions: CardAction[];
  /** Why an action the card would offer has no thread to go to; else null. */
  actionNote: string | null;
  sent: SentAction[];
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

/** A thread id as bb writes it. */
const THREAD_ID_PATTERN = /^thr_[A-Za-z0-9]+$/;

/** A receipt's `message_ref`: `@thread:<id>#msg=<seq>`. */
const MESSAGE_REF_PATTERN = /^@thread:(thr_[A-Za-z0-9]+)#msg=([1-9][0-9]*)$/;

/** The thread and message sequence a receipt names, or null. */
export function parseMessageRef(
  ref: string | null,
): { threadId: string; seq: number } | null {
  const match = ref === null ? null : MESSAGE_REF_PATTERN.exec(ref);
  return match === null
    ? null
    : { threadId: match[1] as string, seq: Number(match[2]) };
}

/**
 * The view of a row that has no v1 state the board can read. It goes to
 * Commander review, never to a column that reads as healthy.
 */
function untrustedView(integrity: string, problem: string): MissionView {
  return {
    column: "review",
    lifecycle: null,
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
  const card: BoardCard = {
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
    lifecycle: view.lifecycle,
    stage: clip(view.stage, LINE_MAX_CHARS),
    tone: view.tone,
    nextAction:
      view.nextAction === null
        ? null
        : clip(view.nextAction, NEXT_ACTION_MAX_CHARS),
    owner: view.owner,
    ownerIdle: view.ownerIdle,
    attention: view.attention.map((event) => ({
      id: event.id,
      revision: event.revision,
      kind: event.kind,
      summary: clip(event.summary, LINE_MAX_CHARS),
      fingerprint: event.fingerprint,
      surfaced: event.surfaced,
      messageRef: event.messageRef,
    })),
    integrity: view.integrity,
    problems: view.problems.map((problem) => clip(problem, DETAIL_MAX_CHARS)),
    outcome: detail(progress.outcome),
    note: detail(progress.note),
    commanderRoot: THREAD_ID_PATTERN.test(text(raw.commander_root))
      ? text(raw.commander_root)
      : null,
    actions: [],
    actionNote: null,
    sent: [],
  };
  return { ...card, ...cardActions(card) };
}

// ------------------------------------------------------------------
// Card actions. Each one is one message to a Commander root thread.
// ------------------------------------------------------------------

/** The longest answer, reply, note, or reason one action carries. */
export const ACTION_TEXT_MAX_CHARS = 2000;

/** Lifecycles that end a mission: Close and Cancel do not apply. */
const ENDED = new Set(["complete", "cancelled"]);

const NO_TARGET_NOTE =
  "No board actions: the snapshot names no Commander thread to answer.";

/**
 * The actions a card offers, from its checked state alone. An answer to a
 * surfaced event goes to the root thread whose message surfaced it; anything
 * else goes to the row's `commander_root`. An action with neither is left
 * out, and the note says why.
 */
export function cardActions(card: BoardCard): {
  actions: CardAction[];
  actionNote: string | null;
} {
  // A stray thread has no mission to answer; a row with no readable state
  // has nothing the board can check an answer against.
  if (card.bead === null || card.lifecycle === null) {
    return { actions: [], actionNote: null };
  }
  const wanted: Omit<CardAction, "target">[] = [];
  const targets: (string | null)[] = [];
  const add = (
    action: Omit<CardAction, "target">,
    target: string | null,
  ) => {
    wanted.push(action);
    targets.push(target);
  };
  for (const event of card.attention) {
    const target =
      parseMessageRef(event.messageRef)?.threadId ?? card.commanderRoot;
    const ref = { id: event.id, revision: event.revision };
    if (event.kind === "decision") {
      add({ kind: "go", attention: ref, text: "none" }, target);
      add({ kind: "decision", attention: ref, text: "required" }, target);
    } else {
      add({ kind: "reply", attention: ref, text: "required" }, target);
    }
  }
  if (card.mission === "survey" && card.lifecycle === "awaiting-decision") {
    for (const kind of ["survey-act", "survey-defer", "survey-reject"] as const) {
      add({ kind, attention: null, text: "optional" }, card.commanderRoot);
    }
  }
  if (!ENDED.has(card.lifecycle)) {
    add({ kind: "close", attention: null, text: "required" }, card.commanderRoot);
    add({ kind: "cancel", attention: null, text: "required" }, card.commanderRoot);
  }
  const actions: CardAction[] = [];
  wanted.forEach((action, index) => {
    const target = targets[index];
    if (target !== null && target !== undefined) actions.push({ ...action, target });
  });
  return {
    actions,
    actionNote: actions.length < wanted.length ? NO_TARGET_NOTE : null,
  };
}

/**
 * The one question an action answers. One answer per slot is sent: an event
 * revision, the survey disposition, or the end of the mission (Close or
 * Cancel).
 */
export function actionSlot(action: {
  kind: ActionKind;
  attention: { id: string; revision: number } | null;
}): string {
  if (action.attention !== null) {
    return `attention:${action.attention.id}@${action.attention.revision}`;
  }
  if (action.kind.startsWith("survey-")) return "survey";
  return "end";
}

/**
 * Whether a sent action still waits for the Commander on this snapshot. An
 * answer to an event waits while the snapshot still holds that event
 * revision. A mission-level action waits until a newer snapshot.
 */
export function stillWaiting(
  card: BoardCard,
  sent: { attention: { id: string; revision: number } | null; generatedAt: number },
  generatedAt: number,
): boolean {
  if (sent.attention === null) return sent.generatedAt >= generatedAt;
  const { id, revision } = sent.attention;
  return card.attention.some(
    (event) => event.id === id && event.revision === revision,
  );
}

/**
 * The card with its sent actions: each one that still waits is listed, and
 * no action for its slot is offered again.
 */
export function withSent(
  card: BoardCard,
  sent: readonly (SentAction & { generatedAt: number })[],
  generatedAt: number,
): BoardCard {
  const waiting = sent.filter((action) =>
    stillWaiting(card, action, generatedAt),
  );
  if (waiting.length === 0) return card;
  const taken = new Set(waiting.map(actionSlot));
  return {
    ...card,
    actions: card.actions.filter((action) => !taken.has(actionSlot(action))),
    sent: waiting.map(({ kind, attention, line, sentAt }) => ({
      kind,
      attention,
      line,
      sentAt,
    })),
  };
}

/** Free text as one line: every run of whitespace becomes one space. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The action line, or an error when the text does not fit the action. */
export function actionLine(
  kind: ActionKind,
  text: string,
): { line: string } | { error: string } {
  const answer = oneLine(text);
  if (answer.length > ACTION_TEXT_MAX_CHARS) {
    return { error: `The text is longer than ${ACTION_TEXT_MAX_CHARS} characters.` };
  }
  const needs = (what: string, line: string) =>
    answer === "" ? { error: `Write ${what} first.` } : { line };
  switch (kind) {
    case "go":
      return answer === ""
        ? { line: "Decision: go" }
        : { error: "Go takes no text. Use an answer instead." };
    case "decision":
      return needs("an answer", `Decision: ${answer}`);
    case "survey-act":
    case "survey-defer":
    case "survey-reject": {
      const line = `Survey disposition: ${kind.slice("survey-".length)}`;
      return { line: answer === "" ? line : `${line} — ${answer}` };
    }
    case "close":
      return needs("a reason", `Close this mission: ${answer}`);
    case "cancel":
      return needs("a reason", `Cancel this mission: ${answer}`);
    case "reply":
      return needs("a reply", `Reply: ${answer}`);
  }
}

/**
 * The message an action sends. The Base documents the same format for the
 * Commander, so keep it exact:
 *
 *   Board answer · <title> (<bead id>)
 *   <one action line>
 *   <!-- attention:<id>@<revision>#<fingerprint> -->
 *
 * The comment line is there only for an answer to an event.
 */
export function boardMessage(
  card: { title: string; bead: string },
  event: CardAttention | null,
  line: string,
): string {
  const lines = [`Board answer · ${card.title} (${card.bead})`, line];
  if (event !== null) {
    lines.push(
      `<!-- attention:${event.id}@${event.revision}#${event.fingerprint} -->`,
    );
  }
  return lines.join("\n");
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
