import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function iosStatusBar(bb: BbPluginApi) {
  bb.log.info("iOS status bar loaded");
}
