import { describe, expect, it } from "vitest";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { invalidAllowlistKeys, parseAllowlist } from "./allowlist";
import {
  buildCatalog,
  filterCatalog,
  routingForNewThread,
  selectionOutcome,
  type CatalogEntry,
} from "./catalog";
import { splitFavorites, toggleFavorite } from "./favorites";
import { reasoningChoices, reasoningLabel, reasoningOutcome } from "./reasoning";

type ModelsResult = Awaited<ReturnType<PluginBrowserBbSdk["providers"]["models"]>>;
type Provider = ModelsResult["providers"][number];

function provider(id: string): Provider {
  return { id, displayName: id.toUpperCase(), available: true } as Provider;
}

function models(ids: string[], extra: Partial<ModelsResult> = {}): ModelsResult {
  return {
    modelLoadError: null,
    models: ids.map((model) => ({ model, displayName: model.toUpperCase() })),
    selectedOnlyModels: [],
    ...extra,
  } as ModelsResult;
}

function entry(providerId: string, model: string): CatalogEntry {
  return {
    key: `${providerId}/${model}`,
    providerId,
    providerName: providerId,
    model,
    displayName: model,
    reasoningEfforts: [],
    defaultReasoning: "medium",
  };
}

describe("allowlist", () => {
  it("parses lines and commas, drops comments, blanks, and duplicates", () => {
    expect(
      parseAllowlist("# mine\nclaude-code/opus, codex/gpt\n\n claude-code/opus # again\n"),
    ).toEqual(["claude-code/opus", "codex/gpt"]);
    expect(parseAllowlist(undefined)).toEqual([]);
  });

  it("flags keys that are not provider/model", () => {
    expect(invalidAllowlistKeys(["claude-code/opus", "opus", "/x", "a/"])).toEqual([
      "opus",
      "/x",
      "a/",
    ]);
  });
});

describe("filterCatalog", () => {
  const entries = [entry("a", "1"), entry("b", "2"), entry("b", "3")];

  it("keeps every model when the allowlist is empty", () => {
    expect(filterCatalog(entries, [])).toEqual({ entries, unmatched: [] });
  });

  it("keeps allowlist order and reports keys with no catalog model", () => {
    const result = filterCatalog(entries, ["b/3", "missing/x", "a/1"]);
    expect(result.entries.map((e) => e.key)).toEqual(["b/3", "a/1"]);
    expect(result.unmatched).toEqual(["missing/x"]);
  });
});

describe("routingForNewThread", () => {
  it("routes like the native new-thread picker", () => {
    expect(routingForNewThread(undefined)).toEqual({});
    expect(routingForNewThread({ type: "project-default" })).toEqual({});
    expect(routingForNewThread({ type: "reuse", environmentId: "env1" })).toEqual({
      environmentId: "env1",
    });
    expect(
      routingForNewThread({ type: "host", hostId: "h1", workspace: { type: "personal" } }),
    ).toEqual({ hostId: "h1" });
    expect(
      routingForNewThread({
        type: "provider",
        environmentProviderId: "p",
        inputs: null,
        machine: { type: "existing", hostId: "h2" },
      }),
    ).toEqual({ hostId: "h2" });
    expect(
      routingForNewThread({
        type: "provider",
        environmentProviderId: "p",
        inputs: null,
        machine: { type: "new", machineProviderId: "m", inputs: null },
      }),
    ).toEqual({});
  });
});

describe("buildCatalog", () => {
  it("removes the GPT prefix only for Codex and preserves model identifiers", () => {
    const model = { model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol" };
    const result = models([], {
      models: [model] as ModelsResult["models"],
      selectedOnlyModels: [model] as ModelsResult["selectedOnlyModels"],
    });
    const catalog = buildCatalog(
      [provider("codex"), provider("pi")],
      [
        { status: "fulfilled", value: result },
        { status: "fulfilled", value: result },
      ],
    );
    for (const entries of [catalog.entries, catalog.selectedOnly]) {
      expect(entries.map((entry) => [entry.key, entry.model, entry.displayName])).toEqual([
        ["codex/gpt-6.1-sol", "gpt-6.1-sol", "6.1-Sol"],
        ["pi/gpt-6.1-sol", "gpt-6.1-sol", "GPT-6.1-Sol"],
      ]);
    }
  });

  it("turns failed and erroring providers into errors and keeps the rest", () => {
    const catalog = buildCatalog(
      [provider("a"), provider("b"), provider("c")],
      [
        { status: "fulfilled", value: models(["1"]) },
        { status: "rejected", reason: new Error("offline") },
        {
          status: "fulfilled",
          value: models([], {
            modelLoadError: { code: "auth_required", detail: null, providerId: "c" },
          }),
        },
      ],
    );
    expect(catalog.entries.map((e) => [e.key, e.displayName])).toEqual([["a/1", "1"]]);
    expect(catalog.errors).toEqual([
      { providerId: "b", providerName: "B", message: "offline" },
      { providerId: "c", providerName: "C", message: "auth_required" },
    ]);
  });
});

describe("selectionOutcome", () => {
  const requested = { providerId: "a", model: "1" };

  it("counts only an exact match as success", () => {
    expect(selectionOutcome(requested, { providerId: "a", model: "1" })).toEqual({
      kind: "applied",
    });
  });

  it("reports an ignored provider and a reconciled model as failures", () => {
    expect(selectionOutcome(requested, { providerId: "b", model: "9" }).kind).toBe(
      "provider-ignored",
    );
    expect(selectionOutcome(requested, { providerId: "a", model: "2" }).kind).toBe(
      "model-reconciled",
    );
  });
});

describe("buildCatalog reasoning and provider data", () => {
  it("keeps the catalog efforts, the default, the icon data, and the labels", () => {
    const catalog = buildCatalog(
      [
        {
          ...provider("a"),
          logoUrl: "https://example.test/a.svg",
          icon: { glyph: "Bot" },
          strings: { iconTint: { dark: "#fff", light: "#000" } },
          reasoningLevels: [{ id: "xhigh", label: "Very high" }],
        } as Provider,
      ],
      [
        {
          status: "fulfilled",
          value: {
            modelLoadError: null,
            models: [
              {
                model: "1",
                displayName: "One",
                defaultReasoningEffort: "high",
                supportedReasoningEfforts: [
                  { reasoningEffort: "low", description: "Fast" },
                  { reasoningEffort: "high", description: "Deep" },
                ],
              },
            ],
            selectedOnlyModels: [],
          } as unknown as ModelsResult,
        },
      ],
    );
    expect(catalog.entries[0]).toMatchObject({
      reasoningEfforts: [
        { level: "low", description: "Fast" },
        { level: "high", description: "Deep" },
      ],
      defaultReasoning: "high",
    });
    expect(catalog.providers.a).toEqual({
      id: "a",
      name: "A",
      icon: {
        id: "a",
        logoUrl: "https://example.test/a.svg",
        icon: { glyph: "Bot" },
        strings: { iconTint: { dark: "#fff", light: "#000" } },
      },
      reasoningLabels: { xhigh: "Very high" },
    });
  });
});

describe("reasoning", () => {
  const efforts = (...levels: string[]) =>
    levels.map((level) => ({ level, description: "" })) as CatalogEntry["reasoningEfforts"];

  it("offers catalog efforts in order and never max, ultra, or ultracode", () => {
    const model = { ...entry("a", "1"), reasoningEfforts: efforts("low", "high", "max", "ultra", "ultracode") };
    expect(reasoningChoices(model).map((effort) => effort.level)).toEqual(["low", "high"]);
    expect(reasoningChoices(undefined)).toEqual([]);
  });

  it("labels a level like the native picker", () => {
    const provider = { id: "a", name: "A", icon: { id: "a" }, reasoningLabels: { high: "Deep" } };
    expect(reasoningLabel("high", provider)).toBe("Deep");
    expect(reasoningLabel("xhigh", provider)).toBe("Extra High");
    expect(reasoningLabel("custom")).toBe("custom");
  });

  it("counts only the requested level on the same model as success", () => {
    const requested = { providerId: "a", model: "1", reasoningLevel: "high" };
    expect(reasoningOutcome(requested, { reasoningLevel: "high" }).kind).toBe("applied");
    expect(
      reasoningOutcome(requested, { providerId: "a", model: "1", reasoningLevel: "medium" }).kind,
    ).toBe("reconciled");
    expect(
      reasoningOutcome(requested, { providerId: "a", model: "2", reasoningLevel: "high" }).kind,
    ).toBe("model-changed");
  });
});

describe("favorites", () => {
  const entries = [entry("a", "1"), entry("b", "2"), entry("a", "3"), entry("b", "4")];

  it("puts favorites first in favorite order and keeps the rest in configured order", () => {
    const split = splitFavorites(entries, ["a/3", "gone/x", "b/2", "a/3"]);
    expect(split.favorites.map((e) => e.key)).toEqual(["a/3", "b/2"]);
    expect(split.rest.map((e) => e.key)).toEqual(["a/1", "b/4"]);
    expect(split.missing).toEqual(["gone/x"]);
  });

  it("does not add a model that the allowlist removed", () => {
    const shown = filterCatalog(entries, ["a/1"]).entries;
    const split = splitFavorites(shown, ["b/2"]);
    expect(split.favorites).toEqual([]);
    expect(split.rest.map((e) => e.key)).toEqual(["a/1"]);
    expect(split.missing).toEqual(["b/2"]);
  });

  it("toggles a key at the end of the list", () => {
    expect(toggleFavorite(["a/1"], "b/2")).toEqual(["a/1", "b/2"]);
    expect(toggleFavorite(["a/1", "b/2"], "a/1")).toEqual(["b/2"]);
  });
});
