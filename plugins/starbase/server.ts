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
import { createHash } from "node:crypto";
import type {
  BbPluginApi,
  PluginThreadEventPayloads,
} from "@get-bb/plugin-sdk";

/**
 * The SDK does not export the pending-interaction DTO by name, so the event
 * payload it arrives on is the type of record.
 */
type PendingInteraction =
  PluginThreadEventPayloads["interaction.pending"]["interaction"];

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

/** Rows per `threads.list` page. Paging stops on the first short page. */
const LIST_PAGE_SIZE = 100;

/** A cap on pages per parent, so a list that never shortens cannot spin. */
const LIST_MAX_PAGES = 50;

/** The refusal when the descendant set could not be shown to be complete. */
const ENUMERATION_FAILED = "settle: could not enumerate all descendants";

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
        // The Commander started a turn between the read and the send.
        bb.log.info(
          `starbase: start refused on ${commanderId}, queueing instead: ${shorten(describe(error), 120)}`,
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
  async function listChildren(
    parentThreadId: string,
  ): Promise<ThreadListRow[] | null> {
    const rows: ThreadListRow[] = [];
    for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
      const batch = await bb.sdk.threads.list({
        parentThreadId,
        archived: false,
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

    // Archive the checked ids one by one rather than calling `archiveAll`.
    // `archiveAll` decides its own tree, and nothing in the SDK reports that
    // tree or offers a dry run, so it could take a thread this never checked.
    // Deepest first, so a thread is archived after its own descendants.
    const archived = new Set<string>();
    for (const memberId of [...tree.threadIds].reverse()) {
      const result = await bb.sdk.threads.archive({ threadId: memberId });
      for (const id of result.archivedThreadIds) archived.add(id);
    }

    recordEvent({
      dedupeKey: `settled:${threadId}:${Date.now()}`,
      threadId,
      commanderId: thread.parentThreadId,
      kind: "settled",
      summary: `archived ${archived.size} thread(s)`,
    });

    // A belt-and-braces check on the assumption above. If bb archived a thread
    // outside the checked set, say so instead of reporting a clean settle.
    const unchecked = [...archived].filter((id) => !checked.has(id));
    if (unchecked.length > 0) {
      return {
        exitCode: 1,
        stderr: `Settled ${threadId}, but bb also archived ${unchecked.length} unchecked thread(s): ${unchecked.slice(0, 5).join(", ")}.`,
      };
    }
    return {
      exitCode: 0,
      stdout: `Settled ${threadId}: archived ${archived.size} thread(s).`,
    };
  }

  bb.cli.register({
    name: "starbase",
    summary: "Report and settle the Crew threads under a Commander",
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
