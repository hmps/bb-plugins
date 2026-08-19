// bb-plugin-hook-spike — probes which SDK hooks work inside a React root
// created by a content script (outside the host React tree).
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  report: {
    input: z.object({ lines: z.array(z.string()) }),
    output: z.object({ ok: z.boolean() }),
  },
  ping: {
    input: z.null(),
    output: z.object({ pong: z.boolean() }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");
  bb.rpc.register(rpcContract, {
    report: ({ lines }) => {
      for (const line of lines) bb.log.info(`probe: ${line}`);
      return { ok: true };
    },
    ping: () => ({ pong: true }),
  });
}
