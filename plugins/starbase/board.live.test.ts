// A read-only smoke against a real Base: a real SITREP snapshot, published
// through the plugin's own `publish` command in 64 KiB parts as a publisher
// sends it, and the real bb threads, read with GETs on the local bb HTTP API.
// It prints column counts, the source state, and call timings only.
//
//   STARBASE_LIVE=1 STARBASE_LIVE_BASE=/path/to/starbase \
//     STARBASE_LIVE_SNAPSHOT=/path/to/snapshot.json npx vitest run board.live
//
// The snapshot must be an `all` one with mission state v1 rows: older rows
// give a board of pre-v1 rows, and the smoke fails. Skipped with no
// snapshot, so `pnpm test` never touches the network.
//
// The card action smoke sends one real message, so it runs only against a
// scratch thread that you made for it: a root thread, idle, whose first
// message is a user prompt. It publishes a synthetic snapshot whose one card
// has a decision surfaced by that first message, reads the message back with
// `question`, and answers Go with `act`. Archive the scratch thread after.
//
//   STARBASE_LIVE=1 STARBASE_LIVE_SCRATCH=thr_... npx vitest run board.live
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { COLUMN_IDS } from "./board";

const LIVE = process.env.STARBASE_LIVE === "1";
const BASE = process.env.STARBASE_LIVE_BASE ?? "";
const SNAPSHOT = process.env.STARBASE_LIVE_SNAPSHOT ?? "";
const SCRATCH = process.env.STARBASE_LIVE_SCRATCH ?? "";
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

/** One POST; a refusal throws with the status and code, as the SDK does. */
async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as {
    code?: string;
    message?: string;
  } | null;
  if (!response.ok) {
    throw Object.assign(
      new Error(`HTTP ${response.status}: ${payload?.message ?? path}`),
      { status: response.status, code: payload?.code, body: payload },
    );
  }
  return payload;
}

function loadPlugin(
  settings = { commanderProjectIds: VAAM_COMMANDER_PROJECT, baseRoot: BASE },
) {
  const fake = createFakePluginHost({
    pluginId: "starbase",
    settings,
    sdk: {
      threads: {
        get: ({ threadId }: { threadId: string }) =>
          get(`/threads/${threadId}`),
        message: ({ threadId, seq }: { threadId: string; seq: number }) =>
          get(`/threads/${threadId}/messages/${seq}`),
        send: ({ threadId, ...body }: { threadId: string }) =>
          post(`/threads/${threadId}/send`, body),
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

describe.skipIf(!LIVE || SNAPSHOT === "")("live board", () => {
  it("prints the column counts and timings for vaam-main and all", async () => {
    expect(BASE, "set STARBASE_LIVE_BASE to a v1 Base").not.toBe("");
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

describe.skipIf(!LIVE || SCRATCH === "")("live card actions", () => {
  it("reads the surfaced message and sends one answer to the scratch thread", async () => {
    const scratch = (await get(`/threads/${SCRATCH}`)) as {
      projectId: string;
      parentThreadId: string | null;
      status: string;
    };
    expect(scratch.parentThreadId, "the scratch must be a root thread").toBeNull();
    expect(scratch.status, "the scratch must be idle").toBe("idle");
    const first = (await get(`/threads/${SCRATCH}/messages/1`)) as {
      message: { text: string };
    };

    // The scratch thread's project is the only Commander project, and the
    // Base has no postures, so nothing else is a target.
    const fake = loadPlugin({
      commanderProjectIds: scratch.projectId,
      baseRoot: mkdtempSync(join(tmpdir(), "starbase-live-")),
    });
    const call = (name: string, input: unknown) =>
      fake.harness.callRpc(name, input) as Promise<unknown>;

    const fixture = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "fixtures/mission-state-v1/full-rows/survey-decision.json",
        ),
        "utf8",
      ),
    ).stdout[0];
    const state = structuredClone(fixture.mission_state);
    state.attention[0] = {
      ...state.attention[0],
      receipt: { message_ref: `@thread:${SCRATCH}#msg=1` },
    };
    state.pending_attention = [];
    const generatedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const published = await fake.harness.runCli([
      "publish",
      "--snapshot",
      JSON.stringify({
        version: 1,
        generated_at: generatedAt,
        host: "live-smoke",
        project: "all",
        commander: null,
        exit_code: 0,
        rows: [
          {
            ...fixture,
            bead: "smoke-1",
            title: "Board action live smoke",
            thread: SCRATCH,
            project: "smoke",
            mission_state: state,
          },
        ],
      }),
    ]);
    expect(published.exitCode).toBe(0);

    const board = (await call("board", { project: "all" })) as {
      generatedAt: number;
      columns: {
        cards: {
          bead: string | null;
          attention: { id: string; revision: number; messageRef: string | null }[];
          actions: { kind: string; target: string }[];
        }[];
      }[];
    };
    const card = board.columns
      .flatMap((column) => column.cards)
      .find((item) => item.bead === "smoke-1");
    const event = card?.attention.find((item) => item.messageRef !== null);
    expect(event, "the smoke card has a surfaced event").toBeDefined();
    if (card === undefined || event === undefined) return;
    expect(card.actions.find((action) => action.kind === "go")?.target).toBe(
      SCRATCH,
    );
    const attention = { id: event.id, revision: event.revision };

    const asked = (await call("question", {
      project: "all",
      bead: "smoke-1",
      attention,
    })) as { text: string | null; threadId: string | null; error: string | null };
    say(`question: ${asked.error ?? `${asked.text?.length} chars from ${asked.threadId}`}`);
    expect(asked).toEqual({
      text: first.message.text,
      threadId: SCRATCH,
      error: null,
    });

    const input = {
      project: "all",
      bead: "smoke-1",
      kind: "go",
      text: "",
      attention,
      generatedAt: board.generatedAt,
    };
    const sent = await timed("act (go)", () => call("act", input));
    say(`act: ${JSON.stringify(sent)}`);
    expect(sent).toEqual({ sent: true, target: SCRATCH, error: null });
    expect(await call("act", input)).toEqual({
      sent: false,
      target: null,
      error: "Already sent. The card waits for the Commander.",
    });
    await fake.harness.dispose();
  }, 120_000);
});
