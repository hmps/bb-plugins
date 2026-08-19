// bb-plugin-hook-spike — navigation probes from a content-script React root.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  report: {
    input: z.object({ lines: z.array(z.string()) }),
    output: z.object({ ok: z.boolean() }),
  },
  newestThread: {
    input: z.null(),
    output: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      title: z.string().nullable(),
    }),
  },
  openThread: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ result: z.string() }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");
  bb.rpc.register(rpcContract, {
    report: ({ lines }) => {
      for (const line of lines) bb.log.info(`probe: ${line}`);
      return { ok: true };
    },
    newestThread: async () => {
      const threads = await bb.sdk.threads.list({ limit: 1 });
      const t = threads[0];
      return t
        ? { threadId: t.id, projectId: t.projectId ?? null, title: t.title ?? null }
        : { threadId: null, projectId: null, title: null };
    },
    openThread: async ({ threadId }) => {
      const r = await bb.sdk.threads.open({ threadId, file: null });
      return { result: JSON.stringify(r) };
    },
  });
}
