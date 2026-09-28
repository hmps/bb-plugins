import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function mobileFixes(bb: BbPluginApi) {
  bb.log.info("Mobile fixes loaded");
}
