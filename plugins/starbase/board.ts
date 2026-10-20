// The Mission Queue board, as pure functions.
//
// The server reads the queue with `bd list` and reads each Crew thread through
// the SDK; everything between those reads and the columns the panel renders
// lives here, so the column rules are testable without bd or bb.
//
// A card is a mission: a bead labelled `mission:build` or `mission:survey` and
// `project:<slug>`. Every other bead is left off the board and out of the
// counts.
//
// The note parsing matches the Starbase scripts, which are the writers:
//   thread / env  the latest `key=value` token anywhere in the notes, after a
//                 line start or whitespace (scripts/lib.sh `bead_note_field`).
//   outcome       the latest line that starts with `outcome=` (sitrep.sh).
//   decision      the latest line that starts with `decision=` (sitrep.sh).
//                 `decision=none` means nothing is pending.
//   record        the latest Commander record: a `decision=` line, or a
//                 reconciliation line with `disposition=<word>`, such as
//                 `2026-10-16 15:00 reconciliation: disposition=progressing;
//                 owner=thr_x; state=...; next=...`. Notes are append-only,
//                 so the last such line is the newest.
//   note          the latest line that is neither a `key=value` record nor a
//                 reconciliation line: a hand note (sitrep.sh).

/** How far back a closed mission still shows in Done. */
export const DONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The most cards one column returns. The rest are counted, not sent. */
export const COLUMN_CARD_LIMIT = 150;

/** How much of a title, a status line, or a detail line one card carries. */
const TITLE_MAX_CHARS = 200;
const STATUS_MAX_CHARS = 240;
const DETAIL_MAX_CHARS = 600;

/** The wide-layout order, left to right. */
export const COLUMN_IDS = [
  "queued",
  "progress",
  "waiting",
  "blocked",
  "review",
  "done",
] as const;
export type ColumnId = (typeof COLUMN_IDS)[number];

export const COLUMN_TITLES: Record<ColumnId, string> = {
  queued: "Queued",
  progress: "In progress",
  waiting: "Waiting on you",
  blocked: "Blocked",
  review: "Commander review",
  done: "Done",
};

const MISSION_TYPES = new Set(["build", "survey"]);

/** One `bd list --json` row. bd omits every empty field. */
export interface RawBead {
  id?: unknown;
  title?: unknown;
  notes?: unknown;
  status?: unknown;
  labels?: unknown;
  updated_at?: unknown;
  closed_at?: unknown;
}

/** The newest Commander record on a mission. */
export type CommanderRecord =
  | { kind: "decision"; text: string }
  | {
      kind: "disposition";
      disposition: string;
      owner: string | null;
      state: string | null;
      line: string;
    };

/** What the notes of one bead record. Null means "no record". */
export interface ParsedNotes {
  thread: string | null;
  env: string | null;
  outcome: string | null;
  record: CommanderRecord | null;
  note: string | null;
}

/** What bb said about one Crew thread. */
export type ThreadInfo =
  | {
      kind: "ok";
      status: string;
      pendingInteraction: boolean;
      archived: boolean;
      pr: { url: string; state: string } | null;
    }
  /** bb answered with 404: it holds no such thread. */
  | { kind: "gone" }
  /** bb did not give the state: any other failure. */
  | { kind: "unreadable" };

/** Small marks for a Crew thread the board cannot follow. */
export type CardFlag = "thread-gone" | "thread-unreadable" | "thread-archived";

export interface BoardCard {
  id: string;
  title: string;
  /** `build` or `survey`. */
  mission: string;
  project: string;
  /** One line on where the mission stands; null when nothing says. */
  status: string | null;
  threadId: string | null;
  pr: { url: string; state: string } | null;
  flags: CardFlag[];
  outcome: string | null;
  note: string | null;
  /** The newest Commander record, as written. */
  record: string | null;
  updatedAt: string;
  closedAt: string | null;
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

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Cut free text down to a bounded length. */
export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** The value of the last `<key>=<token>` in the notes, as lib.sh reads it. */
function lastToken(notes: string, key: string): string | null {
  const pattern = new RegExp(`(?:^|\\s)${key}=(\\S+)`, "g");
  let found: string | null = null;
  for (const match of notes.matchAll(pattern)) found = match[1];
  return found;
}

/** The text after `<key>=` on the last line that starts with it. */
function lastLine(lines: readonly string[], key: string): string | null {
  const prefix = `${key}=`;
  let found: string | null = null;
  for (const line of lines) {
    if (line.startsWith(prefix)) found = line.slice(prefix.length);
  }
  return found === "" ? null : found;
}

const RECORD_LINE = /^[A-Za-z][A-Za-z0-9_.-]*=/;
const DISPOSITION = /(?:^|\s)disposition=([A-Za-z0-9_-]+)/;
/** A `; key=` boundary between the fields of a reconciliation line. */
const FIELD_BOUNDARY = /;\s*(?=[a-z_]+=)/;

/** The `key=value` fields of a reconciliation line, from `disposition=` on. */
function dispositionRecord(line: string): CommanderRecord | null {
  const match = DISPOSITION.exec(line);
  if (match === null) return null;
  const fields = new Map<string, string>();
  for (const part of line.slice(match.index).trim().split(FIELD_BOUNDARY)) {
    const eq = part.indexOf("=");
    const value = part
      .slice(eq + 1)
      .replace(/;\s*$/, "")
      .trim();
    if (eq > 0 && value !== "") fields.set(part.slice(0, eq), value);
  }
  return {
    kind: "disposition",
    disposition: match[1],
    owner: fields.get("owner") ?? null,
    state: fields.get("state") ?? null,
    line,
  };
}

export function parseNotes(notes: string): ParsedNotes {
  const lines = notes
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0);
  let record: CommanderRecord | null = null;
  let note: string | null = null;
  for (const line of lines) {
    if (line.startsWith("decision=")) {
      const decision = line.slice("decision=".length);
      if (decision !== "") record = { kind: "decision", text: decision };
      continue;
    }
    const disposition = dispositionRecord(line);
    if (disposition !== null) record = disposition;
    else if (!RECORD_LINE.test(line)) note = line;
  }
  return {
    thread: lastToken(notes, "thread"),
    env: lastToken(notes, "env"),
    outcome: lastLine(lines, "outcome"),
    record,
    note,
  };
}

/**
 * A decision is pending when one is recorded and it is not `none`. Crews also
 * write `none; <reason>` (for example `none; blocked on ...`): nothing is asked
 * of the Governor, and the reason says why the mission waits.
 */
export function decisionPending(decision: string | null): boolean {
  return decision !== null && !/^none\b/i.test(decision.trim());
}

/** The reason after a `none; ...` decision, or null. */
function noneReason(decision: string): string | null {
  const reason = decision.trim().replace(/^none\b[\s;:,.\-–—]*/i, "");
  return reason === decision.trim() || reason === "" ? null : reason;
}

function labelValue(labels: readonly string[], prefix: string): string | null {
  const label = labels.find((entry) => entry.startsWith(prefix));
  return label === undefined ? null : label.slice(prefix.length);
}

/** A mission bead as the board reads it. */
export interface MissionBead {
  id: string;
  title: string;
  status: string;
  project: string;
  mission: string;
  updatedAt: string;
  closedAt: string | null;
  notes: ParsedNotes;
}

/** Null for every bead that is not a mission with a project. */
export function toMissionBead(raw: RawBead): MissionBead | null {
  const id = text(raw.id);
  if (id === "") return null;
  const labels = Array.isArray(raw.labels) ? raw.labels.map(text) : [];
  const project = labelValue(labels, "project:");
  if (project === null || project === "") return null;
  const mission = labels
    .filter((label) => label.startsWith("mission:"))
    .map((label) => label.slice("mission:".length))
    .find((type) => MISSION_TYPES.has(type));
  if (mission === undefined) return null;
  const closedAt = text(raw.closed_at);
  return {
    id,
    title: text(raw.title),
    status: text(raw.status) || "open",
    project,
    mission,
    updatedAt: text(raw.updated_at),
    closedAt: closedAt === "" ? null : closedAt,
    notes: parseNotes(text(raw.notes)),
  };
}

export function inScope(bead: MissionBead, scope: BoardScope): boolean {
  return scope === "all" || bead.project === scope;
}

/** When a closed bead closed, in ms. bd always writes closed_at; updated_at is the fallback. */
function closedTime(bead: MissionBead): number {
  const parsed = Date.parse(bead.closedAt ?? bead.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Whether the board needs bb's view of this bead's Crew thread. */
export function needsThreadRead(bead: MissionBead): boolean {
  return bead.status !== "closed" && bead.notes.thread !== null;
}

const WORKING_STATUSES = new Set(["active", "starting", "stopping", "pending"]);

/** Dispositions that hand the mission back to the Commander to review. */
function reviewDisposition(disposition: string): boolean {
  return disposition.startsWith("complete") || disposition === "preserve_state";
}

/**
 * The column for one bead, or null when it does not belong on the board (a
 * closed bead older than the Done window).
 *
 * Precedence: Done > Waiting on you > Blocked > In progress > Commander review
 * > Queued. A live pending interaction or a failed Crew thread beats the
 * newest Commander record. A bead whose thread bb cannot show stays on the
 * board, in Commander review with a flag, unless a stronger rule puts it
 * elsewhere.
 */
export function classify(
  bead: MissionBead,
  thread: ThreadInfo | undefined,
  now: number,
): { column: ColumnId; flags: CardFlag[] } | null {
  if (bead.status === "closed") {
    if (now - closedTime(bead) > DONE_WINDOW_MS) return null;
    return { column: "done", flags: [] };
  }

  const flags: CardFlag[] = [];
  if (bead.notes.thread !== null) {
    if (thread === undefined || thread.kind === "unreadable") {
      flags.push("thread-unreadable");
    } else if (thread.kind === "gone") {
      flags.push("thread-gone");
    } else if (thread.archived) {
      flags.push("thread-archived");
    }
  }
  // An archived thread is no longer live: it neither asks nor works.
  const live = thread?.kind === "ok" && !thread.archived ? thread : null;
  const record = bead.notes.record;
  const disposition = record?.kind === "disposition" ? record.disposition : "";
  const place = (column: ColumnId) => ({ column, flags });

  if (live?.pendingInteraction) return place("waiting");
  if (live?.status === "error") return place("blocked");
  if (record?.kind === "decision" && decisionPending(record.text)) {
    return place("waiting");
  }
  if (disposition === "governor_decision") return place("waiting");
  if (disposition === "external_blocker") return place("blocked");
  if (record?.kind === "decision" && /\bblocked\b/i.test(noneReason(record.text) ?? "")) {
    return place("blocked");
  }
  if (
    (live !== null && WORKING_STATUSES.has(live.status)) ||
    bead.status === "in_progress" ||
    disposition === "progressing"
  ) {
    return place("progress");
  }
  if (bead.notes.thread !== null || reviewDisposition(disposition)) {
    return place("review");
  }
  return place("queued");
}

/** One line on where a mission stands, from the strongest signal it has. */
function statusLine(
  bead: MissionBead,
  thread: ThreadInfo | undefined,
  column: ColumnId,
): string | null {
  if (column === "done") return bead.notes.outcome;
  const live = thread?.kind === "ok" && !thread.archived ? thread : null;
  if (live?.pendingInteraction) return "The Crew thread waits for an answer.";
  if (live?.status === "error") return "The Crew thread failed.";
  const record = bead.notes.record;
  if (record?.kind === "decision") {
    if (decisionPending(record.text)) return record.text;
    return noneReason(record.text) ?? bead.notes.outcome;
  }
  if (record?.disposition === "external_blocker") {
    return `Blocked on ${record.owner ?? "an outside owner"}`;
  }
  return record?.state ?? bead.notes.outcome;
}

function recordText(record: CommanderRecord | null): string | null {
  if (record === null) return null;
  return record.kind === "decision" ? `decision=${record.text}` : record.line;
}

function toCard(
  bead: MissionBead,
  thread: ThreadInfo | undefined,
  column: ColumnId,
  flags: CardFlag[],
): BoardCard {
  const ok = thread?.kind === "ok" ? thread : null;
  const detail = (value: string | null) =>
    value === null ? null : clip(value, DETAIL_MAX_CHARS);
  const status = statusLine(bead, thread, column);
  return {
    id: bead.id,
    title: clip(bead.title.replace(/\s+/g, " ").trim(), TITLE_MAX_CHARS),
    mission: bead.mission,
    project: bead.project,
    status: status === null ? null : clip(status, STATUS_MAX_CHARS),
    threadId: bead.notes.thread,
    pr: ok?.pr ?? null,
    flags,
    outcome: detail(bead.notes.outcome),
    note: detail(bead.notes.note),
    record: detail(recordText(bead.notes.record)),
    updatedAt: bead.updatedAt,
    closedAt: bead.closedAt,
  };
}

/** Newest first; Done by close time, the rest by last update. */
function sortKey(card: BoardCard): string {
  return card.closedAt ?? card.updatedAt;
}

export function buildBoard(
  beads: readonly MissionBead[],
  threads: ReadonlyMap<string, ThreadInfo>,
  scope: BoardScope,
  now: number,
  limit = COLUMN_CARD_LIMIT,
): BoardColumn[] {
  const byColumn = new Map<ColumnId, BoardCard[]>(
    COLUMN_IDS.map((id) => [id, []]),
  );
  for (const bead of beads) {
    if (!inScope(bead, scope)) continue;
    const thread =
      bead.notes.thread === null ? undefined : threads.get(bead.notes.thread);
    const placed = classify(bead, thread, now);
    if (placed === null) continue;
    byColumn
      .get(placed.column)
      ?.push(toCard(bead, thread, placed.column, placed.flags));
  }
  return COLUMN_IDS.map((id) => {
    const cards = byColumn.get(id) ?? [];
    cards.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
    return {
      id,
      title: COLUMN_TITLES[id],
      total: cards.length,
      cards: cards.slice(0, limit),
    };
  });
}

/**
 * The project a Commander commands: the most common `project:` label among
 * the beads its Crew threads were dispatched for. A tie goes to the slug that
 * sorts first, so the answer is stable. Null when no bead names a Crew thread.
 */
export function inferProject(
  beads: readonly MissionBead[],
  crewThreadIds: ReadonlySet<string>,
): string | null {
  const counts = new Map<string, number>();
  for (const bead of beads) {
    const thread = bead.notes.thread;
    if (thread === null || !crewThreadIds.has(thread)) continue;
    counts.set(bead.project, (counts.get(bead.project) ?? 0) + 1);
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

/**
 * The `password=` value under one `[section]` of an ini-style credentials
 * file. Null when the section or the key is absent.
 */
export function credentialPassword(
  ini: string,
  section: string,
): string | null {
  let inSection = false;
  for (const line of ini.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inSection = trimmed === `[${section}]`;
      continue;
    }
    if (inSection && trimmed.startsWith("password=")) {
      return trimmed.slice("password=".length);
    }
  }
  return null;
}
