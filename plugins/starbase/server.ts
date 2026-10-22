// bb-plugin-starbase backend — the Sentinel.
//
// Starbase is an orchestration model: the Governor talks to one Commander
// thread per project, and the Commander dispatches Crew threads into the
// target projects. bb already pushes a child's completion message to its
// parent, so a completed Crew needs no help from a plugin.
//
// The Sentinel covers the two cases that push does not. A Crew thread waiting
// on an interaction, or one that failed, is invisible to the Commander until
// somebody looks, so this plugin relays both as one line each. It also owns
// `bb starbase settle`, a guarded archive that refuses to file away work that
// is still on the worktree or still in review.
//
// Every relay is written to the plugin's own SQLite database first. The insert
// carries a unique dedupe key, so a replay of the same event is ignored; a
// failed send releases the key so the next identical event tries again.
//
// The plugin also serves the Mission Queue board, read-only. The plugin never
// runs the SITREP: each SITREP run, on any machine, publishes one snapshot
// with `bb starbase publish`, and the board shows the newest one stored. A
// snapshot holds every mission row with the `mission_state` the core projects
// (contract v1, mission.ts). The pure rules in board.ts and mission.ts turn
// the rows into columns. The board never writes a bead, a receipt, or any
// state.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginThreadEventPayloads,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  COLUMN_IDS,
  buildBoard,
  inferProject,
  postureValue,
  toCards,
  type BoardCard,
} from "./board.js";
import { readRows } from "./mission.js";

/**
 * The SDK does not export the pending-interaction DTO by name, so the event
 * payload it arrives on is the type of record.
 */
type PendingInteraction =
  PluginThreadEventPayloads["interaction.pending"]["interaction"];

/** One thread as `bb.sdk.threads.get` returns it. */
type ThreadRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;

/** A project directory in the Base, and the bb project its posture names. */
interface Posture {
  slug: string;
  projectId: string | null;
}

/** One stored SITREP snapshot, its rows as cards in SITREP order. */
interface StoredSnapshot {
  /** A project slug, or "all". */
  project: string;
  generatedAt: number;
  host: string;
  exitCode: number;
  cards: BoardCard[];
}

/** One row of `bb.sdk.threads.list`, which is not the same DTO as a thread. */
type ThreadListRow = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["list"]>
>[number];

const COMMANDER_PROJECTS_SETTING = "commanderProjectIds";

/** The Starbase project the first Commander runs in. */
const DEFAULT_COMMANDER_PROJECT_IDS = "proj_s9vk5k4c9u";

/** How much of an interaction prompt or an error a relay line carries. */
const SUMMARY_MAX_CHARS = 160;

/** How many threads settle inspects before it gives up on a runaway tree. */
const SETTLE_MAX_TREE_SIZE = 500;

/** Ids up to this many stay on the heading line; more get a line each. */
const INLINE_ID_LIMIT = 3;

/** Rows per `threads.list` page. Paging stops on the first short page. */
const LIST_PAGE_SIZE = 100;

/** A cap on pages per parent, so a list that never shortens cannot spin. */
const LIST_MAX_PAGES = 50;

/** The refusal when the descendant set could not be shown to be complete. */
const ENUMERATION_FAILED = "settle: could not enumerate all descendants";

/** The Base checkout: `projects/` holds the postures. */
export const DEFAULT_BASE_ROOT = "/Users/hmps/dev/starbase";

/** A thread id as bb writes it. A published Commander must be one. */
const THREAD_ID_PATTERN = /^thr_[A-Za-z0-9]+$/;

/** How long a Commander's project, inferred from its Crew, stays known. */
const COMMANDER_PROJECT_CACHE_MS = 5 * 60_000;

/** A project slug as a posture directory names it. Nothing else reaches a path. */
const PROJECT_SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;

/** The snapshot and board scope that covers every project. */
const ALL_PROJECTS = "all";

const projectScopeSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(PROJECT_SLUG_PATTERN);

/**
 * The most one published snapshot may hold, all `--snapshot` parts together.
 * A full SITREP of a large Base is well under one MiB.
 */
const SNAPSHOT_MAX_CHARS = 8 * 1024 * 1024;

/**
 * One published SITREP run, as `bb starbase publish` takes it. The schema is
 * shared with the SITREP publishers, so it is strict: a key it does not name
 * is refused, and with it anything a publisher should not send, such as a
 * credential.
 */
const snapshotSchema = z.strictObject({
  version: z.literal(1),
  generated_at: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), "is not a date"),
  host: z.string().min(1).max(200),
  project: z.union([z.literal(ALL_PROJECTS), projectScopeSchema]),
  commander: z.string().regex(THREAD_ID_PATTERN).nullable(),
  exit_code: z.number().int(),
  rows: z.array(z.record(z.string(), z.unknown())),
});

export type PublishedSnapshot = z.infer<typeof snapshotSchema>;

const boardCardSchema = z
  .object({
    id: z.string(),
    bead: z.string().nullable(),
    title: z.string(),
    mission: z.string().nullable(),
    project: z.string(),
    threadId: z.string().nullable(),
    threadStatus: z.string().nullable(),
    pr: z.object({ url: z.string(), state: z.string() }).strict().nullable(),
    flags: z.array(z.string()),
    column: z.enum(COLUMN_IDS),
    stage: z.string(),
    tone: z.enum(["alert", "warn", "working", "waiting", "quiet"]),
    nextAction: z.string().nullable(),
    owner: z.string().nullable(),
    ownerIdle: z.boolean(),
    attention: z.array(
      z
        .object({ kind: z.string(), summary: z.string(), surfaced: z.boolean() })
        .strict(),
    ),
    integrity: z.string().nullable(),
    problems: z.array(z.string()),
    outcome: z.string().nullable(),
    note: z.string().nullable(),
  })
  .strict();

const boardSchema = z
  .object({
    project: z.string(),
    /** When the SITREP run shown ran; null with no snapshot. */
    generatedAt: z.number().nullable(),
    /** The machine that published it; null with no snapshot. */
    host: z.string().nullable(),
    /**
     * How far to trust the rows. `current`: the SITREP run exited 0.
     * `partial`: a source could not be read, so some rows may be missing.
     * `unavailable`: no snapshot yet; the columns are empty, not clear.
     */
    source: z.enum(["current", "partial", "unavailable"]),
    /** Why the rows are partial; null otherwise. */
    error: z.string().nullable(),
    projects: z.array(z.string()),
    columns: z.array(
      z
        .object({
          id: z.enum(COLUMN_IDS),
          title: z.string(),
          total: z.number().int(),
          cards: z.array(boardCardSchema),
        })
        .strict(),
    ),
  })
  .strict();

const scopeSchema = z
  .object({
    /** The thread's Command project, or null when nothing decides it. */
    scope: projectScopeSchema.nullable(),
    source: z.enum(["commander", "saved", "posture", "unresolved"]),
    commanderId: z.string().nullable(),
    /** True only on a Commander: a pick there is saved for it. */
    canSave: z.boolean(),
    projects: z.array(z.string()),
  })
  .strict();

export const starbaseRpcContract = defineRpcContract({
  /**
   * The thread panel in one round trip: the thread's board scope, and the
   * board for `project` when given, else for that scope. The board is null
   * when no scope is decided and no project is given.
   */
  panel: {
    input: z
      .object({
        threadId: z.string().min(1).max(200),
        project: projectScopeSchema.optional(),
      })
      .strict(),
    output: z
      .object({ scope: scopeSchema, board: boardSchema.nullable() })
      .strict(),
  },
  /** Remember a Commander's pick; it wins over the Crew majority. */
  saveScope: {
    input: z
      .object({
        threadId: z.string().min(1).max(200),
        project: projectScopeSchema,
      })
      .strict(),
    output: z.object({ saved: z.boolean() }).strict(),
  },
  /** The board for one project slug, or `"all"`. */
  board: {
    input: z.object({ project: projectScopeSchema }).strict(),
    output: boardSchema,
  },
});

/**
 * How bb reports "you asked to start a turn on a thread that is already
 * running one" — the only send failure worth retrying with a queueing mode.
 *
 * Confirmed against the server source rather than guessed. `dispatch-attempt.ts`
 * calls `throwThreadNotWritable(thread, "already_active", "Thread is already
 * active")` when `mode: "start"` meets an active thread, and
 * `lifecycle-api-errors.ts` turns that into
 * `new ApiError(409, "thread_not_writable", message, { details: { reason,
 * archivedAt, threadStatus } })`, whose body serializes as
 * `{ code, message, details }`. The SDK's `resolveResponse` wraps a non-ok
 * response in `BbHttpError`, which carries `status`, `code` (the body's
 * top-level `code`), and `body`.
 *
 * `BbHttpError` is not exported from `@get-bb/plugin-sdk`, so this reads the
 * shape rather than using `instanceof`.
 */
export function isThreadAlreadyActiveError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    body?: { details?: { reason?: unknown } };
  };
  if (candidate.status !== 409) return false;
  if (candidate.code !== "thread_not_writable") return false;
  return candidate.body?.details?.reason === "already_active";
}

const migrations = [
  `CREATE TABLE IF NOT EXISTS mission_event (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     dedupe_key   TEXT NOT NULL UNIQUE,
     thread_id    TEXT NOT NULL,
     commander_id TEXT,
     kind         TEXT NOT NULL,
     summary      TEXT NOT NULL,
     created_at   INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS mission_event_thread
     ON mission_event (thread_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS board_scope (
     commander_id TEXT PRIMARY KEY,
     project      TEXT NOT NULL,
     updated_at   INTEGER NOT NULL
   )`,
  // The newest published SITREP per project slug, or "all". `rows` is the
  // row array as JSON; the times are epoch milliseconds.
  `CREATE TABLE IF NOT EXISTS sitrep_snapshot (
     project      TEXT PRIMARY KEY,
     generated_at INTEGER NOT NULL,
     host         TEXT NOT NULL,
     commander    TEXT,
     exit_code    INTEGER NOT NULL,
     rows         TEXT NOT NULL,
     received_at  INTEGER NOT NULL
   )`,
];

/** A mission event as the CLI reports it. */
export interface MissionEvent {
  threadId: string;
  commanderId: string | null;
  kind: string;
  summary: string;
  createdAt: number;
}

interface MissionEventDbRow {
  thread_id: string;
  commander_id: string | null;
  kind: string;
  summary: string;
  created_at: number;
}

/** One Crew line in a SITREP. */
export interface SitrepRow {
  threadId: string;
  title: string;
  status: string;
  pr: string;
  worktree: string;
  interactions: number;
  last: string;
}

const USAGE = [
  "Usage:",
  "  bb starbase sitrep [--commander <thread-id>] [--json]",
  "      Report every Crew thread under a Commander.",
  "  bb starbase settle <thread-id>",
  "      Archive a Crew thread once its worktree is clean and its PR is closed.",
  "  bb starbase publish --snapshot <json> [--snapshot <json> ...]",
  "      Store one SITREP snapshot for the board. The parts join in order.",
  "      A snapshot of one line up to 16 KiB can come as --snapshot-stdin.",
].join("\n");

/** Cut a free-text summary down to one readable line. */
export function shorten(text: string, max = SUMMARY_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

/**
 * Read the project-id list out of its setting. The SDK has no list-valued
 * setting, so the value is a multi-line string and this is the parser at the
 * boundary.
 */
export function parseProjectIds(raw: string | undefined): Set<string> {
  if (raw === undefined) return new Set();
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

/**
 * The dedupe key for a failure.
 *
 * `thread.failed` carries no id for the failure itself: the payload is
 * `{ thread, error }` and `ThreadResponse` has no turn id, so the newest
 * timestamp bb does give — `thread.updatedAt` — stands in for one, hashed
 * together with the error text. Two distinct failures on the same thread in
 * the same millisecond with identical text therefore collapse into one relay.
 * That is accepted: the alternative is relaying a replayed failure twice.
 */
export function failureDedupeKey(
  threadId: string,
  error: string | null,
  updatedAt: number,
): string {
  const digest = createHash("sha1")
    .update(`${error ?? ""}\n${updatedAt}`)
    .digest("hex");
  return `failed:${threadId}:${digest}`;
}

/** The `bb thread interactions <verb>` that resolves this interaction. */
export function resolveVerb(interaction: PendingInteraction): string {
  const payload = interaction.payload;
  if (payload.kind === "approval") {
    return payload.subject.kind === "permission_grant" ? "grant" : "approve";
  }
  if (payload.kind === "user_question") return "answer";
  return "respond";
}

/** A one-line description of what the Crew thread is waiting for. */
export function interactionSummary(interaction: PendingInteraction): string {
  const payload = interaction.payload;
  if (payload.kind === "approval") {
    const subject = payload.subject;
    if (subject.kind === "command") return shorten(subject.command);
    if (subject.kind === "tool_use") return shorten(subject.tool);
    if (subject.kind === "plan") return shorten(payload.reason ?? "plan");
    if (subject.kind === "permission_grant") {
      return shorten(subject.toolName ?? "permission grant");
    }
    return shorten(payload.reason ?? subject.kind);
  }
  if (payload.kind === "user_question") {
    return shorten(payload.questions[0]?.prompt ?? "question");
  }
  return shorten(payload.title);
}

/** The `kind` a relay line names, which is not always the payload kind. */
export function interactionKind(interaction: PendingInteraction): string {
  const payload = interaction.payload;
  if (payload.kind === "approval") return `approval/${payload.subject.kind}`;
  return payload.kind;
}

/**
 * One refusal line. It names the thread that was asked for and the thread that
 * blocked it, which are the same id when the root itself is unsafe.
 */
export function refusal(
  rootThreadId: string,
  blockingThreadId: string,
  reason: string | null,
): { exitCode: number; stderr: string } {
  const why = shorten(reason ?? "its state could not be read", 120);
  const where =
    blockingThreadId === rootThreadId
      ? blockingThreadId
      : `${blockingThreadId} (a child of ${rootThreadId})`;
  return { exitCode: 1, stderr: `Refused: ${where} — ${why}.` };
}

/**
 * Render one SITREP row. `last` is deliberately absent: the text report keeps
 * the specified columns and nothing else, so one Crew thread is one line.
 * `--json` carries `last` for a caller that wants it.
 */
export function formatSitrepRow(row: SitrepRow): string {
  return [
    row.threadId,
    row.title,
    row.status,
    `pr:${row.pr}`,
    `worktree:${row.worktree}`,
    `interactions:${row.interactions}`,
  ].join(" · ");
}

/**
 * The snapshot in `bb starbase publish` arguments. Every `--snapshot` value is
 * one part, and the parts join in order into one JSON document: the bb CLI
 * forwards argv only, and one argument has a size limit. The board refuses a
 * row array that mission.ts refuses as a whole, so publish refuses it too.
 */
export function parseSnapshot(
  args: readonly string[],
): { snapshot: PublishedSnapshot } | { error: string } {
  const parts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--snapshot") {
      return { error: `publish: unknown argument "${shorten(args[index], 40)}".` };
    }
    const part = args[index + 1];
    if (part === undefined) return { error: "publish: --snapshot needs a value." };
    parts.push(part);
    index += 1;
  }
  if (parts.length === 0) {
    return { error: "publish: no snapshot. Pass --snapshot <json>." };
  }
  const text = parts.join("");
  if (text.length > SNAPSHOT_MAX_CHARS) {
    return {
      error: `publish: the snapshot is over ${SNAPSHOT_MAX_CHARS / 1024 / 1024} MiB.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "publish: the snapshot is not valid JSON." };
  }
  const result = snapshotSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue.path.length === 0 ? "snapshot" : issue.path.join(".");
    return { error: shorten(`publish: ${where}: ${issue.message}.`, 200) };
  }
  if (readRows(result.data.rows) === null) {
    return { error: "publish: a row has an unsupported contract_version." };
  }
  return { snapshot: result.data };
}

/** `~/dev/x` becomes `/Users/me/dev/x`. Anything else is returned unchanged. */
export function expandHome(value: string, home: string = homedir()): string {
  const trimmed = value.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return `${home}/${trimmed.slice(2)}`;
  return trimmed;
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    [COMMANDER_PROJECTS_SETTING]: {
      type: "string",
      label: "Commander project ids",
      description:
        "Projects whose threads act as Commanders. One project id per line, or separated by commas. A thread whose parent runs in one of these projects is Crew.",
      experimental_multiline: true,
      default: DEFAULT_COMMANDER_PROJECT_IDS,
    },
    baseRoot: {
      type: "string",
      label: "Base root",
      description:
        "The Starbase checkout. The board reads projects/*/posture.toml here.",
      default: DEFAULT_BASE_ROOT,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);

  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO mission_event
       (dedupe_key, thread_id, commander_id, kind, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const deleteEventByKey = db.prepare(
    `DELETE FROM mission_event WHERE dedupe_key = ?`,
  );
  const selectLastEvent = db.prepare(
    `SELECT thread_id, commander_id, kind, summary, created_at
       FROM mission_event
      WHERE thread_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
  );

  /**
   * Record a mission event. Returns false when the same event was recorded
   * before, which is what stops a relay from being sent twice.
   */
  function recordEvent(args: {
    dedupeKey: string;
    threadId: string;
    commanderId: string | null;
    kind: string;
    summary: string;
  }): boolean {
    const result = insertEvent.run(
      args.dedupeKey,
      args.threadId,
      args.commanderId,
      args.kind,
      args.summary,
      Date.now(),
    );
    return result.changes > 0;
  }

  /** Release a reserved dedupe key so the same event can be relayed again. */
  function deleteEvent(dedupeKey: string): void {
    deleteEventByKey.run(dedupeKey);
  }

  function lastEvent(threadId: string): MissionEvent | null {
    const row = selectLastEvent.get(threadId) as MissionEventDbRow | undefined;
    if (row === undefined) return null;
    return {
      threadId: row.thread_id,
      commanderId: row.commander_id,
      kind: row.kind,
      summary: row.summary,
      createdAt: row.created_at,
    };
  }

  async function commanderProjectIds(): Promise<Set<string>> {
    const values = await settings.get();
    return parseProjectIds(values[COMMANDER_PROJECTS_SETTING]);
  }

  /**
   * A thread is a Commander when it runs in a Commander project AND it is a
   * root thread. The root test is what separates a Commander from the Crew it
   * dispatches into its own Base project.
   */
  function isCommander(
    thread: { parentThreadId: string | null; projectId: string },
    commanderProjects: Set<string>,
  ): boolean {
    return (
      thread.parentThreadId === null && commanderProjects.has(thread.projectId)
    );
  }

  /**
   * The Commander a thread reports to, or null when the thread is not Crew.
   *
   * A thread is Crew when its parent is a Commander, whatever project the
   * thread itself runs in — a Commander dispatching a Survey Mission inside
   * its own Base project still gets the relay. A Commander is a root thread,
   * so it can never be its own Crew: the parent test below excludes it.
   */
  async function commanderFor(thread: {
    id: string;
    parentThreadId: string | null;
    projectId: string;
  }): Promise<string | null> {
    const parentThreadId = thread.parentThreadId;
    if (parentThreadId === null) return null;
    const commanderProjects = await commanderProjectIds();
    if (commanderProjects.size === 0) return null;
    const parent = await bb.sdk.threads.get({ threadId: parentThreadId });
    if (!isCommander(parent, commanderProjects)) return null;
    return parent.id;
  }

  /**
   * Send one Sentinel line to the Commander, never steering a live turn.
   *
   * `auto` is deliberately unused. It resolves the mode from the thread's state
   * at send time, and the status this reads is already stale — a Commander that
   * was idle a moment ago can be mid-turn now, and `auto` would steer it. The
   * two explicit modes have no such reading: `start` only ever begins a turn,
   * and `queue-if-active` only ever waits.
   *
   * So an idle Commander gets `start`. When `start` is refused because the
   * Commander is no longer idle, the one retry sends `queue-if-active` instead,
   * which is where the race lands. A busy Commander skips straight to it.
   */
  async function relay(commanderId: string, text: string): Promise<void> {
    const input = [{ type: "text" as const, text, mentions: [] }];
    const commander = await bb.sdk.threads.get({ threadId: commanderId });
    if (commander.status === "idle") {
      try {
        await bb.sdk.threads.send({
          threadId: commanderId,
          mode: "start",
          input,
        });
        return;
      } catch (error) {
        // Retry ONLY on the one error that proves nothing was delivered. A
        // timeout or a dropped response says nothing about whether the server
        // accepted the message, and retrying those would post the line twice.
        if (!isThreadAlreadyActiveError(error)) throw error;
        bb.log.info(
          `starbase: ${commanderId} became active during the send; queueing instead`,
        );
      }
    }
    await bb.sdk.threads.send({
      threadId: commanderId,
      mode: "queue-if-active",
      input,
    });
  }

  /**
   * Reserve the dedupe key, send, and release the key when the send fails.
   *
   * Writing the row first is what makes a concurrent duplicate collapse, but a
   * row that outlives a failed send would suppress the relay forever. The
   * delete puts the key back so the next identical event tries again.
   */
  async function relayOnce(args: {
    dedupeKey: string;
    threadId: string;
    commanderId: string;
    kind: string;
    summary: string;
    line: string;
  }): Promise<void> {
    if (!recordEvent(args)) return;
    try {
      await relay(args.commanderId, args.line);
    } catch (error) {
      deleteEvent(args.dedupeKey);
      throw error;
    }
  }

  // ------------------------------------------------------------------
  // Relays. Event-driven, so the Sentinel never polls.
  // ------------------------------------------------------------------

  bb.events.on("interaction.pending", async ({ thread, interaction }) => {
    try {
      const commanderId = await commanderFor(thread);
      if (commanderId === null) return;
      const kind = interactionKind(interaction);
      const summary = interactionSummary(interaction);
      const line = [
        "SENTINEL interaction",
        thread.id,
        kind,
        summary,
        `resolve: bb thread interactions ${resolveVerb(interaction)} ${interaction.id} ${thread.id}`,
      ].join(" · ");
      await relayOnce({
        dedupeKey: `interaction:${thread.id}:${interaction.id}`,
        threadId: thread.id,
        commanderId,
        kind: `interaction/${kind}`,
        summary,
        line,
      });
    } catch (error) {
      bb.log.warn(`starbase: interaction relay failed: ${describe(error)}`);
    }
  });

  bb.events.on("thread.failed", async ({ thread, error }) => {
    try {
      const commanderId = await commanderFor(thread);
      if (commanderId === null) return;
      const summary = shorten(error ?? "no error text");
      const line = ["SENTINEL failed", thread.id, summary].join(" · ");
      await relayOnce({
        dedupeKey: failureDedupeKey(thread.id, error, thread.updatedAt),
        threadId: thread.id,
        commanderId,
        kind: "failed",
        summary,
        line,
      });
    } catch (err) {
      bb.log.warn(`starbase: failure relay failed: ${describe(err)}`);
    }
  });

  // bb pushes a child's completion message to its parent already, so an idle
  // Crew thread is not relayed. It is still recorded, so a SITREP can name the
  // last thing that happened.
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    try {
      const commanderId = await commanderFor(thread);
      if (commanderId === null) return;
      recordEvent({
        dedupeKey: `idle:${thread.id}:${thread.updatedAt}`,
        threadId: thread.id,
        commanderId,
        kind: "idle",
        summary: shorten(lastAssistantText ?? "idle"),
      });
    } catch (error) {
      bb.log.warn(`starbase: idle record failed: ${describe(error)}`);
    }
  });

  // ------------------------------------------------------------------
  // Environment reads, shared by the SITREP and by settle.
  // ------------------------------------------------------------------

  /**
   * What the worktree is, for the report, and whether it is safe to archive.
   *
   * `safe` is never true on an answer bb could not give: an `unavailable`
   * status means git failed, and a failure is unknown, not clean. The two
   * "there is no worktree here" answers are different — no environment at all,
   * and a `not_applicable` non-git environment. Both are definite, and neither
   * has anything to lose, so both are safe.
   */
  async function worktreeState(
    environmentId: string | null,
  ): Promise<{ label: string; safe: boolean; reason: string | null }> {
    if (environmentId === null) {
      return { label: "n/a", safe: true, reason: null };
    }
    const status = await bb.sdk.environments.status({ environmentId });
    if (status.outcome === "unavailable") {
      return {
        label: "unknown",
        safe: false,
        reason: `git could not read the worktree (${status.failure.code})`,
      };
    }
    if (status.outcome === "not_applicable") {
      // bb definitively says this environment is not a git repository.
      return { label: "n/a", safe: true, reason: null };
    }
    if (status.workspace.workingTree.hasUncommittedChanges) {
      return {
        label: "dirty",
        safe: false,
        reason: "the worktree has uncommitted changes",
      };
    }
    return { label: "clean", safe: true, reason: null };
  }

  /**
   * What the pull request is, for the report, and whether it is safe to
   * archive. `absent` — the environment simply has no PR — is safe. So is a
   * merged or closed one. An open or draft PR is not, and neither is a PR
   * state bb could not read.
   */
  async function pullRequestState(
    environmentId: string | null,
  ): Promise<{ label: string; safe: boolean; reason: string | null }> {
    if (environmentId === null) {
      return { label: "none", safe: true, reason: null };
    }
    const result = await bb.sdk.environments.pullRequest({ environmentId });
    if (result.outcome === "absent") {
      return { label: "none", safe: true, reason: null };
    }
    if (result.outcome !== "available") {
      return {
        label: "unknown",
        safe: false,
        reason: `the pull request state is ${result.outcome}`,
      };
    }
    const pr = result.pullRequest;
    const label = `${pr.url} ${pr.state}`;
    if (pr.state === "open" || pr.state === "draft") {
      return {
        label,
        safe: false,
        reason: `pull request ${pr.url} is still ${pr.state}`,
      };
    }
    return { label, safe: true, reason: null };
  }

  async function pendingInteractionCount(
    threadId: string,
    hasPendingInteraction: boolean,
  ): Promise<number> {
    if (!hasPendingInteraction) return 0;
    const interactions = await bb.sdk.threads.interactions.list({ threadId });
    return interactions.filter((entry) => entry.status === "pending").length;
  }

  // ------------------------------------------------------------------
  // CLI: `bb starbase …`.
  // ------------------------------------------------------------------

  /**
   * Every live child of a thread, hidden ones included, across every page.
   *
   * Both callers need the same guarantee and for the same reason: a child bb
   * does not return is a child nothing checks. `includeHidden` is required —
   * a hidden background worker is a real thread with a real worktree — and so
   * is paging, because one `threads.list` call returns one page.
   *
   * Returns null when the list could not be shown to be exhausted.
   */
  async function listAllPages(
    filter: (
      | { parentThreadId: string }
      | { sourceThreadId: string }
    ) & { archived?: boolean },
  ): Promise<ThreadListRow[] | null> {
    const rows: ThreadListRow[] = [];
    for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
      const batch = await bb.sdk.threads.list({
        archived: false,
        ...filter,
        includeHidden: true,
        limit: LIST_PAGE_SIZE,
        offset: page * LIST_PAGE_SIZE,
      });
      rows.push(...batch);
      // A short page is the end of the list; a full one may not be.
      if (batch.length < LIST_PAGE_SIZE) return rows;
    }
    return null;
  }

  function listChildren(
    parentThreadId: string,
  ): Promise<ThreadListRow[] | null> {
    return listAllPages({ parentThreadId });
  }

  /**
   * Threads forked from this one. A fork carries `sourceThreadId`, not
   * `parentThreadId`, so a parent-only walk never sees it — and a hidden fork
   * is exactly the thread that would be archived without ever being checked.
   */
  function listForks(sourceThreadId: string): Promise<ThreadListRow[] | null> {
    return listAllPages({ sourceThreadId });
  }

  /**
   * Threads under the tree that bb had already archived before settle ran.
   *
   * An archive-all response names these too, and putting one back would undo
   * an archive somebody else meant. They are not compensation targets, so they
   * are gathered up front and excluded from the unexpected set.
   *
   * The walk descends through archived threads as well, because an archived
   * node's own archived children are equally reachable from an archive-all.
   */
  async function listPreArchived(
    treeThreadIds: readonly string[],
  ): Promise<Set<string> | null> {
    const found = new Set<string>();
    const visited = new Set<string>();
    const queue = [...treeThreadIds];
    while (queue.length > 0) {
      if (visited.size >= SETTLE_MAX_TREE_SIZE) return null;
      const threadId = queue.shift() as string;
      if (visited.has(threadId)) continue;
      visited.add(threadId);
      for (const filter of [
        { parentThreadId: threadId },
        { sourceThreadId: threadId },
      ] as const) {
        const rows = await listAllPages({ ...filter, archived: true });
        if (rows === null) return null;
        for (const row of rows) {
          found.add(row.id);
          queue.push(row.id);
        }
      }
    }
    return found;
  }

  async function sitrep(
    commanderId: string,
  ): Promise<{ rows: SitrepRow[] } | { error: string }> {
    // Live Crew only. An archived thread has already been settled.
    const children = await listChildren(commanderId);
    if (children === null) {
      return { error: `Could not list every Crew thread under ${commanderId}.` };
    }
    const rows: SitrepRow[] = [];
    for (const child of children) {
      const [worktree, pr, interactions] = await Promise.all([
        worktreeState(child.environmentId),
        pullRequestState(child.environmentId),
        pendingInteractionCount(child.id, child.hasPendingInteraction),
      ]);
      const event = lastEvent(child.id);
      rows.push({
        // A title can carry a newline; a SITREP row cannot.
        title: shorten(child.title ?? child.titleFallback ?? "untitled", 80),
        threadId: child.id,
        status: child.status,
        pr: pr.label,
        worktree: worktree.label,
        interactions,
        last: event === null ? "none" : event.kind,
      });
    }
    return { rows };
  }

  /**
   * Resolve which Commander a CLI call is about: the flag when given, else the
   * thread the command was invoked from.
   */
  async function resolveCommander(
    flagValue: string | undefined,
    ctxThreadId: string | undefined,
  ): Promise<{ commanderId: string } | { error: string }> {
    const candidate = flagValue ?? ctxThreadId;
    if (candidate === undefined) {
      return {
        error: "No Commander. Pass --commander <thread-id>.",
      };
    }
    const commanderProjects = await commanderProjectIds();
    const thread = await bb.sdk.threads.get({ threadId: candidate });
    if (!isCommander(thread, commanderProjects)) {
      const why =
        thread.parentThreadId !== null
          ? "it is not a root thread"
          : `project ${thread.projectId} is not in ${COMMANDER_PROJECTS_SETTING}`;
      return { error: `Thread ${candidate} is not a Commander: ${why}.` };
    }
    return { commanderId: thread.id };
  }

  /**
   * Every live thread `archiveAll` would take: the thread itself and its
   * descendants, in breadth-first order. The visited set guards against a
   * parent cycle, which would otherwise loop forever.
   */
  async function threadTree(
    rootThreadId: string,
  ): Promise<{ threadIds: string[] } | { incomplete: true }> {
    const ordered: string[] = [];
    const visited = new Set<string>();
    const queue = [rootThreadId];
    while (queue.length > 0) {
      // A tree this deep was never inspected in full, so it is not known safe.
      if (ordered.length >= SETTLE_MAX_TREE_SIZE) return { incomplete: true };
      const threadId = queue.shift() as string;
      if (visited.has(threadId)) continue;
      visited.add(threadId);
      ordered.push(threadId);
      const children = await listChildren(threadId);
      if (children === null) return { incomplete: true };
      for (const child of children) queue.push(child.id);
      const forks = await listForks(threadId);
      if (forks === null) return { incomplete: true };
      for (const fork of forks) queue.push(fork.id);
    }
    return { threadIds: ordered };
  }

  /**
   * Whether settle may touch this thread at all.
   *
   * `settle` archives a tree, so it must not be pointed at an arbitrary thread.
   * The target has to sit under a Commander — Crew, or something beneath Crew —
   * and it must not be the Commander itself, because settling a Commander would
   * file away the whole Base.
   */
  async function isSettleTarget(
    threadId: string,
  ): Promise<{ ok: true } | { reason: string }> {
    const commanderProjects = await commanderProjectIds();
    if (commanderProjects.size === 0) {
      return { reason: `${COMMANDER_PROJECTS_SETTING} names no project` };
    }
    let current = await bb.sdk.threads.get({ threadId });
    if (isCommander(current, commanderProjects)) {
      return { reason: "it is a Commander, not Crew" };
    }
    // Walk up to the root. SETTLE_MAX_TREE_SIZE also caps a parent cycle.
    for (let step = 0; step < SETTLE_MAX_TREE_SIZE; step += 1) {
      const parentThreadId = current.parentThreadId;
      if (parentThreadId === null) break;
      const parent = await bb.sdk.threads.get({ threadId: parentThreadId });
      if (isCommander(parent, commanderProjects)) return { ok: true };
      current = parent;
    }
    return { reason: "it is not Crew under a Commander" };
  }

  /** `a, b, c` or `none`, for a report line. */
  /**
   * One heading of a settle report. Every id is named — a report that hides
   * ids is a report a human cannot act on, and the tree is capped at
   * SETTLE_MAX_TREE_SIZE anyway, far below the CLI's 1 MiB output limit.
   *
   * A short list stays on the heading line; a long one gets a line per id, so
   * the ids stay readable and greppable.
   */
  function section(heading: string, ids: readonly string[]): string {
    if (ids.length === 0) return `${heading}: none`;
    if (ids.length <= INLINE_ID_LIMIT) return `${heading}: ${ids.join(", ")}`;
    return [`${heading}:`, ...ids.map((id) => `  ${id}`)].join("\n");
  }

  /**
   * Put back threads bb archived that settle never checked.
   *
   * Returns the ids it could not restore, which is the part a human has to
   * deal with by hand.
   */
  async function unarchiveAll(ids: readonly string[]): Promise<string[]> {
    const stuck: string[] = [];
    for (const id of ids) {
      try {
        await bb.sdk.threads.unarchive({ threadId: id });
      } catch (error) {
        bb.log.warn(
          `starbase: could not unarchive ${id}: ${shorten(describe(error), 120)}`,
        );
        stuck.push(id);
      }
    }
    return stuck;
  }

  /**
   * Archive the checked threads, deepest first, verifying after every call.
   *
   * In SDK 0.4.47 `threads.archive` and `threads.archiveAll` both POST to the
   * same `threads/:id/archive-all` route, so there is no single-thread archive
   * to reach for: every call takes a whole subtree. Going deepest first keeps
   * each call's blast radius as small as it can be, and the check after each
   * call stops the run before the next, larger one.
   *
   * An id bb archived that settle never checked is put back immediately.
   */
  async function archiveChecked(
    rootThreadId: string,
    threadIds: readonly string[],
    checked: ReadonlySet<string>,
    preArchived: ReadonlySet<string>,
  ): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
    const order = [...threadIds].reverse();
    const archived = new Set<string>();
    const remainingAfter = (index: number): string[] =>
      order.slice(index + 1).filter((id) => !archived.has(id));
    // Stuck ids are never `checked`, so this drops them on its own.
    const asIntended = (): string[] =>
      [...archived].filter((id) => checked.has(id));

    for (let index = 0; index < order.length; index += 1) {
      const memberId = order[index];
      // An earlier subtree archive already took this one.
      if (archived.has(memberId)) continue;

      let result;
      try {
        result = await bb.sdk.threads.archive({ threadId: memberId });
      } catch (error) {
        return {
          exitCode: 1,
          stderr: [
            // Only the error text is capped. Ids never are.
            `settle ${rootThreadId}: archiving ${memberId} failed (${shorten(describe(error), 200)}).`,
            section("Archived", asIntended()),
            `Failed: ${memberId}`,
            section("Not archived", remainingAfter(index)),
          ].join("\n"),
        };
      }

      // A thread that was already archived before settle started is not
      // something settle took, so it is not something settle puts back.
      const unexpected = result.archivedThreadIds.filter(
        (id) => !checked.has(id) && !preArchived.has(id),
      );
      for (const id of result.archivedThreadIds) archived.add(id);

      if (unexpected.length > 0) {
        // Stop before the next, larger archive, and put these back.
        const stuck = await unarchiveAll(unexpected);
        const restored = unexpected.filter((id) => !stuck.includes(id));
        for (const id of restored) archived.delete(id);
        return {
          exitCode: 1,
          stderr: [
            `settle ${rootThreadId}: stopped — archiving ${memberId} also took ${unexpected.length} unchecked thread(s).`,
            section("Unchecked", unexpected),
            section("Unarchived", restored),
            section("Still archived", stuck),
            section("Archived as intended", asIntended()),
            section("Not archived", remainingAfter(index)),
          ].join("\n"),
        };
      }
    }

    return {
      exitCode: 0,
      stdout: `Settled ${rootThreadId}: archived ${archived.size} thread(s).`,
    };
  }

  /**
   * Settle refuses on the first unsafe thread in the tree, not just on the
   * root. `archiveAll` files the whole tree away, so every thread in it has to
   * be safe before any of it is archived.
   */
  async function settle(threadId: string): Promise<{
    exitCode: number;
    stdout?: string;
    stderr?: string;
  }> {
    const target = await isSettleTarget(threadId);
    if ("reason" in target) return refusal(threadId, threadId, target.reason);

    const thread = await bb.sdk.threads.get({ threadId });
    const tree = await threadTree(threadId);
    if ("incomplete" in tree) {
      return { exitCode: 1, stderr: ENUMERATION_FAILED };
    }
    const checked = new Set(tree.threadIds);
    for (const memberId of tree.threadIds) {
      const member =
        memberId === threadId
          ? thread
          : await bb.sdk.threads.get({ threadId: memberId });
      const worktree = await worktreeState(member.environmentId);
      if (!worktree.safe) {
        return refusal(threadId, memberId, worktree.reason);
      }
      const pr = await pullRequestState(member.environmentId);
      if (!pr.safe) {
        return refusal(threadId, memberId, pr.reason);
      }
    }

    const preArchived = await listPreArchived(tree.threadIds);
    if (preArchived === null) {
      return {
        exitCode: 1,
        stderr: "settle: could not enumerate already-archived descendants",
      };
    }

    const outcome = await archiveChecked(
      threadId,
      tree.threadIds,
      checked,
      preArchived,
    );
    recordEvent({
      dedupeKey: `settled:${threadId}:${Date.now()}`,
      threadId,
      commanderId: thread.parentThreadId,
      kind: "settled",
      summary: shorten(outcome.stdout ?? outcome.stderr ?? "settled", 120),
    });
    return outcome;
  }

  // ------------------------------------------------------------------
  // The Mission Queue board, read-only.
  // ------------------------------------------------------------------

  async function baseRoot(): Promise<string> {
    const values = await settings.get();
    const root = expandHome(values.baseRoot);
    if (root === "") throw new Error("The Base root setting is empty.");
    return root;
  }

  /** Every posture slug in the Base, with its bb project id when it names one. */
  async function loadPostures(): Promise<Posture[]> {
    const projectsDir = join(await baseRoot(), "projects");
    let entries;
    try {
      entries = await readdir(projectsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const postures: Posture[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROJECT_SLUG_PATTERN.test(entry.name)) {
        continue;
      }
      try {
        const toml = await readFile(
          join(projectsDir, entry.name, "posture.toml"),
          "utf8",
        );
        postures.push({
          slug: entry.name,
          projectId: postureValue(toml, "project_id"),
        });
      } catch {
        // A directory without a posture is not a project.
      }
    }
    return postures.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  // The board reads the stored snapshots on every call. They change only when
  // a SITREP publishes, and a call costs a few small reads.

  const selectSnapshots = db.prepare(
    `SELECT project, generated_at, host, exit_code, rows FROM sitrep_snapshot`,
  );

  /** Every stored snapshot, by project. */
  function loadSnapshots(): Map<string, StoredSnapshot> {
    const stored = selectSnapshots.all() as {
      project: string;
      generated_at: number;
      host: string;
      exit_code: number;
      rows: string;
    }[];
    return new Map(
      stored.map((row) => [
        row.project,
        {
          project: row.project,
          generatedAt: row.generated_at,
          host: row.host,
          exitCode: row.exit_code,
          cards: toCards(JSON.parse(row.rows) as unknown[]),
        },
      ]),
    );
  }

  /** The postures, or none when the Base cannot be read. */
  function postures(): Promise<Posture[]> {
    return loadPostures().catch(() => []);
  }

  /**
   * The snapshot a project's board shows: the newer of its own and the
   * "all" one. The "all" board shows only the "all" snapshot.
   */
  function snapshotFor(
    snapshots: ReadonlyMap<string, StoredSnapshot>,
    project: string,
  ): StoredSnapshot | null {
    const all = snapshots.get(ALL_PROJECTS) ?? null;
    const own = project === ALL_PROJECTS ? null : (snapshots.get(project) ?? null);
    if (own === null || all === null) return own ?? all;
    return own.generatedAt >= all.generatedAt ? own : all;
  }

  /**
   * Every card the snapshots know, one per id, from the newest snapshot that
   * carries it. The project picker and a Commander's project read these.
   */
  function knownCards(snapshots: ReadonlyMap<string, StoredSnapshot>) {
    const byId = new Map<string, BoardCard>();
    const oldestFirst = [...snapshots.values()].sort(
      (a, b) => a.generatedAt - b.generatedAt,
    );
    for (const snap of oldestFirst) {
      for (const card of snap.cards) byId.set(card.id, card);
    }
    return [...byId.values()];
  }

  /**
   * The picker's choices: every posture slug, every project with a stored
   * snapshot, and every slug a mission carries.
   */
  function projectSlugs(
    snapshots: ReadonlyMap<string, StoredSnapshot>,
    known: readonly Posture[],
  ): string[] {
    const slugs = new Set(known.map((posture) => posture.slug));
    for (const project of snapshots.keys()) {
      if (project !== ALL_PROJECTS) slugs.add(project);
    }
    for (const card of knownCards(snapshots)) {
      if (card.bead !== null && PROJECT_SLUG_PATTERN.test(card.project)) {
        slugs.add(card.project);
      }
    }
    return [...slugs].sort((a, b) => a.localeCompare(b));
  }

  function boardFor(
    snapshots: ReadonlyMap<string, StoredSnapshot>,
    known: readonly Posture[],
    project: string,
  ) {
    const snap = snapshotFor(snapshots, project);
    const projects = projectSlugs(snapshots, known);
    if (snap === null) {
      return {
        project,
        generatedAt: null,
        host: null,
        source: "unavailable" as const,
        error: null,
        projects,
        columns: buildBoard([], project),
      };
    }
    // A failed source leaves rows out, so these rows never read as current.
    const partial = snap.exitCode !== 0;
    return {
      project,
      generatedAt: snap.generatedAt,
      host: snap.host,
      source: partial ? ("partial" as const) : ("current" as const),
      error: partial
        ? `The SITREP on ${snap.host} exited ${snap.exitCode}: a source could not be read, so some missions may be missing.`
        : null,
      projects,
      columns: buildBoard(snap.cards, project),
    };
  }

  const selectScope = db.prepare(
    `SELECT project FROM board_scope WHERE commander_id = ?`,
  );
  const upsertScope = db.prepare(
    `INSERT INTO board_scope (commander_id, project, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (commander_id) DO UPDATE
       SET project = excluded.project, updated_at = excluded.updated_at`,
  );

  function savedScope(commanderId: string): string | null {
    const row = selectScope.get(commanderId) as { project: string } | undefined;
    return row?.project ?? null;
  }

  /** A Commander's inferred project. It changes rarely, and a pick clears it. */
  const commanderProjects = new Map<string, { at: number; project: string }>();

  /**
   * The project a Commander commands, from the missions its Crew were
   * dispatched for. Archived Crew count too: a Commander whose missions are
   * all settled still commands the same project. A mission bead that links
   * the Commander's own thread (a root discussion) counts as well, so a
   * Commander with no Crew still finds its project.
   */
  async function commanderProject(
    commanderId: string,
    cards: readonly BoardCard[],
  ): Promise<string | null> {
    const cached = commanderProjects.get(commanderId);
    if (
      cached !== undefined &&
      Date.now() - cached.at < COMMANDER_PROJECT_CACHE_MS
    ) {
      return cached.project;
    }
    const [live, archived] = await Promise.all([
      listAllPages({ parentThreadId: commanderId }),
      listAllPages({ parentThreadId: commanderId, archived: true }),
    ]);
    const crew = new Set([
      commanderId,
      ...[...(live ?? []), ...(archived ?? [])].map((row) => row.id),
    ]);
    const project = inferProject(cards, crew);
    // A Commander with no Crew yet is asked again next time.
    if (project !== null) {
      commanderProjects.set(commanderId, { at: Date.now(), project });
    }
    return project;
  }

  /** Who a thread is to the board: a Commander, Crew of one, or neither. */
  async function boardRole(threadId: string): Promise<{
    thread: ThreadRow;
    commanderId: string | null;
    canSave: boolean;
  }> {
    const thread = await bb.sdk.threads.get({ threadId });
    const canSave = isCommander(thread, await commanderProjectIds());
    // A Crew thread whose Commander bb cannot read falls back to posture.
    const commanderId = canSave
      ? thread.id
      : await commanderFor(thread).catch(() => null);
    return { thread, commanderId, canSave };
  }

  /**
   * The board scope for a thread. On a Commander, or a Crew thread of one, a
   * saved pick wins; otherwise the Crew decide. Any other thread uses the
   * posture of its own project.
   */
  async function resolveScope(
    role: Awaited<ReturnType<typeof boardRole>>,
    snapshots: ReadonlyMap<string, StoredSnapshot>,
    known: readonly Posture[],
  ) {
    const { thread, commanderId, canSave } = role;
    let scope: string | null = null;
    let source: "commander" | "saved" | "posture" | "unresolved" = "unresolved";
    if (commanderId !== null) {
      const saved = savedScope(commanderId);
      const inferred =
        saved === null
          ? await commanderProject(commanderId, knownCards(snapshots))
          : null;
      if (saved !== null) {
        scope = saved;
        source = "saved";
      } else if (inferred !== null) {
        scope = inferred;
        source = "commander";
      }
    } else {
      const posture = known.find(
        (entry) => entry.projectId === thread.projectId,
      );
      if (posture !== undefined) {
        scope = posture.slug;
        source = "posture";
      }
    }
    return {
      scope,
      source,
      commanderId,
      canSave,
      projects: projectSlugs(snapshots, known),
    };
  }

  bb.rpc.register(starbaseRpcContract, {
    async panel({ threadId, project }) {
      const [known, role] = await Promise.all([
        postures(),
        boardRole(threadId),
      ]);
      const snapshots = loadSnapshots();
      const scope = await resolveScope(role, snapshots, known);
      const shown = project ?? scope.scope;
      return {
        scope,
        board: shown === null ? null : boardFor(snapshots, known, shown),
      };
    },
    async saveScope({ threadId, project }) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (!isCommander(thread, await commanderProjectIds())) {
        return { saved: false };
      }
      upsertScope.run(thread.id, project, Date.now());
      commanderProjects.delete(thread.id);
      return { saved: true };
    },
    async board({ project }) {
      return boardFor(loadSnapshots(), await postures(), project);
    },
  });

  // A snapshot replaces the stored one for its project unless that one is
  // newer, in one statement: two publishes that race cannot both win.
  const upsertSnapshot = db.prepare(
    `INSERT INTO sitrep_snapshot
       (project, generated_at, host, commander, exit_code, rows, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project) DO UPDATE
       SET generated_at = excluded.generated_at, host = excluded.host,
           commander = excluded.commander, exit_code = excluded.exit_code,
           rows = excluded.rows, received_at = excluded.received_at
     WHERE excluded.generated_at >= sitrep_snapshot.generated_at`,
  );

  /** Store a checked snapshot, or say why it was ignored. Both exit 0. */
  function publish(snapshot: PublishedSnapshot): string {
    const generatedAt = Date.parse(snapshot.generated_at);
    const stored = upsertSnapshot.run(
      snapshot.project,
      generatedAt,
      snapshot.host,
      snapshot.commander,
      snapshot.exit_code,
      JSON.stringify(snapshot.rows),
      Date.now(),
    );
    const when = new Date(generatedAt).toISOString();
    if (stored.changes === 0) {
      return `Ignored: the stored snapshot for ${snapshot.project} is newer than ${when}.`;
    }
    return `Stored the snapshot for ${snapshot.project} from ${snapshot.host} at ${when}: ${snapshot.rows.length} row(s), exit code ${snapshot.exit_code}.`;
  }

  settings.onChange(() => {
    commanderProjects.clear();
  });

  bb.cli.register({
    name: "starbase",
    summary: "Report and settle Crew threads, and store SITREP snapshots",
    commands: [
      {
        name: "sitrep",
        summary: "Report every Crew thread under a Commander",
        usage: "bb starbase sitrep [--commander <thread-id>] [--json]",
      },
      {
        name: "settle",
        summary: "Archive a Crew thread once its worktree and PR are done",
        usage: "bb starbase settle <thread-id>",
      },
      {
        name: "publish",
        summary: "Store one SITREP snapshot for the Mission Queue board",
        usage: "bb starbase publish --snapshot <json> [--snapshot <json> ...]",
      },
    ],
    async run(argv, ctx) {
      const [sub, ...rest] = argv;
      try {
        if (sub === undefined || sub === "help" || sub === "--help") {
          return { exitCode: 0, stdout: USAGE };
        }
        if (sub === "sitrep") {
          const json = rest.includes("--json");
          const flagIndex = rest.indexOf("--commander");
          const flagValue =
            flagIndex === -1 ? undefined : rest[flagIndex + 1];
          if (flagIndex !== -1 && flagValue === undefined) {
            return {
              exitCode: 1,
              stderr: `--commander needs a thread id.\n${USAGE}`,
            };
          }
          const resolved = await resolveCommander(flagValue, ctx.threadId);
          if ("error" in resolved) {
            return { exitCode: 1, stderr: resolved.error };
          }
          const report = await sitrep(resolved.commanderId);
          if ("error" in report) {
            return { exitCode: 1, stderr: report.error };
          }
          const rows = report.rows;
          if (json) {
            return {
              exitCode: 0,
              stdout: JSON.stringify(
                { commanderId: resolved.commanderId, crew: rows },
                null,
                2,
              ),
            };
          }
          if (rows.length === 0) {
            return {
              exitCode: 0,
              stdout: `No Crew under ${resolved.commanderId}.`,
            };
          }
          return { exitCode: 0, stdout: rows.map(formatSitrepRow).join("\n") };
        }
        if (sub === "settle") {
          if (rest.includes("--force-archive")) {
            return {
              exitCode: 1,
              stderr: "--force-archive: not supported in v1.",
            };
          }
          const threadId = rest.find((arg) => !arg.startsWith("-"));
          if (threadId === undefined) {
            return {
              exitCode: 1,
              stderr: `settle needs a thread id.\n${USAGE}`,
            };
          }
          return await settle(threadId);
        }
        if (sub === "publish") {
          const parsed = parseSnapshot(rest);
          if ("error" in parsed) return { exitCode: 1, stderr: parsed.error };
          return { exitCode: 0, stdout: publish(parsed.snapshot) };
        }
        return { exitCode: 1, stderr: `Unknown subcommand "${sub}".\n${USAGE}` };
      } catch (error) {
        // A thrown SDK error can be multi-line; a CLI failure is one line.
        return { exitCode: 1, stderr: shorten(describe(error), 200) };
      }
    },
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
