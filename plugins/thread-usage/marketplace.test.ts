import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("matches the marketplace range to the thread-usage package version", () => {
  const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  const marketplace = JSON.parse(readFileSync(new URL("../../marketplace.json", import.meta.url), "utf8"));
  const entry = marketplace.plugins.find((plugin: { id: string }) => plugin.id === "thread-usage");
  expect(entry.source.git.range).toBe(`^${manifest.version}`);
});
