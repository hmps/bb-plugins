// bb-plugin-inbox store: the items table and the detection log.
//
// Plain functions over a better-sqlite3 database and an injected clock, so
// tests run without a bb host. The store never publishes; the server does
// that after each write.
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import {
  LIMITS,
  type Card,
  type CloseReason,
  type DetectionOutcome,
  type Item,
  type ItemKind,
  type ItemSource,
} from "./contract";

type Db = Database.Database;

export const DETECTION_LOG_KEEP = 2000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS items (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     project_id TEXT,
     thread_title TEXT,
     project_name TEXT,
     parent_thread_id TEXT,
     kind TEXT NOT NULL,
     question TEXT NOT NULL,
     question_norm TEXT NOT NULL,
     context TEXT,
     options TEXT,
     recommendation TEXT,
     ref TEXT,
     source TEXT NOT NULL,
     card TEXT,
     interaction_id TEXT,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     last_asked_at INTEGER NOT NULL,
     ask_count INTEGER NOT NULL,
     read_at INTEGER,
     snoozed_until INTEGER,
     closed_at INTEGER,
     close_reason TEXT,
     answer TEXT,
     message_seq INTEGER,
     excerpt TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS items_thread ON items (thread_id, status)`,
  `CREATE INDEX IF NOT EXISTS items_status ON items (status, last_asked_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS items_interaction ON items (interaction_id)
     WHERE interaction_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS detection_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     thread_id TEXT NOT NULL,
     at INTEGER NOT NULL,
     outcome TEXT NOT NULL,
     scores TEXT,
     pass_two_ran INTEGER NOT NULL,
     created_ids TEXT NOT NULL,
     repeated_ids TEXT NOT NULL,
     resolved_ids TEXT NOT NULL,
     duration_ms INTEGER NOT NULL,
     error TEXT
   )`,
];

/** Creates the tables when they do not exist. Safe to run on every load. */
export function initStore(db: Db): void {
  for (const statement of SCHEMA) db.exec(statement);
  // 0.1.4 added items.excerpt. Older stores get the column; old rows keep NULL.
  const columns = db.prepare(`PRAGMA table_info(items)`).all() as { name: string }[];
  if (!columns.some(({ name }) => name === "excerpt")) {
    db.exec(`ALTER TABLE items ADD COLUMN excerpt TEXT`);
  }
}

/** "inb_" + 10 url-safe random characters. */
export function newItemId(): string {
  return `inb_${randomBytes(8).toString("base64url").slice(0, 10)}`;
}

/** Lowercase, collapse whitespace, drop trailing punctuation. Used for repeats. */
export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s?.!:;,]+$/, "");
}

export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function clipOrNull(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : clip(trimmed, max);
}

function cleanOptions(options: readonly string[] | null | undefined): string[] | null {
  if (!options) return null;
  const list = options
    .map((option) => option.trim())
    .filter((option) => option !== "")
    .slice(0, LIMITS.options)
    .map((option) => clip(option, LIMITS.option));
  return list.length === 0 ? null : list;
}

interface ItemRow {
  id: string;
  thread_id: string;
  project_id: string | null;
  thread_title: string | null;
  project_name: string | null;
  parent_thread_id: string | null;
  kind: string;
  question: string;
  context: string | null;
  options: string | null;
  recommendation: string | null;
  ref: string | null;
  source: string;
  card: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  last_asked_at: number;
  ask_count: number;
  read_at: number | null;
  snoozed_until: number | null;
  closed_at: number | null;
  close_reason: string | null;
  answer: string | null;
  message_seq: number | null;
  excerpt: string | null;
}

function toItem(row: ItemRow): Item {
  return {
    id: row.id,
    threadId: row.thread_id,
    projectId: row.project_id,
    threadTitle: row.thread_title,
    projectName: row.project_name,
    parentThreadId: row.parent_thread_id,
    kind: row.kind as ItemKind,
    question: row.question,
    context: row.context,
    options: row.options === null ? null : (JSON.parse(row.options) as string[]),
    recommendation: row.recommendation,
    ref: row.ref,
    source: row.source as ItemSource,
    card: row.card === null ? null : (JSON.parse(row.card) as Card),
    status: row.status as Item["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAskedAt: row.last_asked_at,
    askCount: row.ask_count,
    readAt: row.read_at,
    snoozedUntil: row.snoozed_until,
    closedAt: row.closed_at,
    closeReason: row.close_reason as CloseReason | null,
    answer: row.answer,
    messageSeq: row.message_seq,
    excerpt: row.excerpt,
  };
}

/** Facts about the source thread, snapshotted on the item. */
export interface ThreadSnapshot {
  threadId: string;
  projectId: string | null;
  threadTitle: string | null;
  projectName: string | null;
  parentThreadId: string | null;
}

/** The ask fields a new item or a repeat carries. */
export interface AskFields {
  kind: ItemKind;
  question: string;
  context?: string | null;
  options?: readonly string[] | null;
  recommendation?: string | null;
  ref?: string | null;
  excerpt?: string | null;
}

export interface NewItem extends ThreadSnapshot, AskFields {
  source: ItemSource;
  card?: Card | null;
  messageSeq?: number | null;
}

export interface DetectionLogRow {
  id: number;
  threadId: string;
  at: number;
  outcome: DetectionOutcome | "answered-in-thread";
  scores: unknown;
  passTwoRan: boolean;
  createdIds: string[];
  repeatedIds: string[];
  resolvedIds: string[];
  durationMs: number;
  error: string | null;
}

export interface Counts {
  openCount: number;
  snoozedCount: number;
  unreadCount: number;
}

export type Store = ReturnType<typeof createStore>;

export function createStore(
  db: Db,
  now: () => number = Date.now,
  /** Called when a read wakes snoozed items, so the caller can publish. */
  onWake: () => void = () => {},
) {
  initStore(db);

  const one = (sql: string, ...params: unknown[]): Item | null => {
    const row = db.prepare(sql).get(...params) as ItemRow | undefined;
    return row === undefined ? null : toItem(row);
  };
  const many = (sql: string, ...params: unknown[]): Item[] =>
    (db.prepare(sql).all(...params) as ItemRow[]).map(toItem);

  /**
   * Turns snoozed items whose time passed back into open, unread items.
   * Returns the number of items it woke.
   */
  function wakeSnoozed(): number {
    const at = now();
    const woken = db
      .prepare(
        `UPDATE items
            SET status = 'open', snoozed_until = NULL, read_at = NULL, updated_at = ?
          WHERE status = 'snoozed' AND snoozed_until <= ?`,
      )
      .run(at, at).changes;
    if (woken > 0) onWake();
    return woken;
  }

  function get(id: string): Item | null {
    wakeSnoozed();
    return one(`SELECT * FROM items WHERE id = ?`, id);
  }

  function require(id: string): Item {
    const item = get(id);
    if (item === null) throw new Error(`no inbox item ${id}`);
    return item;
  }

  function insert(input: NewItem): Item {
    const at = now();
    const id = newItemId();
    const question = clip(input.question.trim(), LIMITS.question);
    const options = cleanOptions(input.options);
    db.prepare(
      `INSERT INTO items (
         id, thread_id, project_id, thread_title, project_name, parent_thread_id,
         kind, question, question_norm, context, options, recommendation, ref,
         source, card, interaction_id, status, created_at, updated_at,
         last_asked_at, ask_count, read_at, snoozed_until, closed_at,
         close_reason, answer, message_seq, excerpt
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 1,
                 NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    ).run(
      id,
      input.threadId,
      input.projectId,
      input.threadTitle,
      input.projectName,
      input.parentThreadId,
      input.kind,
      question,
      normalizeQuestion(question),
      clipOrNull(input.context, LIMITS.context),
      options === null ? null : JSON.stringify(options),
      clipOrNull(input.recommendation, LIMITS.recommendation),
      clipOrNull(input.ref, LIMITS.ref),
      input.source,
      input.card ? JSON.stringify(input.card) : null,
      input.card ? input.card.interactionId : null,
      at,
      at,
      at,
      input.messageSeq ?? null,
      clipOrNull(input.excerpt, LIMITS.excerpt),
    );
    return require(id);
  }

  /**
   * A repeat of an open ask: bump askCount and lastAskedAt, refresh the
   * fields the new ask carries (a detected repeat can reword the question). Never changes status or read state.
   */
  function bump(id: string, fields: Partial<AskFields> & { snapshot?: ThreadSnapshot }): Item {
    const item = require(id);
    const at = now();
    const options =
      fields.options === undefined ? item.options : cleanOptions(fields.options);
    const question = fields.question?.trim() ? clip(fields.question.trim(), LIMITS.question) : item.question;
    db.prepare(
      `UPDATE items
          SET ask_count = ask_count + 1, last_asked_at = ?, updated_at = ?,
              question = ?, question_norm = ?, context = ?, options = ?, recommendation = ?, ref = ?,
              excerpt = ?, thread_title = ?, project_name = ?
        WHERE id = ?`,
    ).run(
      at,
      at,
      question,
      normalizeQuestion(question),
      fields.context === undefined ? item.context : clipOrNull(fields.context, LIMITS.context),
      options === null ? null : JSON.stringify(options),
      fields.recommendation === undefined
        ? item.recommendation
        : clipOrNull(fields.recommendation, LIMITS.recommendation),
      fields.ref === undefined || fields.ref === null ? item.ref : clipOrNull(fields.ref, LIMITS.ref),
      fields.excerpt === undefined || fields.excerpt === null
        ? item.excerpt
        : clipOrNull(fields.excerpt, LIMITS.excerpt),
      fields.snapshot?.threadTitle ?? item.threadTitle,
      fields.snapshot?.projectName ?? item.projectName,
      id,
    );
    return require(id);
  }

  /** Open and snoozed items of a thread whose question matches. */
  function findRepeat(threadId: string, question: string, sources: readonly ItemSource[]): Item | null {
    const norm = normalizeQuestion(clip(question.trim(), LIMITS.question));
    const marks = sources.map(() => "?").join(", ");
    return one(
      `SELECT * FROM items
        WHERE thread_id = ? AND status != 'closed' AND question_norm = ?
          AND source IN (${marks})
        ORDER BY last_asked_at DESC LIMIT 1`,
      threadId,
      norm,
      ...sources,
    );
  }

  /** The item that mirrors a card, in any status. */
  function byInteraction(interactionId: string): Item | null {
    return one(`SELECT * FROM items WHERE interaction_id = ?`, interactionId);
  }

  function markRead(id: string): Item {
    const item = require(id);
    if (item.readAt !== null) return item;
    const at = now();
    db.prepare(`UPDATE items SET read_at = ?, updated_at = ? WHERE id = ?`).run(at, at, id);
    return require(id);
  }

  function snooze(id: string, until: number): Item {
    require(id);
    db.prepare(
      `UPDATE items SET status = 'snoozed', snoozed_until = ?, updated_at = ?
        WHERE id = ? AND status != 'closed'`,
    ).run(until, now(), id);
    return require(id);
  }

  function unsnooze(id: string): Item {
    require(id);
    db.prepare(
      `UPDATE items SET status = 'open', snoozed_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'snoozed'`,
    ).run(now(), id);
    return require(id);
  }

  /** Closes an item. A closed item stays as it was. */
  function close(id: string, reason: CloseReason, answer: string | null = null): Item {
    const at = now();
    db.prepare(
      `UPDATE items
          SET status = 'closed', closed_at = ?, updated_at = ?, close_reason = ?,
              answer = ?, snoozed_until = NULL
        WHERE id = ? AND status != 'closed'`,
    ).run(at, at, reason, answer === null ? null : clip(answer, LIMITS.answer), id);
    return require(id);
  }

  /** Closes every not-closed item of a thread. Returns their ids. */
  function closeThread(threadId: string, reason: CloseReason): string[] {
    const ids = (
      db
        .prepare(`SELECT id FROM items WHERE thread_id = ? AND status != 'closed'`)
        .all(threadId) as { id: string }[]
    ).map((row) => row.id);
    for (const id of ids) close(id, reason);
    return ids;
  }

  /** Open and snoozed items, newest ask first. Closed ones too when asked. */
  function list(options: { includeClosed?: boolean; closedLimit?: number } = {}): Item[] {
    wakeSnoozed();
    const live = many(
      `SELECT * FROM items WHERE status != 'closed' ORDER BY last_asked_at DESC, id`,
    );
    if (!options.includeClosed) return live;
    const closed = many(
      `SELECT * FROM items WHERE status = 'closed' ORDER BY closed_at DESC, id LIMIT ?`,
      options.closedLimit ?? 200,
    );
    return [...live, ...closed];
  }

  /** Open and snoozed items of one thread. */
  function threadItems(threadId: string): Item[] {
    wakeSnoozed();
    return many(
      `SELECT * FROM items WHERE thread_id = ? AND status != 'closed'
        ORDER BY last_asked_at DESC, id`,
      threadId,
    );
  }

  /** Not-closed card items, optionally of one thread. */
  function liveCards(threadId?: string): Item[] {
    return threadId === undefined
      ? many(`SELECT * FROM items WHERE source = 'card' AND status != 'closed'`)
      : many(
          `SELECT * FROM items WHERE source = 'card' AND status != 'closed' AND thread_id = ?`,
          threadId,
        );
  }

  function counts(): Counts {
    wakeSnoozed();
    const row = db
      .prepare(
        `SELECT
           SUM(status = 'open') AS open_count,
           SUM(status = 'snoozed') AS snoozed_count,
           SUM(status = 'open' AND read_at IS NULL) AS unread_count
         FROM items`,
      )
      .get() as { open_count: number | null; snoozed_count: number | null; unread_count: number | null };
    return {
      openCount: row.open_count ?? 0,
      snoozedCount: row.snoozed_count ?? 0,
      unreadCount: row.unread_count ?? 0,
    };
  }

  /** The oldest open item's createdAt, or null. */
  function oldestOpenAt(): number | null {
    wakeSnoozed();
    const row = db
      .prepare(`SELECT MIN(created_at) AS at FROM items WHERE status = 'open'`)
      .get() as { at: number | null };
    return row.at;
  }

  function logDetection(row: Omit<DetectionLogRow, "id">): void {
    db.prepare(
      `INSERT INTO detection_log
         (thread_id, at, outcome, scores, pass_two_ran, created_ids, repeated_ids,
          resolved_ids, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.threadId,
      row.at,
      row.outcome,
      row.scores === null || row.scores === undefined ? null : JSON.stringify(row.scores),
      row.passTwoRan ? 1 : 0,
      JSON.stringify(row.createdIds),
      JSON.stringify(row.repeatedIds),
      JSON.stringify(row.resolvedIds),
      Math.max(0, Math.round(row.durationMs)),
      row.error,
    );
    db.prepare(
      `DELETE FROM detection_log
        WHERE id NOT IN (SELECT id FROM detection_log ORDER BY id DESC LIMIT ?)`,
    ).run(DETECTION_LOG_KEEP);
  }

  function listDetections(limit: number): DetectionLogRow[] {
    const rows = db
      .prepare(`SELECT * FROM detection_log ORDER BY id DESC LIMIT ?`)
      .all(limit) as {
      id: number;
      thread_id: string;
      at: number;
      outcome: string;
      scores: string | null;
      pass_two_ran: number;
      created_ids: string;
      repeated_ids: string;
      resolved_ids: string;
      duration_ms: number;
      error: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      at: row.at,
      outcome: row.outcome as DetectionLogRow["outcome"],
      scores: row.scores === null ? null : JSON.parse(row.scores),
      passTwoRan: row.pass_two_ran === 1,
      createdIds: JSON.parse(row.created_ids) as string[],
      repeatedIds: JSON.parse(row.repeated_ids) as string[],
      resolvedIds: JSON.parse(row.resolved_ids) as string[],
      durationMs: row.duration_ms,
      error: row.error,
    }));
  }

  return {
    wakeSnoozed,
    get,
    require,
    insert,
    bump,
    findRepeat,
    byInteraction,
    markRead,
    snooze,
    unsnooze,
    close,
    closeThread,
    list,
    threadItems,
    liveCards,
    counts,
    oldestOpenAt,
    logDetection,
    listDetections,
  };
}
