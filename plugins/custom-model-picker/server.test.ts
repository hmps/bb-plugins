import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

// Loads the plugin and returns the settings handle it defined, so a test can
// read the persisted values the way the plugin does.
async function load(bb: BbPluginApi) {
  const define = vi.spyOn(bb.settings, "define");
  await plugin(bb);
  return define.mock.results[0]!.value as ReturnType<BbPluginApi["settings"]["define"]>;
}

describe("setFavorites", () => {
  it("saves trimmed, unique keys in the favorites setting", async () => {
    const { bb, harness } = createFakePluginHost();
    await load(bb);

    const result = await harness.callRpc("setFavorites", {
      keys: [" codex/gpt ", "claude-code/opus", "codex/gpt", ""],
    });
    expect(result).toEqual({ keys: ["codex/gpt", "claude-code/opus"] });

    // A new load reads the same stored value.
    let settings: Awaited<ReturnType<typeof load>> | undefined;
    await harness.lifecycle.reload(async (next) => {
      settings = await load(next);
    });
    expect(await settings!.get()).toMatchObject({
      favorites: "codex/gpt\nclaude-code/opus",
      models: "",
    });
  });

  it("rejects a key that is not provider/model and keeps the old value", async () => {
    const { bb, harness } = createFakePluginHost({
      settings: { favorites: "codex/gpt" },
    });
    const settings = await load(bb);

    await expect(harness.callRpc("setFavorites", { keys: ["opus"] })).rejects.toThrow(
      /Not valid: opus/,
    );
    expect((await settings.get()).favorites).toBe("codex/gpt");
  });

  it("starts with no favorites", async () => {
    const { bb } = createFakePluginHost();
    const settings = await load(bb);
    expect((await settings.get()).favorites).toBe("");
  });
});
