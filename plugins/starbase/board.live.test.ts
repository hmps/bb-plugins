// A read-only smoke against a real Base: a real SITREP snapshot, published
// through the plugin's own `publish` command in 64 KiB parts as a publisher
// sends it, and the real bb threads, read with GETs on the local bb HTTP API.
// It prints column counts, the source state, and call timings only.
//
//   STARBASE_LIVE=1 STARBASE_LIVE_BASE=/path/to/starbase \
//     STARBASE_LIVE_SNAPSHOT=/path/to/snapshot.json npx vitest run board.live
//
// The snapshot must be an `all` one with mission state v1 rows: older rows
// give a board of pre-v1 rows, and the smoke fails. Skipped otherwise, so
// `pnpm test` never touches the network.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { COLUMN_IDS } from "./board";

const LIVE = process.env.STARBASE_LIVE === "1";
const BASE = process.env.STARBASE_LIVE_BASE ?? "";
const SNAPSHOT = process.env.STARBASE_LIVE_SNAPSHOT ?? "";
/** The part size a publisher uses: one argv string stays far below E2BIG. */
const PART_CHARS = 64 * 1024;
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
    expect(SNAPSHOT, "set STARBASE_LIVE_SNAPSHOT to a snapshot").not.toBe("");
    const fake = loadPlugin();
    const call = (name: string, input: unknown) =>
      fake.harness.callRpc(name, input) as Promise<unknown>;

    const document = JSON.stringify(JSON.parse(readFileSync(SNAPSHOT, "utf8")));
    const args = ["publish"];
    for (let at = 0; at < document.length; at += PART_CHARS) {
      args.push("--snapshot", document.slice(at, at + PART_CHARS));
    }
    const published = await timed(
      `publish (${document.length} chars, ${(args.length - 1) / 2} parts)`,
      () => fake.harness.runCli(args),
    );
    say(published.stdout || published.stderr);
    expect(published.exitCode).toBe(0);

    for (const project of ["vaam-main", "all"]) {
      const board = (await timed(`board call (${project})`, () =>
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
    await fake.harness.dispose();
  }, 120_000);
});
