// The manifest requires a backend entry. This plugin has no backend logic.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");
}
