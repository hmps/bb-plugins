// A read-only smoke against a real Base: the real SITREP (through the
// plugin's own runner, so the password and PATH handling are the production
// ones) and the real bb threads, read with GETs on the local bb HTTP API. It
// prints column counts, the source state, and call timings only.
//
//   STARBASE_LIVE=1 STARBASE_LIVE_BASE=/path/to/starbase npx vitest run board.live
//
// The Base must carry the mission state v1 SITREP: an older one gives a
// board of pre-v1 rows, and the smoke fails. Skipped otherwise, so `npm test`
// never touches the network.
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { COLUMN_IDS } from "./board";

const LIVE = process.env.STARBASE_LIVE === "1";
const BASE = process.env.STARBASE_LIVE_BASE ?? "";
const API = `${process.env.BB_SERVER_URL ?? "http://127.0.0.1:38886"}/api/v1`;
const VAAM_COMMANDER = "thr_9mhukyfy2t";
const VAAM_COMMANDER_PROJECT = "proj_s9vk5k4c9u";

/** One read-only GET; a 404 throws the error the SDK throws. */
async function get(path: string): Promise<unknown> {
  const response = await fetch(`${API}${path}`);
  if (response.status === 404) {
    throw Object.assign(new Error("HTTP 404: Thread not found"), {
      status: 404,
    });
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} on ${path}`);
  return response.json();
}

function loadPlugin() {
  const fake = createFakePluginHost({
    pluginId: "starbase",
    settings: { commanderProjectIds: VAAM_COMMANDER_PROJECT, baseRoot: BASE },
    sdk: {
      threads: {
        get: ({ threadId }: { threadId: string }) =>
          get(`/threads/${threadId}`),
        list: (args?: {
          parentThreadId?: string;
          archived?: boolean;
          limit?: number;
          offset?: number;
        }) => {
          const query = new URLSearchParams({ includeHidden: "true" });
          if (args?.parentThreadId !== undefined) {
            query.set("parentThreadId", args.parentThreadId);
          }
          query.set("archived", String(args?.archived === true));
          query.set("limit", String(args?.limit ?? 100));
          query.set("offset", String(args?.offset ?? 0));
          return get(`/threads?${query}`);
        },
        interactions: {
          list: ({ threadId }: { threadId: string }) =>
            get(`/threads/${threadId}/interactions`),
        },
      },
      environments: {
        pullRequest: ({ environmentId }: { environmentId: string }) =>
          get(`/environments/${environmentId}/pull-request`),
      },
    },
  });
  plugin(fake.bb);
  return fake;
}

interface Board {
  source: string;
  error: string | null;
  columns: {
    id: string;
    total: number;
    cards: { flags: string[]; integrity: string | null }[];
  }[];
}

function counts(board: Board): string {
  return board.columns
    .map((column) => {
      const flagged = column.cards.filter(
        (card) => card.flags.length > 0 || card.integrity !== null,
      ).length;
      return `${column.id}=${column.total}${flagged > 0 ? ` (${flagged} flagged)` : ""}`;
    })
    .join("  ");
}

async function timed<T>(label: string, call: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await call();
  say(`${label}: ${Math.round(performance.now() - started)} ms`);
  return result;
}

/** Straight to stdout: the config keeps console output of a passed test silent. */
function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

describe.skipIf(!LIVE)("live board", () => {
  it("prints the column counts and timings for vaam-main and all", async () => {
    expect(BASE, "set STARBASE_LIVE_BASE to a v1 Base").not.toBe("");
    const fake = loadPlugin();
    const call = (name: string, input: unknown) =>
      fake.harness.callRpc(name, input) as Promise<unknown>;

    await timed("first board call after load (all)", () =>
      call("board", { project: "all" }),
    );
    for (const project of ["vaam-main", "all"]) {
      const board = (await timed(`warm board call (${project})`, () =>
        call("board", { project }),
      )) as Board;
      say(`${project}: ${board.source} ${counts(board)}`);
      expect(board.source).toMatch(/^(current|partial)$/);
      expect(board.columns).toHaveLength(COLUMN_IDS.length);
      const preV1 = board.columns
        .flatMap((column) => column.cards)
        .filter((card) => card.integrity === "Pre-v1 row");
      expect(preV1, "the Base SITREP is older than v1").toEqual([]);
    }
    const panel = (await timed(`panel call (${VAAM_COMMANDER}, first)`, () =>
      call("panel", { threadId: VAAM_COMMANDER }),
    )) as { scope: { scope: string | null; source: string } };
    say(`panel scope = ${panel.scope.scope} (${panel.scope.source})`);
    await timed(`panel call (${VAAM_COMMANDER}, warm)`, () =>
      call("panel", { threadId: VAAM_COMMANDER }),
    );
    await timed("forced board call (all)", () =>
      call("board", { project: "all", force: true }),
    );
    await fake.harness.dispose();
    // Two full SITREP runs (the first call and the forced one) of up to five
    // minutes each, plus the thread reads.
  }, 900_000);
});
