// bb-plugin-command-palette — the backend the ⌘K palette reads and acts through.
//
// It owns no state. Threads and projects come from bb; the settled / snoozed
// lifecycle belongs to the t3sidebar plugin and is reached by cross-plugin RPC.
// When that plugin is absent or disabled, the palette degrades: `listThreads`
// reports `lifecycleAvailable: false` and the frontend hides those actions.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { toPaletteThreads, type LifecycleRow, type SourceThread } from "./lib/threads";

/** How many threads the palette loads. Enough to search, small enough to be fast. */
const THREAD_LIMIT = 200;

const LIFECYCLE_PLUGIN_ID = "t3sidebar";

/**
 * The t3sidebar contract, redeclared minimally.
 *
 * Importing from that plugin would couple two independently installable
 * packages; a local schema keeps the dependency to the wire shape alone.
 */
const lifecycleListSchema = z.object({
  rows: z.array(
    z.object({
      threadId: z.string(),
      settledAt: z.number().nullable(),
      snoozedUntil: z.number().nullable(),
      snoozedAt: z.number().nullable(),
    }),
  ),
});
const lifecycleOkSchema = z.object({ ok: z.boolean() });

/** Actions bb's own thread API performs, named exactly as its methods. */
const bbActionNames = [
  "pin",
  "unpin",
  "archive",
  "markRead",
  "markUnread",
] as const;

/** Actions the t3sidebar plugin owns, named exactly as its RPC methods. */
const lifecycleActionNames = ["settle", "unsettle", "unsnooze"] as const;

const threadActionNames = [...bbActionNames, ...lifecycleActionNames] as const;

type BbActionName = (typeof bbActionNames)[number];
export type ThreadActionName = (typeof threadActionNames)[number];

const isLifecycleAction = (action: ThreadActionName): boolean =>
  (lifecycleActionNames as readonly string[]).includes(action);

export const rpcContract = defineRpcContract({
  listThreads: {
    input: z.null(),
    output: z.object({
      lifecycleAvailable: z.boolean(),
      threads: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          projectId: z.string(),
          projectName: z.string(),
          updatedAt: z.number(),
          isPinned: z.boolean(),
          isUnread: z.boolean(),
          settled: z.boolean(),
          snoozedUntil: z.number().nullable(),
        }),
      ),
    }),
  },
  listProjects: {
    input: z.null(),
    output: z.object({
      projects: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  },
  threadAction: {
    input: z.object({
      threadId: z.string().trim().min(1),
      action: z.enum(threadActionNames),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
  snooze: {
    input: z.object({
      threadId: z.string().trim().min(1),
      snoozedUntil: z.number().int().positive(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
});

export default function plugin(bb: BbPluginApi) {
  /** Lifecycle rows, or null when the owning plugin is not there. */
  const readLifecycle = async (): Promise<LifecycleRow[] | null> => {
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: LIFECYCLE_PLUGIN_ID,
        method: "listLifecycle",
        input: {},
        outputSchema: lifecycleListSchema,
      });
      return result.rows;
    } catch (error) {
      bb.log.debug(`lifecycle unavailable: ${(error as Error).message}`);
      return null;
    }
  };

  const callLifecycle = async (
    method: string,
    input: Record<string, string | number>,
  ): Promise<{ ok: boolean }> =>
    await bb.sdk.plugins.callRpc({
      pluginId: LIFECYCLE_PLUGIN_ID,
      method,
      input,
      outputSchema: lifecycleOkSchema,
    });

  bb.rpc.register(rpcContract, {
    async listThreads() {
      const [threads, projects, lifecycle] = await Promise.all([
        bb.sdk.threads.list({ limit: THREAD_LIMIT }),
        bb.sdk.projects.list({ includePersonal: true }),
        readLifecycle(),
      ]);
      const projectNames = new Map(
        projects.map((project) => [project.id, project.name]),
      );
      return {
        lifecycleAvailable: lifecycle !== null,
        threads: toPaletteThreads(
          threads as unknown as SourceThread[],
          projectNames,
          lifecycle ?? [],
        ),
      };
    },

    async listProjects() {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return {
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
        })),
      };
    },

    async threadAction({ threadId, action }) {
      if (isLifecycleAction(action)) {
        await callLifecycle(action, { threadId });
        return { ok: true as const };
      }
      await bb.sdk.threads[action as BbActionName]({ threadId });
      return { ok: true as const };
    },

    async snooze({ threadId, snoozedUntil }) {
      return await callLifecycle("snooze", { threadId, snoozedUntil });
    },
  });
}
