// bb-plugin-starbase backend — the Sentinel.
//
// Starbase is an orchestration model: the Governor talks to one Commander
// thread per project, and the Commander dispatches Crew threads into the
// target projects. bb already pushes a child's completion message to its
// parent, so a completed Crew needs no help from a plugin.
//
// The Sentinel fills the two gaps that push does not cover. A Crew thread that
// raises a hand or fails is invisible to the Commander until somebody looks,
// so this plugin relays both as one line each. It also owns `bb starbase
// settle`, a guarded archive that refuses to file away work that is still on
// the worktree or still in review.
//
// Every relay is written to the plugin's own SQLite database first. The insert
// carries a unique dedupe key, so a repeated event relays exactly once even
// when bb replays it after a reload.
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

const COMMANDER_PROJECTS_SETTING = "commanderProjectIds";

/** The Starbase project the first Commander runs in. */
const DEFAULT_COMMANDER_PROJECT_IDS = "proj_s9vk5k4c9u";

/** How much of an interaction prompt or an error a relay line carries. */
const SUMMARY_MAX_CHARS = 160;

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

/** Render one SITREP row. The CLI and the tests share this format. */
export function formatSitrepRow(row: SitrepRow): string {
  return [
    row.threadId,
    row.title,
    row.status,
    `pr:${row.pr}`,
    `worktree:${row.worktree}`,
    `interactions:${row.interactions}`,
    `last:${row.last}`,
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
   * The Commander a thread reports to, or null when the thread is not Crew.
   *
   * A thread is Crew when its parent runs in a Commander project. A Commander
   * is never its own Crew, so a thread that already runs in a Commander
   * project is excluded — that is what keeps a Commander's own idle and its
   * own raised hands off the relay.
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
    if (commanderProjects.has(thread.projectId)) return null;
    const parent = await bb.sdk.threads.get({ threadId: parentThreadId });
    if (!commanderProjects.has(parent.projectId)) return null;
    return parent.id;
  }

  async function relay(commanderId: string, text: string): Promise<void> {
    await bb.sdk.threads.send({
      threadId: commanderId,
      mode: "auto",
      input: [{ type: "text", text, mentions: [] }],
    });
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
      const fresh = recordEvent({
        dedupeKey: `interaction:${thread.id}:${interaction.id}`,
        threadId: thread.id,
        commanderId,
        kind: `interaction/${kind}`,
        summary,
      });
      if (!fresh) return;
      await relay(commanderId, line);
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
      // A failure carries no id of its own, so the transition time is the key.
      const fresh = recordEvent({
        dedupeKey: `failed:${thread.id}:${thread.updatedAt}`,
        threadId: thread.id,
        commanderId,
        kind: "failed",
        summary,
      });
      if (!fresh) return;
      await relay(commanderId, line);
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

  /** "clean", "dirty", or "n/a" when git cannot answer. */
  async function worktreeState(environmentId: string | null): Promise<string> {
    if (environmentId === null) return "n/a";
    const status = await bb.sdk.environments.status({ environmentId });
    if (status.outcome !== "available") return "n/a";
    return status.workspace.workingTree.hasUncommittedChanges
      ? "dirty"
      : "clean";
  }

  /** "none", or the pull request URL and its state. */
  async function pullRequestState(
    environmentId: string | null,
  ): Promise<{ label: string; open: boolean }> {
    if (environmentId === null) return { label: "none", open: false };
    const result = await bb.sdk.environments.pullRequest({ environmentId });
    if (result.outcome !== "available") return { label: "none", open: false };
    const pr = result.pullRequest;
    return {
      label: `${pr.url} ${pr.state}`,
      open: pr.state === "open" || pr.state === "draft",
    };
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

  async function sitrep(commanderId: string): Promise<SitrepRow[]> {
    // Live Crew only. An archived thread has already been settled.
    const children = await bb.sdk.threads.list({
      parentThreadId: commanderId,
      archived: false,
    });
    const rows: SitrepRow[] = [];
    for (const child of children) {
      const [worktree, pr, interactions] = await Promise.all([
        worktreeState(child.environmentId),
        pullRequestState(child.environmentId),
        pendingInteractionCount(child.id, child.hasPendingInteraction),
      ]);
      const event = lastEvent(child.id);
      rows.push({
        threadId: child.id,
        title: child.title ?? child.titleFallback ?? "untitled",
        status: child.status,
        pr: pr.label,
        worktree,
        interactions,
        last: event === null ? "none" : event.kind,
      });
    }
    return rows;
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
    if (!commanderProjects.has(thread.projectId)) {
      return {
        error: `Thread ${candidate} is not a Commander: project ${thread.projectId} is not in ${COMMANDER_PROJECTS_SETTING}.`,
      };
    }
    return { commanderId: thread.id };
  }

  async function settle(threadId: string): Promise<{
    exitCode: number;
    stdout?: string;
    stderr?: string;
  }> {
    const thread = await bb.sdk.threads.get({ threadId });
    const environmentId = thread.environmentId;
    const worktree = await worktreeState(environmentId);
    if (worktree === "dirty") {
      return {
        exitCode: 1,
        stderr: `Refused: ${threadId} has uncommitted changes on its worktree.`,
      };
    }
    const pr = await pullRequestState(environmentId);
    if (pr.open) {
      return {
        exitCode: 1,
        stderr: `Refused: ${threadId} still has an open pull request (${pr.label}).`,
      };
    }
    const result = await bb.sdk.threads.archiveAll({ threadId });
    recordEvent({
      dedupeKey: `settled:${threadId}:${Date.now()}`,
      threadId,
      commanderId: thread.parentThreadId,
      kind: "settled",
      summary: `archived ${result.archivedThreadIds.length} thread(s)`,
    });
    return {
      exitCode: 0,
      stdout: `Settled ${threadId}: archived ${result.archivedThreadIds.length} thread(s).`,
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
          const rows = await sitrep(resolved.commanderId);
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
        return { exitCode: 1, stderr: describe(error) };
      }
    },
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
