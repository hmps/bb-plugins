// bb-plugin-command-palette — the backend the palette rows act through.
//
// It owns no state and reads no lists: bb's own quick palette finds the thread,
// and these methods only act on it. The settled / snoozed lifecycle belongs to
// the t3sidebar plugin and is reached by cross-plugin RPC. When that plugin is
// absent or disabled, `lifecycleAvailable` reports false and the frontend hides
// the rows that depend on it.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const LIFECYCLE_PLUGIN_ID = "t3sidebar";

/**
 * The t3sidebar contract, redeclared minimally.
 *
 * Importing from that plugin would couple two independently installable
 * packages; a local schema keeps the dependency to the wire shape alone.
 */
const lifecycleListSchema = z.object({ rows: z.array(z.unknown()) });
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
const lifecycleActionNames = [
  "settle",
  "settleAndArchive",
  "unsettle",
  "unsnooze",
] as const;

const threadActionNames = [...bbActionNames, ...lifecycleActionNames] as const;

type BbActionName = (typeof bbActionNames)[number];
export type ThreadActionName = (typeof threadActionNames)[number];

const isLifecycleAction = (action: ThreadActionName): boolean =>
  (lifecycleActionNames as readonly string[]).includes(action);

export const rpcContract = defineRpcContract({
  lifecycleAvailable: {
    input: z.null(),
    output: z.object({ available: z.boolean() }),
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
    /** Probe the owning plugin with its cheapest read. */
    async lifecycleAvailable() {
      try {
        await bb.sdk.plugins.callRpc({
          pluginId: LIFECYCLE_PLUGIN_ID,
          method: "listLifecycle",
          input: {},
          outputSchema: lifecycleListSchema,
        });
        return { available: true };
      } catch (error) {
        bb.log.debug(`lifecycle unavailable: ${(error as Error).message}`);
        return { available: false };
      }
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
