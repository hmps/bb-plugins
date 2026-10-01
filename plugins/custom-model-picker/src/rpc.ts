// RPC contract shared by server.ts (handlers) and the app (types only).
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const favoritesContract = defineRpcContract({
  setFavorites: {
    experimental_description:
      "Replace the favorite models. Keys use the provider/model form.",
    input: z.object({ keys: z.array(z.string()).max(200) }),
    output: z.object({ keys: z.array(z.string()) }),
  },
});

export type FavoritesContract = typeof favoritesContract;
