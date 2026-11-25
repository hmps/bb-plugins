import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    silent: "passed-only",
    // Anchored to the plugin root: a "**" glob also walks node_modules.
    include: ["*.test.ts", "*.test.tsx"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
