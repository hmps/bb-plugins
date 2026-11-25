// bb-plugin-inbox backend. Stub: the backend packet fills this in.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("inbox loaded");
}
