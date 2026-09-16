import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { UsageDisclosure } from "@/lib/usage-disclosure";
import "./app.css";

export default definePluginApp((app) => {
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "usage",
    label: "Provider usage",
    icon: "ChartColumn",
    component: UsageDisclosure,
  });
});
