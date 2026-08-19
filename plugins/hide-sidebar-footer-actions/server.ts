import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function hideSidebarFooterActions(bb: BbPluginApi) {
  bb.log.info("Hide sidebar footer actions loaded");
}
