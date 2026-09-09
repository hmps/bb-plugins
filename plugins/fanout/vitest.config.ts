import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    name: "bb-plugin-fanout",
    // Anchored to the plugin root: a "**" glob also walks the pnpm symlinks
    // under node_modules and picks up dependencies' own test suites.
    include: ["*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
