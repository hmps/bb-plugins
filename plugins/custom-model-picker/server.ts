// Custom Model Picker — backend entry. It declares the allowlist and
// favorites settings, which app.tsx reads with useSettings(), and the RPC
// method that the star buttons use to save favorites.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { invalidAllowlistKeys, parseAllowlist } from "./src/allowlist";
import { favoritesContract } from "./src/rpc";

const keysSchema = z.string().superRefine((value, ctx) => {
  const invalid = invalidAllowlistKeys(parseAllowlist(value));
  if (invalid.length > 0) {
    ctx.addIssue({
      code: "custom",
      message: `Use provider/model keys. Not valid: ${invalid.join(", ")}`,
    });
  }
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    models: {
      type: "string",
      label: "Shown models",
      description:
        "One provider/model key per line, for example claude-code/claude-opus-5-5. Lines that start with # are comments. Leave empty to show every model in the catalog.",
      experimental_multiline: true,
      experimental_schema: keysSchema,
      default: "",
    },
    favorites: {
      type: "string",
      label: "Favorite models",
      description:
        "One provider/model key per line. The menu shows these models first, in this order. The star buttons in the menu change this list.",
      experimental_multiline: true,
      experimental_schema: keysSchema,
      default: "",
    },
  });

  bb.rpc.register(favoritesContract, {
    async setFavorites({ keys }) {
      const unique = [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
      const invalid = invalidAllowlistKeys(unique);
      if (invalid.length > 0) {
        throw new Error(`Use provider/model keys. Not valid: ${invalid.join(", ")}`);
      }
      const next = await settings.experimental_set({ favorites: unique.join("\n") });
      return { keys: parseAllowlist(next.favorites) };
    },
  });
}
