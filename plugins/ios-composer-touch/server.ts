// bb-plugin-ios-composer-touch — backend entry.
//
// This plugin is frontend-only (see app.tsx). The backend factory exists
// because bb requires one; it registers nothing.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");
}
