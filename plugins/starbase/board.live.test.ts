// A read-only smoke against the real Mission Queue: the real `bd` (through the
// plugin's own runner, so the password path is the production one) and the
// real bb threads, read with GETs on the local bb HTTP API. It prints column
// counts and call timings only.
//
//   STARBASE_LIVE=1 npx vitest run board.live
//
// Skipped otherwise, so `npm test` never touches the network.
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const LIVE = process.env.STARBASE_LIVE === "1";
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
    settings: { commanderProjectIds: VAAM_COMMANDER_PROJECT },
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
  columns: { id: string; total: number; cards: { flags: string[] }[] }[];
}

function counts(board: Board): string {
  return board.columns
    .map((column) => {
      const flagged = column.cards.filter(
        (card) => card.flags.length > 0,
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
      say(`${project}: ${counts(board)}`);
      expect(board.columns).toHaveLength(6);
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
  }, 300_000);
});
