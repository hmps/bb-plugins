import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import plugin, { formatSitrepRow, parseProjectIds } from "./server";

const COMMANDER_PROJECT = "proj_commander";
const COMMANDER_THREAD = "thr_commander";
const CREW_THREAD = "thr_crew";
const CREW_PROJECT = "proj_target";
const CREW_ENVIRONMENT = "env_crew";

type PendingInteraction =
  PluginThreadEventPayloads["interaction.pending"]["interaction"];

/** A Crew thread: it lives in a target project and its parent is a Commander. */
function crewThread(overrides: Record<string, unknown> = {}) {
  return makeThreadResponse({
    id: CREW_THREAD,
    projectId: CREW_PROJECT,
    parentThreadId: COMMANDER_THREAD,
    environmentId: CREW_ENVIRONMENT,
    ...overrides,
  });
}

function commanderThread(overrides: Record<string, unknown> = {}) {
  return makeThreadResponse({
    id: COMMANDER_THREAD,
    projectId: COMMANDER_PROJECT,
    parentThreadId: null,
    status: "idle",
    ...overrides,
  });
}

/** A clean, available worktree — the default every test starts from. */
function cleanStatus() {
  return {
    outcome: "available",
    workspace: {
      branch: { currentBranch: "main", defaultBranch: "main" },
      checkout: { kind: "branch", branchName: "main", headSha: null },
      mergeBase: null,
      workingTree: {
        deletions: 0,
        files: [],
        hasUncommittedChanges: false,
        insertions: 0,
        lineStatsComplete: true,
        state: "clean",
      },
    },
  };
}

function dirtyStatus() {
  return {
    outcome: "available",
    workspace: {
      branch: { currentBranch: "work", defaultBranch: "main" },
      checkout: { kind: "branch", branchName: "work", headSha: null },
      mergeBase: null,
      workingTree: {
        deletions: 0,
        files: [],
        hasUncommittedChanges: true,
        insertions: 3,
        lineStatsComplete: true,
        state: "dirty_uncommitted",
      },
    },
  };
}

/**
 * The error bb raises for `mode: "start"` against an active thread, in the
 * exact shape the SDK's `BbHttpError` carries it: HTTP 409, a top-level
 * `code`, and the server's `details.reason`.
 */
function alreadyActiveError() {
  const error = new Error("HTTP 409: Thread is already active") as Error & {
    status: number;
    code: string;
    body: unknown;
  };
  error.name = "BbHttpError";
  error.status = 409;
  error.code = "thread_not_writable";
  error.body = {
    code: "thread_not_writable",
    message: "Thread is already active",
    details: {
      reason: "already_active",
      archivedAt: null,
      threadStatus: "active",
    },
  };
  return error;
}

/** A minimal `approval` interaction — only the fields the plugin reads. */
function approvalInteraction(id: string): PendingInteraction {
  return {
    id,
    threadId: CREW_THREAD,
    payload: {
      kind: "approval",
      reason: "needs a decision",
      availableDecisions: ["allow_once", "deny"],
      subject: {
        kind: "command",
        itemId: "item_1",
        command: "rm -rf build",
        cwd: null,
        actions: [],
        sessionGrant: null,
      },
    },
    status: "pending",
  } as unknown as PendingInteraction;
}

interface HostOptions {
  threadsGet?: (args: { threadId: string }) => unknown;
  environmentStatus?: (args: { environmentId: string }) => unknown;
  environmentPullRequest?: (args: { environmentId: string }) => unknown;
  threadsList?: (args?: unknown) => unknown;
  interactionsList?: (args: { threadId: string }) => unknown;
  archiveAll?: (args: { threadId: string }) => unknown;
  threadsArchive?: (args: { threadId: string }) => unknown;
  threadsUnarchive?: (args: { threadId: string }) => unknown;
  threadsSend?: (args: unknown) => unknown;
  commanderProjectIds?: string;
}

/**
 * The default thread lookup: the Commander answers for its own id, and every
 * other id answers as Crew under it. That is the shape the parent walks in
 * `commanderFor` and `isSettleTarget` expect.
 */
/**
 * A `threads.list` stub from a parent-id map. Every list is one short page, so
 * paging stops after the first call.
 */
function pages(byParent: Record<string, Array<{ id: string }>>) {
  return (args?: unknown) => {
    const { parentThreadId, offset, archived } = args as {
      parentThreadId: string;
      offset?: number;
      archived?: boolean;
    };
    // These are live children; an `archived: true` query matches none of them.
    if (archived === true) return [];
    if ((offset ?? 0) > 0) return [];
    return byParent[parentThreadId] ?? [];
  };
}

function defaultThreadsGet(args: { threadId: string }) {
  return args.threadId === COMMANDER_THREAD
    ? commanderThread()
    : crewThread({ id: args.threadId });
}

/** A fake host with just enough of `bb.sdk` stubbed for the case at hand. */
function host(options: HostOptions = {}) {
  const fake = createFakePluginHost({
    pluginId: "starbase",
    settings: {
      commanderProjectIds: options.commanderProjectIds ?? COMMANDER_PROJECT,
    },
    sdk: {
      threads: {
        get: options.threadsGet ?? defaultThreadsGet,
        list: options.threadsList ?? (() => []),
        send: options.threadsSend ?? (() => ({ ok: true, delivery: "sent" })),
        archive:
          options.threadsArchive ??
          ((args: { threadId: string }) => ({
            ok: true,
            archivedThreadIds: [args.threadId],
          })),
        unarchive: options.threadsUnarchive ?? (() => ({ ok: true })),
        archiveAll:
          options.archiveAll ?? (() => ({ ok: true, archivedThreadIds: [] })),
        interactions: {
          list: options.interactionsList ?? (() => []),
        },
      },
      environments: {
        status: options.environmentStatus ?? (() => cleanStatus()),
        pullRequest:
          options.environmentPullRequest ?? (() => ({ outcome: "absent" })),
      },
    },
  });
  plugin(fake.bb);
  return fake;
}

describe("parseProjectIds", () => {
  it("accepts a newline list, a comma list, and stray whitespace", () => {
    expect([...parseProjectIds("proj_a\nproj_b, proj_c  ")]).toEqual([
      "proj_a",
      "proj_b",
      "proj_c",
    ]);
  });

  it("treats an unset setting as an empty list", () => {
    expect(parseProjectIds(undefined).size).toBe(0);
  });
});

describe("interaction relay", () => {
  it("relays two identical pending interactions exactly once", async () => {
    const { harness } = host();
    const payload = {
      thread: crewThread(),
      interaction: approvalInteraction("int_1"),
    };

    const first = await harness.emitThreadEvent("interaction.pending", payload);
    const second = await harness.emitThreadEvent("interaction.pending", payload);

    // Both handlers ran to completion; only the dedupe key stopped the second.
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    // Two parent lookups (one per event) plus one Commander status read on
    // the single send that actually happened.
    expect(harness.sdk.callsTo("threads.get")).toHaveLength(3);

    const sends = harness.sdk.callsTo("threads.send");
    expect(sends).toHaveLength(1);
    const [args] = sends[0] as [
      { threadId: string; input: Array<{ text: string }> },
    ];
    expect(args.threadId).toBe(COMMANDER_THREAD);
    expect(args.input[0].text).toBe(
      `SENTINEL interaction · ${CREW_THREAD} · approval/command · rm -rf build · resolve: bb thread interactions approve int_1 ${CREW_THREAD}`,
    );
  });

  it("ignores a thread whose parent is not a Commander", async () => {
    const { harness } = host({
      threadsGet: () =>
        makeThreadResponse({
          id: COMMANDER_THREAD,
          projectId: "proj_someone_else",
          parentThreadId: null,
        }),
    });

    await harness.emitThreadEvent("interaction.pending", {
      thread: crewThread(),
      interaction: approvalInteraction("int_1"),
    });

    expect(harness.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("ignores a root thread that has no parent at all", async () => {
    const { harness } = host();

    await harness.emitThreadEvent("interaction.pending", {
      thread: crewThread({ parentThreadId: null }),
      interaction: approvalInteraction("int_1"),
    });

    expect(harness.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("never relays the Commander's own raised hand", async () => {
    const { harness } = host();

    // A Commander is a root thread, so it has no parent to report to.
    await harness.emitThreadEvent("interaction.pending", {
      thread: commanderThread(),
      interaction: approvalInteraction("int_1"),
    });

    expect(harness.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("relays Crew that the Commander dispatched inside its own Base project", async () => {
    const { harness } = host();

    // A Survey Mission runs in the Commander's own project. Its parent is
    // still the Commander, so it is still Crew.
    await harness.emitThreadEvent("interaction.pending", {
      thread: crewThread({ projectId: COMMANDER_PROJECT }),
      interaction: approvalInteraction("int_1"),
    });

    expect(harness.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("ignores a grandchild whose parent is not a root Commander", async () => {
    const { harness } = host({
      // The parent lives in the Commander project but has a parent of its own.
      threadsGet: () =>
        makeThreadResponse({
          id: "thr_middle",
          projectId: COMMANDER_PROJECT,
          parentThreadId: COMMANDER_THREAD,
        }),
    });

    await harness.emitThreadEvent("interaction.pending", {
      thread: crewThread({ parentThreadId: "thr_middle" }),
      interaction: approvalInteraction("int_1"),
    });

    expect(harness.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("relays again after a failed send, because the key was released", async () => {
    let attempt = 0;
    const { harness } = host({
      threadsSend: () => {
        attempt += 1;
        if (attempt === 1) throw new Error("commander unreachable");
        return { ok: true, delivery: "sent" };
      },
    });
    const payload = {
      thread: crewThread(),
      interaction: approvalInteraction("int_1"),
    };

    const first = await harness.emitThreadEvent("interaction.pending", payload);
    const second = await harness.emitThreadEvent("interaction.pending", payload);

    // The first send threw and the handler swallowed it after releasing the
    // dedupe key; the identical replay then got through.
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(harness.sdk.callsTo("threads.send")).toHaveLength(2);
  });

  it("queues behind a busy Commander instead of steering it", async () => {
    const { harness } = host({
      threadsGet: (args) =>
        args.threadId === COMMANDER_THREAD
          ? commanderThread({ status: "active" })
          : crewThread(),
    });

    await harness.emitThreadEvent("interaction.pending", {
      thread: crewThread(),
      interaction: approvalInteraction("int_1"),
    });

    const sends = harness.sdk.callsTo("threads.send");
    expect(sends).toHaveLength(1);
    expect((sends[0][0] as { mode: string }).mode).toBe("queue-if-active");
  });

  it("starts a turn on an idle Commander, never steering with auto", async () => {
    const { harness } = host();

    await harness.emitThreadEvent("interaction.pending", {
      thread: crewThread(),
      interaction: approvalInteraction("int_1"),
    });

    const sends = harness.sdk.callsTo("threads.send");
    expect(sends).toHaveLength(1);
    expect((sends[0][0] as { mode: string }).mode).toBe("start");
  });

  it("queues once when the Commander starts a turn during the send", async () => {
    // The status read says idle; by the time `start` lands, it is not.
    const modes: string[] = [];
    const { harness } = host({
      threadsSend: (args) => {
        const mode = (args as { mode: string }).mode;
        modes.push(mode);
        if (mode === "start") throw alreadyActiveError();
        return { ok: true, delivery: "queued" };
      },
    });

    const result = await harness.emitThreadEvent("interaction.pending", {
      thread: crewThread(),
      interaction: approvalInteraction("int_1"),
    });

    expect(result.errors).toEqual([]);
    expect(modes).toEqual(["start", "queue-if-active"]);

    // The retry succeeded, so the dedupe row stands: a replay does not resend.
    await harness.emitThreadEvent("interaction.pending", {
      thread: crewThread(),
      interaction: approvalInteraction("int_1"),
    });
    expect(modes).toEqual(["start", "queue-if-active"]);
  });

  it("never retries an ambiguous send failure, and releases the key", async () => {
    // A timeout says nothing about whether the server took the message.
    // Retrying would post the same line twice.
    const modes: string[] = [];
    let attempt = 0;
    const { harness } = host({
      threadsSend: (args) => {
        modes.push((args as { mode: string }).mode);
        attempt += 1;
        if (attempt === 1) {
          throw new Error("BB request timed out after 75 seconds.");
        }
        return { ok: true, delivery: "sent" };
      },
    });
    const payload = {
      thread: crewThread(),
      interaction: approvalInteraction("int_1"),
    };

    const first = await harness.emitThreadEvent("interaction.pending", payload);
    expect(first.errors).toEqual([]);
    // One attempt only: no queue retry behind an ambiguous failure.
    expect(modes).toEqual(["start"]);

    // The row was released, so the next identical event tries again.
    await harness.emitThreadEvent("interaction.pending", payload);
    expect(modes).toEqual(["start", "start"]);
  });

  it("keeps the dedupe row when the queue retry succeeds", async () => {
    const { harness } = host({
      threadsSend: (args) => {
        if ((args as { mode: string }).mode === "start") {
          throw alreadyActiveError();
        }
        return { ok: true, delivery: "queued" };
      },
    });
    const payload = {
      thread: crewThread(),
      interaction: approvalInteraction("int_1"),
    };

    await harness.emitThreadEvent("interaction.pending", payload);
    await harness.emitThreadEvent("interaction.pending", payload);

    // start + queue on the first event, nothing on the replay.
    expect(harness.sdk.callsTo("threads.send")).toHaveLength(2);
  });

  it("deletes the dedupe row when both the start and the queue fail", async () => {
    let attempt = 0;
    const { harness } = host({
      threadsSend: (args) => {
        const mode = (args as { mode: string }).mode;
        if (mode === "start") throw alreadyActiveError();
        attempt += 1;
        if (attempt === 1) throw new Error("commander unreachable");
        return { ok: true, delivery: "queued" };
      },
    });
    const payload = {
      thread: crewThread(),
      interaction: approvalInteraction("int_1"),
    };

    await harness.emitThreadEvent("interaction.pending", payload);
    await harness.emitThreadEvent("interaction.pending", payload);

    // Two full attempts: the first released its key when the queue send failed.
    expect(harness.sdk.callsTo("threads.send")).toHaveLength(4);
  });
});

describe("failure relay", () => {
  it("relays one failure per transition and dedupes a replay", async () => {
    const { harness } = host();
    const payload = {
      thread: crewThread({ status: "error", updatedAt: 1000 }),
      error: "the build broke",
    };

    await harness.emitThreadEvent("thread.failed", payload);
    await harness.emitThreadEvent("thread.failed", payload);

    const sends = harness.sdk.callsTo("threads.send");
    expect(sends).toHaveLength(1);
    const [args] = sends[0] as [{ input: Array<{ text: string }> }];
    expect(args.input[0].text).toBe(
      `SENTINEL failed · ${CREW_THREAD} · the build broke`,
    );
  });

  it("relays a second failure with the same text at a later timestamp", async () => {
    const { harness } = host();

    await harness.emitThreadEvent("thread.failed", {
      thread: crewThread({ status: "error", updatedAt: 1000 }),
      error: "the build broke",
    });
    await harness.emitThreadEvent("thread.failed", {
      thread: crewThread({ status: "error", updatedAt: 2000 }),
      error: "the build broke",
    });

    expect(harness.sdk.callsTo("threads.send")).toHaveLength(2);
  });

  it("relays a second failure with different text at the same timestamp", async () => {
    const { harness } = host();

    await harness.emitThreadEvent("thread.failed", {
      thread: crewThread({ status: "error", updatedAt: 1000 }),
      error: "the build broke",
    });
    await harness.emitThreadEvent("thread.failed", {
      thread: crewThread({ status: "error", updatedAt: 1000 }),
      error: "the tests broke",
    });

    expect(harness.sdk.callsTo("threads.send")).toHaveLength(2);
  });

  it("collapses a multi-line error onto one relay line", async () => {
    const { harness } = host();

    await harness.emitThreadEvent("thread.failed", {
      thread: crewThread({ status: "error", updatedAt: 1000 }),
      error: "the build broke\n  at step 3\n\nsee the log",
    });

    const [args] = harness.sdk.callsTo("threads.send")[0] as [
      { input: Array<{ text: string }> },
    ];
    expect(args.input[0].text).toBe(
      `SENTINEL failed · ${CREW_THREAD} · the build broke at step 3 see the log`,
    );
    expect(args.input[0].text).not.toContain("\n");
  });
});

describe("idle", () => {
  it("records an idle Crew thread without relaying it", async () => {
    const { harness } = host({
      threadsList: () => [
        {
          id: CREW_THREAD,
          title: "Build the Sentinel",
          status: "idle",
          environmentId: null,
          hasPendingInteraction: false,
          titleFallback: null,
        },
      ],
    });

    await harness.emitThreadEvent("thread.idle", {
      thread: crewThread({ status: "idle", updatedAt: 2000 }),
      lastAssistantText: "done",
    });

    expect(harness.sdk.callsTo("threads.send")).toHaveLength(0);

    // `last` is a --json field now, so the text report must not carry it.
    const text = await harness.runCli([
      "sitrep",
      "--commander",
      COMMANDER_THREAD,
    ]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).not.toContain("last:");

    const json = await harness.runCli([
      "sitrep",
      "--commander",
      COMMANDER_THREAD,
      "--json",
    ]);
    expect(JSON.parse(json.stdout).crew[0].last).toBe("idle");
  });
});

describe("sitrep", () => {
  it("prints one line per Crew thread in the documented shape", async () => {
    const { harness } = host({
      threadsList: () => [
        {
          id: CREW_THREAD,
          title: "Build the Sentinel",
          titleFallback: null,
          status: "active",
          environmentId: CREW_ENVIRONMENT,
          hasPendingInteraction: true,
        },
      ],
      environmentPullRequest: () => ({
        outcome: "available",
        pullRequest: {
          url: "https://github.com/hmps/bb-plugins/pull/9",
          state: "open",
        },
      }),
      interactionsList: () => [
        { id: "int_1", status: "pending" },
        { id: "int_2", status: "resolved" },
      ],
    });

    const result = await harness.runCli([
      "sitrep",
      "--commander",
      COMMANDER_THREAD,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      `${CREW_THREAD} · Build the Sentinel · active · pr:https://github.com/hmps/bb-plugins/pull/9 open · worktree:clean · interactions:1`,
    );
  });

  it("collapses a multi-line title onto one line", async () => {
    const { harness } = host({
      threadsList: () => [
        {
          id: CREW_THREAD,
          title: "Build the\nSentinel   plugin",
          titleFallback: null,
          status: "idle",
          environmentId: null,
          hasPendingInteraction: false,
        },
      ],
    });

    const result = await harness.runCli([
      "sitrep",
      "--commander",
      COMMANDER_THREAD,
    ]);

    expect(result.stdout.split("\n")).toHaveLength(1);
    expect(result.stdout).toContain("Build the Sentinel plugin");
  });

  it("reports worktree n/a when the thread has no environment", async () => {
    const { harness } = host({
      threadsList: () => [
        {
          id: CREW_THREAD,
          title: null,
          titleFallback: null,
          status: "idle",
          environmentId: null,
          hasPendingInteraction: false,
        },
      ],
    });

    const result = await harness.runCli([
      "sitrep",
      "--commander",
      COMMANDER_THREAD,
    ]);

    expect(result.stdout).toContain("worktree:n/a");
    expect(result.stdout).toContain("pr:none");
  });

  it("lists a hidden Crew thread", async () => {
    const { harness } = host({
      threadsList: (args) => {
        const query = args as { includeHidden?: boolean };
        return query.includeHidden === true
          ? [
              {
                id: "thr_hidden",
                title: "Background worker",
                titleFallback: null,
                status: "active",
                environmentId: null,
                hasPendingInteraction: false,
              },
            ]
          : [];
      },
    });

    const result = await harness.runCli([
      "sitrep",
      "--commander",
      COMMANDER_THREAD,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("thr_hidden");
  });

  it("reads every page of Crew threads", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `thr_page1_${index}`,
      title: "Crew",
      titleFallback: null,
      status: "idle",
      environmentId: null,
      hasPendingInteraction: false,
    }));
    const { harness } = host({
      threadsList: (args) => {
        const offset = (args as { offset?: number }).offset ?? 0;
        return offset === 0
          ? firstPage
          : [
              {
                id: "thr_page2_0",
                title: "Late Crew",
                titleFallback: null,
                status: "idle",
                environmentId: null,
                hasPendingInteraction: false,
              },
            ];
      },
    });

    const result = await harness.runCli([
      "sitrep",
      "--commander",
      COMMANDER_THREAD,
    ]);

    expect(result.stdout.split("\n")).toHaveLength(101);
    expect(result.stdout).toContain("thr_page2_0");
  });

  it("refuses when the Crew list never ends", async () => {
    let next = 0;
    const { harness } = host({
      threadsList: () =>
        Array.from({ length: 100 }, () => ({
          id: `thr_endless_${next++}`,
          title: "Crew",
          titleFallback: null,
          status: "idle",
          environmentId: null,
          hasPendingInteraction: false,
        })),
    });

    const result = await harness.runCli([
      "sitrep",
      "--commander",
      COMMANDER_THREAD,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Could not list every Crew thread under ${COMMANDER_THREAD}.`,
    );
  });

  it("reports worktree n/a for a non-git environment", async () => {
    const { harness } = host({
      threadsList: () => [
        {
          id: CREW_THREAD,
          title: "Crew",
          titleFallback: null,
          status: "idle",
          environmentId: CREW_ENVIRONMENT,
          hasPendingInteraction: false,
        },
      ],
      environmentStatus: () => ({
        outcome: "not_applicable",
        reason: "non_git_environment",
        message: "this environment is not a git repository",
      }),
    });

    const result = await harness.runCli([
      "sitrep",
      "--commander",
      COMMANDER_THREAD,
    ]);

    expect(result.stdout).toContain("worktree:n/a");
  });

  it("reports worktree unknown when git could not answer", async () => {
    const { harness } = host({
      threadsList: () => [
        {
          id: CREW_THREAD,
          title: "Crew",
          titleFallback: null,
          status: "idle",
          environmentId: CREW_ENVIRONMENT,
          hasPendingInteraction: false,
        },
      ],
      environmentStatus: () => ({
        outcome: "unavailable",
        failure: {
          code: "not_git_repo",
          message: "not a git repository",
          workspacePath: "/tmp/nowhere",
        },
      }),
    });

    const result = await harness.runCli([
      "sitrep",
      "--commander",
      COMMANDER_THREAD,
    ]);

    expect(result.stdout).toContain("worktree:unknown");
  });

  it("refuses a commander thread that is not in a Commander project", async () => {
    const { harness } = host({
      threadsGet: () =>
        makeThreadResponse({
          id: "thr_random",
          projectId: "proj_random",
          parentThreadId: null,
        }),
    });

    const result = await harness.runCli(["sitrep", "--commander", "thr_random"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is not a Commander");
  });

  it("refuses a thread in a Commander project that is not a root thread", async () => {
    const { harness } = host({
      threadsGet: () =>
        makeThreadResponse({
          id: "thr_child",
          projectId: COMMANDER_PROJECT,
          parentThreadId: COMMANDER_THREAD,
        }),
    });

    const result = await harness.runCli(["sitrep", "--commander", "thr_child"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "Thread thr_child is not a Commander: it is not a root thread.",
    );
  });

  it("emits JSON with --json", async () => {
    const { harness } = host({
      threadsList: () => [
        {
          id: CREW_THREAD,
          title: "Crew",
          titleFallback: null,
          status: "idle",
          environmentId: null,
          hasPendingInteraction: false,
        },
      ],
    });

    const result = await harness.runCli([
      "sitrep",
      "--commander",
      COMMANDER_THREAD,
      "--json",
    ]);

    expect(JSON.parse(result.stdout)).toEqual({
      commanderId: COMMANDER_THREAD,
      crew: [
        {
          threadId: CREW_THREAD,
          title: "Crew",
          status: "idle",
          pr: "none",
          worktree: "n/a",
          interactions: 0,
          last: "none",
        },
      ],
    });
  });
});

describe("settle", () => {
  /** Every id `threads.archive` was called with, in call order. */
  function archivedIds(harness: { sdk: { callsTo(p: string): unknown[][] } }) {
    return harness.sdk
      .callsTo("threads.archive")
      .map(([args]) => (args as { threadId: string }).threadId);
  }

  it("refuses a dirty worktree and archives nothing", async () => {
    const { harness } = host({ environmentStatus: () => dirtyStatus() });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Refused: ${CREW_THREAD} — the worktree has uncommitted changes.`,
    );
    expect(archivedIds(harness)).toEqual([]);
  });

  it("refuses an open pull request", async () => {
    const { harness } = host({
      environmentPullRequest: () => ({
        outcome: "available",
        pullRequest: {
          url: "https://github.com/hmps/bb-plugins/pull/9",
          state: "open",
        },
      }),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Refused: ${CREW_THREAD} — pull request https://github.com/hmps/bb-plugins/pull/9 is still open.`,
    );
    expect(archivedIds(harness)).toEqual([]);
  });

  it("refuses a worktree status bb could not read", async () => {
    const { harness } = host({
      environmentStatus: () => ({
        outcome: "unavailable",
        failure: {
          code: "permission_denied",
          message: "cannot read the worktree",
          workspacePath: "/tmp/nowhere",
        },
      }),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Refused: ${CREW_THREAD} — git could not read the worktree (permission_denied).`,
    );
    expect(archivedIds(harness)).toEqual([]);
  });

  it("refuses a pull request state bb could not read", async () => {
    const { harness } = host({
      environmentPullRequest: () => ({
        outcome: "unavailable",
        message: "gh is not authenticated",
      }),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Refused: ${CREW_THREAD} — the pull request state is unavailable.`,
    );
    expect(archivedIds(harness)).toEqual([]);
  });

  it("allows a non-git environment, which has no worktree to lose", async () => {
    const { harness } = host({
      environmentStatus: () => ({
        outcome: "not_applicable",
        reason: "non_git_environment",
        message: "this environment is not a git repository",
      }),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(0);
    expect(archivedIds(harness)).toEqual([CREW_THREAD]);
  });

  it("allows a thread that has no environment at all", async () => {
    const { harness } = host({
      threadsGet: (args) =>
        args.threadId === COMMANDER_THREAD
          ? commanderThread()
          : crewThread({ id: args.threadId, environmentId: null }),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(0);
    expect(archivedIds(harness)).toEqual([CREW_THREAD]);
  });

  it("allows an environment that simply has no pull request", async () => {
    const { harness } = host({
      environmentPullRequest: () => ({ outcome: "absent" }),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(0);
    expect(archivedIds(harness)).toEqual([CREW_THREAD]);
  });

  it("refuses when a child in the tree is unsafe, naming that child", async () => {
    const childId = "thr_child";
    const { harness } = host({
      threadsGet: (args) => {
        if (args.threadId === COMMANDER_THREAD) return commanderThread();
        if (args.threadId === childId) {
          return crewThread({ id: childId, environmentId: "env_child" });
        }
        return crewThread({ id: args.threadId });
      },
      threadsList: pages({ [CREW_THREAD]: [{ id: childId }] }),
      // The root is clean; only the child's worktree is dirty.
      environmentStatus: (args) =>
        args.environmentId === "env_child" ? dirtyStatus() : cleanStatus(),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Refused: ${childId} (a child of ${CREW_THREAD}) — the worktree has uncommitted changes.`,
    );
    expect(archivedIds(harness)).toEqual([]);
  });

  it("refuses when a grandchild in the tree has an open pull request", async () => {
    const childId = "thr_child";
    const grandchildId = "thr_grandchild";
    const { harness } = host({
      threadsGet: (args) => {
        if (args.threadId === COMMANDER_THREAD) return commanderThread();
        if (args.threadId === childId) {
          return crewThread({ id: childId, environmentId: "env_child" });
        }
        if (args.threadId === grandchildId) {
          return crewThread({ id: grandchildId, environmentId: "env_grand" });
        }
        return crewThread({ id: args.threadId });
      },
      threadsList: pages({
        [CREW_THREAD]: [{ id: childId }],
        [childId]: [{ id: grandchildId }],
      }),
      environmentPullRequest: (args) =>
        args.environmentId === "env_grand"
          ? {
              outcome: "available",
              pullRequest: {
                url: "https://github.com/hmps/bb-plugins/pull/12",
                state: "draft",
              },
            }
          : { outcome: "absent" },
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Refused: ${grandchildId} (a child of ${CREW_THREAD}) — pull request https://github.com/hmps/bb-plugins/pull/12 is still draft.`,
    );
    expect(archivedIds(harness)).toEqual([]);
  });

  it("refuses when a hidden grandchild has a dirty worktree", async () => {
    const childId = "thr_child";
    const hiddenId = "thr_hidden";
    const { harness } = host({
      threadsGet: (args) => {
        if (args.threadId === COMMANDER_THREAD) return commanderThread();
        if (args.threadId === hiddenId) {
          return crewThread({
            id: hiddenId,
            environmentId: "env_hidden",
            visibility: "hidden",
          });
        }
        return crewThread({ id: args.threadId, environmentId: null });
      },
      // The hidden grandchild is only returned when includeHidden is set.
      threadsList: (args) => {
        const query = args as { parentThreadId: string; includeHidden?: boolean };
        if (query.parentThreadId === CREW_THREAD) return [{ id: childId }];
        if (query.parentThreadId === childId) {
          return query.includeHidden === true ? [{ id: hiddenId }] : [];
        }
        return [];
      },
      environmentStatus: (args) =>
        args.environmentId === "env_hidden" ? dirtyStatus() : cleanStatus(),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Refused: ${hiddenId} (a child of ${CREW_THREAD}) — the worktree has uncommitted changes.`,
    );
    expect(archivedIds(harness)).toEqual([]);
  });

  it("checks a child that only appears on the second page", async () => {
    // A full first page, then one more child: the second page must be read.
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `thr_page1_${index}`,
    }));
    const lateId = "thr_page2_0";
    const { harness } = host({
      threadsGet: (args) => {
        if (args.threadId === COMMANDER_THREAD) return commanderThread();
        if (args.threadId === lateId) {
          return crewThread({ id: lateId, environmentId: "env_late" });
        }
        return crewThread({ id: args.threadId, environmentId: null });
      },
      threadsList: (args) => {
        const query = args as {
          parentThreadId: string;
          offset?: number;
        };
        if (query.parentThreadId !== CREW_THREAD) return [];
        return (query.offset ?? 0) === 0 ? firstPage : [{ id: lateId }];
      },
      environmentStatus: (args) =>
        args.environmentId === "env_late" ? dirtyStatus() : cleanStatus(),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Refused: ${lateId} (a child of ${CREW_THREAD}) — the worktree has uncommitted changes.`,
    );
    expect(archivedIds(harness)).toEqual([]);
  });

  it("refuses when the descendant list never ends", async () => {
    // Every page is full, so the list is never shown to be exhausted.
    let next = 0;
    const { harness } = host({
      threadsGet: (args) =>
        args.threadId === COMMANDER_THREAD
          ? commanderThread()
          : crewThread({ id: args.threadId, environmentId: null }),
      threadsList: () =>
        Array.from({ length: 100 }, () => ({ id: `thr_endless_${next++}` })),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "settle: could not enumerate all descendants",
    );
    expect(archivedIds(harness)).toEqual([]);
  });

  it("archives every checked thread one by one, deepest first", async () => {
    const childId = "thr_child";
    const grandchildId = "thr_grandchild";
    const { harness } = host({
      threadsGet: (args) =>
        args.threadId === COMMANDER_THREAD
          ? commanderThread()
          : crewThread({ id: args.threadId, environmentId: null }),
      threadsList: pages({
        [CREW_THREAD]: [{ id: childId }],
        [childId]: [{ id: grandchildId }],
      }),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`Settled ${CREW_THREAD}: archived 3 thread(s).`);
    // Deepest first, and never `archiveAll`, which picks its own tree.
    expect(archivedIds(harness)).toEqual([grandchildId, childId, CREW_THREAD]);
    expect(harness.sdk.callsTo("threads.archiveAll")).toHaveLength(0);
  });

  it("stops and unarchives when an archive reaches an unchecked thread", async () => {
    const childId = "thr_child";
    const { harness } = host({
      threadsGet: (args) =>
        args.threadId === COMMANDER_THREAD
          ? commanderThread()
          : crewThread({ id: args.threadId, environmentId: null }),
      threadsList: pages({ [CREW_THREAD]: [{ id: childId }] }),
      threadsArchive: (args) => ({
        ok: true,
        // The deepest call already reaches a thread settle never saw.
        archivedThreadIds: [args.threadId, "thr_surprise"],
      }),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      [
        `settle ${CREW_THREAD}: stopped — archiving ${childId} also took 1 unchecked thread(s).`,
        "Unchecked: thr_surprise",
        "Unarchived: thr_surprise",
        "Still archived: none",
        `Archived as intended: ${childId}`,
        `Not archived: ${CREW_THREAD}`,
      ].join("\n"),
    );
    // It stopped before the root's larger archive.
    expect(archivedIds(harness)).toEqual([childId]);
    expect(
      harness.sdk.callsTo("threads.unarchive").map(([a]) => a),
    ).toEqual([{ threadId: "thr_surprise" }]);
  });

  it("names all twelve unchecked ids, one per line, hiding none", async () => {
    const surprises = Array.from(
      { length: 12 },
      (_, index) => `thr_surprise_${index}`,
    );
    const { harness } = host({
      threadsArchive: (args) => ({
        ok: true,
        archivedThreadIds: [args.threadId, ...surprises],
      }),
      // Every unarchive fails, so all twelve stay archived and must be named.
      threadsUnarchive: () => {
        throw new Error("unarchive is not permitted");
      },
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      [
        `settle ${CREW_THREAD}: stopped — archiving ${CREW_THREAD} also took 12 unchecked thread(s).`,
        "Unchecked:",
        ...surprises.map((id) => `  ${id}`),
        "Unarchived: none",
        "Still archived:",
        ...surprises.map((id) => `  ${id}`),
        `Archived as intended: ${CREW_THREAD}`,
        "Not archived: none",
      ].join("\n"),
    );
    // Every id appears; nothing is summarised away.
    for (const id of surprises) expect(result.stderr).toContain(id);
    expect(result.stderr).not.toContain("more");
  });

  it("keeps a thread it failed to unarchive out of the archived-as-intended list", async () => {
    const { harness } = host({
      threadsArchive: (args) => ({
        ok: true,
        archivedThreadIds: [args.threadId, "thr_stuck"],
      }),
      threadsUnarchive: () => {
        throw new Error("unarchive is not permitted");
      },
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.stderr).toContain("Still archived: thr_stuck");
    expect(result.stderr).toContain(`Archived as intended: ${CREW_THREAD}`);
    // The stuck id belongs under its own heading, not among the intended ones.
    expect(result.stderr).not.toContain(
      `Archived as intended: ${CREW_THREAD}, thr_stuck`,
    );
  });

  it("never unarchives a thread bb had already archived before settle ran", async () => {
    const preArchivedFork = "thr_old_fork";
    const { harness } = host({
      threadsList: (args) => {
        const query = args as {
          sourceThreadId?: string;
          archived?: boolean;
        };
        // A hidden fork that was archived long before this settle.
        return query.archived === true && query.sourceThreadId === CREW_THREAD
          ? [{ id: preArchivedFork }]
          : [];
      },
      threadsArchive: (args) => ({
        ok: true,
        // bb's archive-all response names it again.
        archivedThreadIds: [args.threadId, preArchivedFork],
      }),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(0);
    expect(harness.sdk.callsTo("threads.unarchive")).toHaveLength(0);
  });

  it("refuses when the already-archived descendants cannot be listed", async () => {
    let next = 0;
    const { harness } = host({
      threadsList: (args) => {
        const query = args as { archived?: boolean };
        if (query.archived !== true) return [];
        return Array.from({ length: 100 }, () => ({
          id: `thr_old_${next++}`,
        }));
      },
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "settle: could not enumerate already-archived descendants",
    );
    expect(archivedIds(harness)).toEqual([]);
  });

  it("reports an unchecked thread it could not put back", async () => {
    const { harness } = host({
      threadsArchive: (args) => ({
        ok: true,
        archivedThreadIds: [args.threadId, "thr_surprise"],
      }),
      threadsUnarchive: () => {
        throw new Error("unarchive is not permitted");
      },
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unarchived: none");
    expect(result.stderr).toContain("Still archived: thr_surprise");
  });

  it("names what was archived when a later archive fails", async () => {
    const childId = "thr_child";
    const grandchildId = "thr_grandchild";
    const { harness } = host({
      threadsGet: (args) =>
        args.threadId === COMMANDER_THREAD
          ? commanderThread()
          : crewThread({ id: args.threadId, environmentId: null }),
      threadsList: pages({
        [CREW_THREAD]: [{ id: childId }],
        [childId]: [{ id: grandchildId }],
      }),
      threadsArchive: (args) => {
        if (args.threadId === childId) throw new Error("host is offline");
        return { ok: true, archivedThreadIds: [args.threadId] };
      },
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      [
        `settle ${CREW_THREAD}: archiving ${childId} failed (host is offline).`,
        `Archived: ${grandchildId}`,
        `Failed: ${childId}`,
        `Not archived: ${CREW_THREAD}`,
      ].join("\n"),
    );
  });

  it("names every archived and remaining id when an archive fails late", async () => {
    // A wide tree: twelve children, and the root's archive fails at the end.
    const childIds = Array.from({ length: 12 }, (_, i) => `thr_child_${i}`);
    const { harness } = host({
      threadsGet: (args) =>
        args.threadId === COMMANDER_THREAD
          ? commanderThread()
          : crewThread({ id: args.threadId, environmentId: null }),
      threadsList: pages({
        [CREW_THREAD]: childIds.map((id) => ({ id })),
      }),
      threadsArchive: (args) => {
        if (args.threadId === CREW_THREAD) throw new Error("host is offline");
        return { ok: true, archivedThreadIds: [args.threadId] };
      },
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      [
        `settle ${CREW_THREAD}: archiving ${CREW_THREAD} failed (host is offline).`,
        "Archived:",
        // Deepest first, so the children archived in reverse order.
        ...[...childIds].reverse().map((id) => `  ${id}`),
        `Failed: ${CREW_THREAD}`,
        "Not archived: none",
      ].join("\n"),
    );
    for (const id of childIds) expect(result.stderr).toContain(id);
  });

  it("refuses a fork with a dirty worktree before archiving anything", async () => {
    const forkId = "thr_fork";
    const { harness } = host({
      threadsGet: (args) => {
        if (args.threadId === COMMANDER_THREAD) return commanderThread();
        if (args.threadId === forkId) {
          return crewThread({ id: forkId, environmentId: "env_fork" });
        }
        return crewThread({ id: args.threadId, environmentId: null });
      },
      // A fork is linked by sourceThreadId, never by parentThreadId.
      threadsList: (args) => {
        const query = args as {
          parentThreadId?: string;
          sourceThreadId?: string;
        };
        if (query.sourceThreadId === CREW_THREAD) return [{ id: forkId }];
        return [];
      },
      environmentStatus: (args) =>
        args.environmentId === "env_fork" ? dirtyStatus() : cleanStatus(),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Refused: ${forkId} (a child of ${CREW_THREAD}) — the worktree has uncommitted changes.`,
    );
    expect(archivedIds(harness)).toEqual([]);
  });

  it("checks a fork of a child, not just a fork of the root", async () => {
    const childId = "thr_child";
    const forkId = "thr_fork";
    const { harness } = host({
      threadsGet: (args) => {
        if (args.threadId === COMMANDER_THREAD) return commanderThread();
        if (args.threadId === forkId) {
          return crewThread({ id: forkId, environmentId: "env_fork" });
        }
        return crewThread({ id: args.threadId, environmentId: null });
      },
      threadsList: (args) => {
        const query = args as {
          parentThreadId?: string;
          sourceThreadId?: string;
        };
        if (query.parentThreadId === CREW_THREAD) return [{ id: childId }];
        if (query.sourceThreadId === childId) return [{ id: forkId }];
        return [];
      },
      environmentStatus: (args) =>
        args.environmentId === "env_fork" ? dirtyStatus() : cleanStatus(),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Refused: ${forkId} (a child of ${CREW_THREAD}) — the worktree has uncommitted changes.`,
    );
    expect(archivedIds(harness)).toEqual([]);
  });

  it("refuses a thread that is not Crew under a Commander", async () => {
    const { harness } = host({
      threadsGet: () =>
        makeThreadResponse({
          id: "thr_loose",
          projectId: "proj_elsewhere",
          parentThreadId: null,
        }),
    });

    const result = await harness.runCli(["settle", "thr_loose"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "Refused: thr_loose — it is not Crew under a Commander.",
    );
    expect(archivedIds(harness)).toEqual([]);
  });

  it("refuses a Commander, which would file away the whole Base", async () => {
    const { harness } = host();

    const result = await harness.runCli(["settle", COMMANDER_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Refused: ${COMMANDER_THREAD} — it is a Commander, not Crew.`,
    );
    expect(archivedIds(harness)).toEqual([]);
  });

  it("allows a grandchild of a Commander", async () => {
    const grandchildId = "thr_grandchild";
    const { harness } = host({
      threadsGet: (args) => {
        if (args.threadId === COMMANDER_THREAD) return commanderThread();
        if (args.threadId === grandchildId) {
          return crewThread({
            id: grandchildId,
            parentThreadId: CREW_THREAD,
            environmentId: null,
          });
        }
        return crewThread({ id: args.threadId, environmentId: null });
      },
    });

    const result = await harness.runCli(["settle", grandchildId]);

    expect(result.exitCode).toBe(0);
    expect(archivedIds(harness)).toEqual([grandchildId]);
  });

  it("says --force-archive is not supported", async () => {
    const { harness } = host();

    const result = await harness.runCli([
      "settle",
      CREW_THREAD,
      "--force-archive",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("--force-archive: not supported in v1.");
    expect(archivedIds(harness)).toEqual([]);
  });
});

describe("formatSitrepRow", () => {
  it("keeps every field on one line", () => {
    expect(
      formatSitrepRow({
        threadId: "thr_1",
        title: "Title",
        status: "idle",
        pr: "none",
        worktree: "clean",
        interactions: 0,
        last: "none",
      }),
    ).toBe("thr_1 · Title · idle · pr:none · worktree:clean · interactions:0");
  });
});
