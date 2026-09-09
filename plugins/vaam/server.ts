// bb-plugin-vaam — the backend.
//
// One section for now: a Beads viewer. The `bd` CLI owns the data; this
// server runs it in the beads root, trims the JSON to what the panel needs,
// and caches the list for a few seconds so tree expansion and filtering never
// re-run the process. "Assign agent" is the write path: the frontend's
// `experimental_NewThreadComposer` resolves every execution selection and
// this server forwards that request verbatim to `threads.spawn`.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Where the vaam monorepo's beads database lives, unless a setting says otherwise. */
export const DEFAULT_BEADS_ROOT = "/Users/hmps/dev/vaam/monorepo/vaam-main";

/**
 * How long a `bd list` result counts as fresh. A stale result is still served
 * at once; the refresh runs in the background, so the panel never waits on a
 * `bd` process after the first load. `bd` starts an embedded database on
 * every run and takes 2-8 s, sometimes far longer under lock contention.
 */
const LIST_CACHE_MS = 30_000;
const BD_TIMEOUT_MS = 30_000;
const BD_MAX_BUFFER = 50 * 1024 * 1024;
/** How much of bd's stderr rides along in an error message. */
const STDERR_LIMIT = 2 * 1024;

/** A bead id as `bd` writes it: `vaam-27c`, `vaam-ohtb.3`. Nothing else reaches argv. */
const BEAD_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

const beadStatusSchema = z.enum([
  "open",
  "in_progress",
  "blocked",
  "deferred",
  "closed",
]);
const beadTypeSchema = z.enum([
  "epic",
  "feature",
  "task",
  "bug",
  "chore",
  "molecule",
  "decision",
  "spike",
]);

/** The trimmed row the tree renders. `bd`'s own JSON carries much more. */
const beadSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    description: z.string(),
    status: beadStatusSchema,
    priority: z.number().int(),
    issueType: beadTypeSchema,
    assignee: z.string().nullable(),
    labels: z.array(z.string()),
    parentId: z.string().nullable(),
    /** Ids this bead waits on — `dependencies` of type "blocks" only. */
    blockedBy: z.array(z.string()),
    createdAt: z.string(),
    updatedAt: z.string(),
    closedAt: z.string().nullable(),
  })
  .strict();
export type Bead = z.infer<typeof beadSchema>;

const beadDetailSchema = beadSchema
  .extend({
    design: z.string(),
    acceptanceCriteria: z.string(),
    notes: z.string(),
    dependencies: z.array(
      z.object({ dependsOnId: z.string(), type: z.string() }).strict(),
    ),
  })
  .strict();
export type BeadDetail = z.infer<typeof beadDetailSchema>;

/**
 * What `experimental_NewThreadComposer` submits. A loose object on purpose:
 * new host fields must ride through to `threads.spawn` untouched, and
 * `executionInputSources` above all — without that provenance the host drops
 * the provider/model the user picked and re-derives it from project defaults.
 */
const newThreadRequestSchema = z.looseObject({
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
  reasoningLevel: z.string().min(1),
  permissionMode: z.string().min(1),
  serviceTier: z.string().min(1).optional(),
  executionInputSources: z.record(z.string(), z.string()).optional(),
  environment: z.looseObject({ type: z.string().min(1) }),
  input: z.array(z.unknown()).min(1),
});
type NewThreadRequestInput = z.infer<typeof newThreadRequestSchema>;

const beadIdSchema = z.string().min(1).max(200).regex(BEAD_ID_PATTERN);

export const vaamRpcContract = defineRpcContract({
  /** Every bead, trimmed. `includeClosed` adds `--all` to the bd call. */
  listBeads: {
    input: z
      .object({
        includeClosed: z.boolean().optional(),
        /** Wait for a fresh `bd list` instead of serving a stale cache. */
        force: z.boolean().optional(),
      })
      .strict(),
    output: z
      .object({
        root: z.string(),
        projectId: z.string().nullable(),
        beads: z.array(beadSchema),
      })
      .strict(),
  },
  /** One bead with the long-form fields the detail pane shows. */
  getBead: {
    input: z.object({ id: beadIdSchema }).strict(),
    output: z.object({ bead: beadDetailSchema }).strict(),
  },
  /** The prompt and project that seed the "Assign agent" composer. */
  beadPrompt: {
    input: z.object({ id: beadIdSchema }).strict(),
    output: z
      .object({ projectId: z.string().nullable(), prompt: z.string().min(1) })
      .strict(),
  },
  /** Create the thread from the composer's resolved request. */
  spawnForBead: {
    input: z
      .object({ id: beadIdSchema, request: newThreadRequestSchema })
      .strict(),
    output: z.object({ threadId: z.string().min(1) }).strict(),
  },
});

/** How the plugin reaches `bd`. Injected in tests, execFile in production. */
export type BdRunner = (
  args: string[],
  options: { cwd: string },
) => Promise<string>;

export interface VaamPluginOptions {
  /** Overrides the execFile runner; tests pass a fake `bd`. */
  runBd?: BdRunner;
  /** Run `bd list` once at load so the first panel open hits the cache. Default true. */
  warmOnLoad?: boolean;
}

/** `~/dev/x` becomes `/Users/me/dev/x`. Anything else is returned unchanged. */
export function expandHome(value: string, home: string = homedir()): string {
  const trimmed = value.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return `${home}/${trimmed.slice(2)}`;
  return trimmed;
}

/**
 * Where `bd` usually lives when the bb server's PATH does not carry it. The
 * server is a launchd/daemon process, so mise shims and user bin dirs are
 * often missing from its PATH even though the shell finds them.
 */
export function bdCandidates(home: string = homedir()): string[] {
  return [
    join(home, ".local/share/mise/shims/bd"),
    join(home, ".local/bin/bd"),
    join(home, "go/bin/bd"),
    "/opt/homebrew/bin/bd",
    "/usr/local/bin/bd",
  ];
}

/**
 * The executable to run. A configured value with a slash is used as is. A bare
 * name is looked up on PATH, then in the usual install locations; when nothing
 * matches, the bare name is returned so execFile reports ENOENT with a clear
 * message.
 */
export function resolveBdPath(
  configured: string,
  options: {
    path?: string;
    home?: string;
    exists?: (file: string) => boolean;
  } = {},
): string {
  const name = expandHome(configured, options.home) || "bd";
  if (name.includes("/")) return name;
  const exists = options.exists ?? existsSync;
  const pathValue = options.path ?? process.env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (dir !== "" && exists(join(dir, name))) return join(dir, name);
  }
  if (name === "bd") {
    const found = bdCandidates(options.home).find((file) => exists(file));
    if (found !== undefined) return found;
  }
  return name;
}

function clamp(value: string, limit: number): string {
  const body = value.trim();
  return body.length <= limit ? body : `${body.slice(0, limit)} (truncated)`;
}

function defaultRunBd(file: string): BdRunner {
  return (args, { cwd }) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        file,
        args,
        { cwd, timeout: BD_TIMEOUT_MS, maxBuffer: BD_MAX_BUFFER },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve(stdout);
            return;
          }
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            reject(
              new Error(
                `bd was not found at "${file}". Install the beads CLI, or set the "Beads CLI path" setting to its absolute path.`,
              ),
            );
            return;
          }
          const detail = clamp(stderr, STDERR_LIMIT) || error.message;
          reject(new Error(`bd ${args.join(" ")} failed in ${cwd}: ${detail}`));
        },
      );
    });
}

// ---------------------------------------------------------------------------
// bd JSON to the trimmed shapes above. Every field is optional in bd's output:
// it omits empty strings, and `parent` is absent at the top level.
// ---------------------------------------------------------------------------

interface RawDependency {
  depends_on_id?: unknown;
  type?: unknown;
}

interface RawBead {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  design?: unknown;
  acceptance_criteria?: unknown;
  notes?: unknown;
  status?: unknown;
  priority?: unknown;
  issue_type?: unknown;
  assignee?: unknown;
  labels?: unknown;
  parent?: unknown;
  dependencies?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  closed_at?: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function rawDependencies(value: unknown): RawDependency[] {
  return Array.isArray(value) ? (value as RawDependency[]) : [];
}

/** One `bd` row, trimmed to the tree's fields. */
export function toBead(raw: RawBead): Bead {
  const id = text(raw.id);
  if (id === "") throw new Error("bd returned an issue with no id");
  const status = beadStatusSchema.safeParse(raw.status);
  const issueType = beadTypeSchema.safeParse(raw.issue_type);
  return {
    id,
    title: text(raw.title),
    description: text(raw.description),
    status: status.success ? status.data : "open",
    priority: typeof raw.priority === "number" && Number.isFinite(raw.priority)
      ? Math.trunc(raw.priority)
      : 2,
    issueType: issueType.success ? issueType.data : "task",
    assignee: optionalText(raw.assignee),
    labels: Array.isArray(raw.labels) ? raw.labels.map(text) : [],
    parentId: optionalText(raw.parent),
    blockedBy: rawDependencies(raw.dependencies)
      .filter((dependency) => dependency.type === "blocks")
      .map((dependency) => text(dependency.depends_on_id))
      .filter((dependsOnId) => dependsOnId !== ""),
    createdAt: text(raw.created_at),
    updatedAt: text(raw.updated_at),
    closedAt: optionalText(raw.closed_at),
  };
}

/** The same row plus the long-form fields only the detail pane reads. */
export function toBeadDetail(raw: RawBead): BeadDetail {
  return {
    ...toBead(raw),
    design: text(raw.design),
    acceptanceCriteria: text(raw.acceptance_criteria),
    notes: text(raw.notes),
    dependencies: rawDependencies(raw.dependencies)
      .map((dependency) => ({
        dependsOnId: text(dependency.depends_on_id),
        type: text(dependency.type),
      }))
      .filter((dependency) => dependency.dependsOnId !== ""),
  };
}

/** bd prints a JSON array for both `list` and `show`. */
export function parseBdArray(stdout: string): RawBead[] {
  const body = stdout.trim();
  if (body === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("bd did not return JSON. Check the beads root setting.");
  }
  if (!Array.isArray(parsed)) throw new Error("bd returned a non-array result");
  return parsed as RawBead[];
}

/** The prompt the "Assign agent" composer opens with. */
export function buildBeadPrompt(bead: BeadDetail): string {
  const criteria = bead.acceptanceCriteria.trim();
  return [
    `Work on bead ${bead.id}: ${bead.title}`,
    "",
    `Run \`bd show ${bead.id}\` for the full context. Follow the repo's AGENTS.md / CLAUDE.md conventions. When you start, run \`bd update ${bead.id} --status in_progress\`. When done, record what you did with \`bd update ${bead.id} --notes\` (or \`bd close ${bead.id}\` if the acceptance criteria are met) and report back.`,
    "",
    "Description:",
    bead.description.trim(),
    "",
    "Acceptance criteria:",
    criteria === "" ? "(none)" : criteria,
  ].join("\n");
}

/** The spawned thread's title. */
export function buildThreadTitle(id: string, title: string): string {
  const trimmed = title.trim();
  return trimmed === "" ? id : `${id}: ${trimmed}`;
}

interface BbProjectSummary {
  id: string;
  sources?: Array<{ path?: unknown }>;
}

interface SpawnedThreadSummary {
  id: string;
}

export default async function plugin(
  bb: BbPluginApi,
  options: VaamPluginOptions = {},
) {
  const settings = bb.settings.define({
    beadsRoot: {
      type: "string",
      label: "Beads root",
      default: DEFAULT_BEADS_ROOT,
    },
    bdPath: {
      type: "string",
      label: "Beads CLI path",
      default: "bd",
    },
  });

  async function resolveRoot(): Promise<string> {
    const { beadsRoot } = await settings.get();
    const root = expandHome(beadsRoot);
    if (root === "") throw new Error("The beads root setting is empty.");
    return root;
  }

  async function runBd(args: string[], cwd: string): Promise<string> {
    if (options.runBd !== undefined) return options.runBd(args, { cwd });
    const { bdPath } = await settings.get();
    return defaultRunBd(resolveBdPath(bdPath))(args, { cwd });
  }

  // --- the beads list, cached so the panel never waits on a bd process ------
  //
  // The cache keeps the full detail rows: `bd list --json` already carries
  // design, acceptance criteria, notes, and dependencies, so `getBead` and
  // `beadPrompt` read from here and skip a 2-8 s `bd show`.

  interface ListCacheEntry {
    fetchedAt: number;
    beads: BeadDetail[];
  }
  const listCache = new Map<string, ListCacheEntry>();
  const inFlight = new Map<string, Promise<BeadDetail[]>>();

  function cacheKey(root: string, includeClosed: boolean): string {
    return `${root} ${includeClosed ? "all" : "open"}`;
  }

  /** One `bd list` per key at a time; concurrent callers share the run. */
  function fetchBeads(root: string, includeClosed: boolean): Promise<BeadDetail[]> {
    const key = cacheKey(root, includeClosed);
    const pending = inFlight.get(key);
    if (pending !== undefined) return pending;
    const args = ["list", "--json", "-n", "0"];
    if (includeClosed) args.push("--all");
    const run = (async () => {
      const beads = parseBdArray(await runBd(args, root)).map(toBeadDetail);
      listCache.set(key, { fetchedAt: Date.now(), beads });
      return beads;
    })();
    inFlight.set(key, run);
    return run.finally(() => {
      if (inFlight.get(key) === run) inFlight.delete(key);
    });
  }

  async function loadBeads(
    includeClosed: boolean,
    force = false,
  ): Promise<{ root: string; beads: BeadDetail[] }> {
    const root = await resolveRoot();
    const cached = listCache.get(cacheKey(root, includeClosed));
    if (cached !== undefined && !force) {
      if (Date.now() - cached.fetchedAt >= LIST_CACHE_MS) {
        // Stale: hand back what we have and refresh behind it.
        fetchBeads(root, includeClosed).catch((error: unknown) => {
          bb.log.warn(
            `background bd list failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
      return { root, beads: cached.beads };
    }
    return { root, beads: await fetchBeads(root, includeClosed) };
  }

  /** The tree's trimmed row. */
  function toListRow(bead: BeadDetail): Bead {
    const { design, acceptanceCriteria, notes, dependencies, ...row } = bead;
    void design;
    void acceptanceCriteria;
    void notes;
    void dependencies;
    return row;
  }

  async function loadBead(id: string): Promise<BeadDetail> {
    if (!BEAD_ID_PATTERN.test(id)) throw new Error(`invalid bead id: ${id}`);
    const root = await resolveRoot();
    for (const includeClosed of [false, true]) {
      const cached = listCache.get(cacheKey(root, includeClosed));
      const hit = cached?.beads.find((bead) => bead.id === id);
      if (hit !== undefined) return hit;
    }
    const rows = parseBdArray(await runBd(["show", id, "--json"], root));
    const raw = rows[0];
    if (raw === undefined) throw new Error(`no bead with id ${id}`);
    return toBeadDetail(raw);
  }

  // --- the bb project that holds the beads root ----------------------------

  let projectCache: { root: string; projectId: string | null } | null = null;

  async function resolveProjectId(root: string): Promise<string | null> {
    if (projectCache !== null && projectCache.root === root) {
      return projectCache.projectId;
    }
    let projectId: string | null = null;
    try {
      const projects = (await bb.sdk.projects.list()) as BbProjectSummary[];
      const match = projects.find((project) =>
        (project.sources ?? []).some((source) => source.path === root),
      );
      projectId = match?.id ?? null;
    } catch (error: unknown) {
      bb.log.warn(
        `could not resolve the beads project: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    projectCache = { root, projectId };
    return projectId;
  }

  bb.rpc.register(vaamRpcContract, {
    async listBeads({ includeClosed, force }) {
      const { root, beads } = await loadBeads(
        includeClosed === true,
        force === true,
      );
      return {
        root,
        projectId: await resolveProjectId(root),
        beads: beads.map(toListRow),
      };
    },
    async getBead({ id }) {
      return { bead: await loadBead(id) };
    },
    async beadPrompt({ id }) {
      const bead = await loadBead(id);
      return {
        projectId: await resolveProjectId(await resolveRoot()),
        prompt: buildBeadPrompt(bead),
      };
    },
    async spawnForBead({ id, request }) {
      const bead = await loadBead(id);
      const thread = (await bb.sdk.threads.spawn({
        ...(request as NewThreadRequestInput),
        title: buildThreadTitle(id, bead.title),
      } as unknown as Parameters<
        typeof bb.sdk.threads.spawn
      >[0])) as unknown as SpawnedThreadSummary;
      bb.log.info(`spawned thread ${thread.id} for bead ${id}`);
      return { threadId: thread.id };
    },
  });

  settings.onChange(() => {
    listCache.clear();
    projectCache = null;
  });

  if (options.warmOnLoad !== false) {
    loadBeads(false).catch((error: unknown) => {
      bb.log.warn(
        `warm-up bd list failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  bb.log.info("loaded");
}
