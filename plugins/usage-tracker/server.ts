import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { loadUsageSnapshot } from "./lib/load-usage.ts";
import { loadCodexResetCredits } from "./lib/codex-reset-credits.ts";
import {
  enabledSidebarProviderIds,
  SIDEBAR_PROVIDER_IDS,
} from "./lib/preferences.ts";
import { normalizeUsage, PROVIDER_IDS } from "./lib/usage.ts";
import {
  CliproxyError,
  loadCliproxyCredentials,
  normalizeBaseUrl,
  toRawUsage,
} from "./lib/cliproxy.ts";

const credentialSchema = z
  .object({
    provider: z.string(),
    account: z.string(),
    status: z.string(),
    statusMessage: z.string(),
    disabled: z.boolean(),
    planLabel: z.string().nullable(),
    success: z.number().nullable(),
    failed: z.number().nullable(),
    cooldowns: z.number(),
    recent: z.array(
      z
        .object({ time: z.string(), success: z.number(), failed: z.number() })
        .strict(),
    ),
  })
  .strict();

const costSchema = z
  .object({
    usedUsdCents: z.number().finite(),
    limitUsdCents: z.number().finite(),
  })
  .strict();

const usageWindowSchema = z
  .object({
    label: z.string(),
    usedPercent: z.number().finite(),
    barPercent: z.number().finite().min(0).max(100),
    resetsAt: z.string().nullable(),
    cost: costSchema.nullable(),
  })
  .strict();

const providerSchema = z
  .object({
    id: z.enum(PROVIDER_IDS),
    name: z.string(),
    status: z.enum([
      "ok",
      "not_installed",
      "unauthenticated",
      "expired",
      "error",
    ]),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
    message: z.string().nullable(),
    windows: z.array(usageWindowSchema),
    resetCreditsAvailable: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const usageRpcContract = defineRpcContract({
  getPreferences: {
    input: z.null(),
    output: z
      .object({
        enabledProviderIds: z.array(z.enum(SIDEBAR_PROVIDER_IDS)),
        cliproxyConfigured: z.boolean(),
      })
      .strict(),
  },
  getCliproxy: {
    input: z.null(),
    output: z
      .object({
        message: z.string().nullable(),
        credentials: z.array(credentialSchema),
      })
      .strict(),
  },
  getUsage: {
    input: z
      .object({ threadId: z.string().trim().min(1).nullable() })
      .strict(),
    output: z
      .object({
        fetchedAt: z.string(),
        host: z
          .object({
            id: z.string().nullable(),
            name: z.string().nullable(),
          })
          .strict(),
        providers: z.array(providerSchema),
      })
      .strict(),
  },
});

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enableClaudeCode: {
      type: "boolean",
      label: "Enable Claude Code",
      description: "Show Claude Code usage in the sidebar footer.",
      default: true,
    },
    enableCodex: {
      type: "boolean",
      label: "Enable Codex",
      description: "Show Codex usage in the sidebar footer.",
      default: true,
    },
    usageSource: {
      type: "select",
      label: "Usage source",
      description:
        "Where Claude and Codex usage comes from. CLIProxyAPI needs the URL and management key below.",
      options: ["BB", "CLIProxyAPI"],
      default: "BB",
    },
    cliproxyUrl: {
      type: "string",
      label: "CLIProxyAPI URL",
      description:
        "Base URL of CLIProxyAPI, for example https://host.tailnet.ts.net:8317. Adds a CLIProxyAPI tab.",
      default: "",
    },
    cliproxyManagementKey: {
      type: "string",
      label: "CLIProxyAPI management key",
      description: "Management key for the /v0/management API. Stored as a secret.",
      secret: true,
      default: "",
    },
  });

  async function cliproxyConfig() {
    const values = await settings.get();
    const baseUrl = normalizeBaseUrl(values.cliproxyUrl);
    const managementKey = values.cliproxyManagementKey.trim();
    return baseUrl === null || managementKey === ""
      ? null
      : { baseUrl, managementKey };
  }

  bb.rpc.register(usageRpcContract, {
    async getPreferences() {
      return {
        enabledProviderIds: enabledSidebarProviderIds(await settings.get()),
        cliproxyConfigured: (await cliproxyConfig()) !== null,
      };
    },
    async getCliproxy() {
      const config = await cliproxyConfig();
      if (config === null) {
        return {
          message: "Set the CLIProxyAPI URL and management key in the plugin settings.",
          credentials: [],
        };
      }
      try {
        const credentials = await loadCliproxyCredentials(config);
        return {
          message: null,
          credentials: credentials.map(({ windows: _windows, ...rest }) => rest),
        };
      } catch (error) {
        return {
          message:
            error instanceof CliproxyError ? error.message : "CLIProxyAPI failed.",
          credentials: [],
        };
      }
    },
    async getUsage({ threadId }) {
      const values = await settings.get();
      const config = await cliproxyConfig();
      if (values.usageSource === "CLIProxyAPI" && config !== null) {
        const now = new Date();
        let response;
        try {
          const credentials = await loadCliproxyCredentials(config, fetch, now);
          response = {
            claudeCode: toRawUsage(credentials, "claude"),
            codex: toRawUsage(credentials, "codex"),
          };
        } catch (error) {
          const failure = {
            status: "error" as const,
            message:
              error instanceof CliproxyError ? error.message : "CLIProxyAPI failed.",
          };
          response = { claudeCode: failure, codex: failure };
        }
        return normalizeUsage(response, { id: null, name: "CLIProxyAPI" }, now);
      }
      return loadUsageSnapshot(
        bb.sdk,
        threadId,
        new Date(),
        loadCodexResetCredits,
      );
    },
  });
}
