import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    name: "bb-plugin-command-palette",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
