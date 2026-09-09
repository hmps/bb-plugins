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
  threadsSend?: (args: unknown) => unknown;
  commanderProjectIds?: string;
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
        get: options.threadsGet ?? (() => commanderThread()),
        list: options.threadsList ?? (() => []),
        send: options.threadsSend ?? (() => ({ ok: true, delivery: "sent" })),
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

    const [args] = harness.sdk.callsTo("threads.send")[0] as [
      { mode: string },
    ];
    expect(args.mode).toBe("queue-if-active");
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
  it("refuses a dirty worktree and archives nothing", async () => {
    const { harness } = host({
      threadsGet: () => crewThread(),
      environmentStatus: () => dirtyStatus(),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Refused: ${CREW_THREAD} — the worktree has uncommitted changes.`,
    );
    expect(harness.sdk.callsTo("threads.archiveAll")).toHaveLength(0);
  });

  it("refuses an open pull request", async () => {
    const { harness } = host({
      threadsGet: () => crewThread(),
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
    expect(harness.sdk.callsTo("threads.archiveAll")).toHaveLength(0);
  });

  it("refuses a worktree status bb could not read", async () => {
    const { harness } = host({
      threadsGet: () => crewThread(),
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
    expect(harness.sdk.callsTo("threads.archiveAll")).toHaveLength(0);
  });

  it("refuses a pull request state bb could not read", async () => {
    const { harness } = host({
      threadsGet: () => crewThread(),
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
    expect(harness.sdk.callsTo("threads.archiveAll")).toHaveLength(0);
  });

  it("allows a non-git environment, which has no worktree to lose", async () => {
    const { harness } = host({
      threadsGet: () => crewThread(),
      environmentStatus: () => ({
        outcome: "not_applicable",
        reason: "non_git_environment",
        message: "this environment is not a git repository",
      }),
      archiveAll: () => ({ ok: true, archivedThreadIds: [CREW_THREAD] }),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(0);
    expect(harness.sdk.callsTo("threads.archiveAll")).toHaveLength(1);
  });

  it("allows a thread that has no environment at all", async () => {
    const { harness } = host({
      threadsGet: () => crewThread({ environmentId: null }),
      archiveAll: () => ({ ok: true, archivedThreadIds: [CREW_THREAD] }),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(0);
    expect(harness.sdk.callsTo("threads.archiveAll")).toHaveLength(1);
  });

  it("allows an environment that simply has no pull request", async () => {
    const { harness } = host({
      threadsGet: () => crewThread(),
      environmentPullRequest: () => ({ outcome: "absent" }),
      archiveAll: () => ({ ok: true, archivedThreadIds: [CREW_THREAD] }),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(0);
    expect(harness.sdk.callsTo("threads.archiveAll")).toHaveLength(1);
  });

  it("refuses when a child in the tree is unsafe, naming that child", async () => {
    const childId = "thr_child";
    const { harness } = host({
      threadsGet: (args) =>
        args.threadId === childId
          ? crewThread({ id: childId, environmentId: "env_child" })
          : crewThread(),
      threadsList: (args) => {
        const parentThreadId = (args as { parentThreadId: string })
          .parentThreadId;
        if (parentThreadId === CREW_THREAD) return [{ id: childId }];
        return [];
      },
      // The root is clean; only the child's worktree is dirty.
      environmentStatus: (args) =>
        args.environmentId === "env_child" ? dirtyStatus() : cleanStatus(),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Refused: ${childId} (a child of ${CREW_THREAD}) — the worktree has uncommitted changes.`,
    );
    expect(harness.sdk.callsTo("threads.archiveAll")).toHaveLength(0);
  });

  it("refuses when a grandchild in the tree has an open pull request", async () => {
    const childId = "thr_child";
    const grandchildId = "thr_grandchild";
    const { harness } = host({
      threadsGet: (args) => {
        if (args.threadId === childId) {
          return crewThread({ id: childId, environmentId: "env_child" });
        }
        if (args.threadId === grandchildId) {
          return crewThread({ id: grandchildId, environmentId: "env_grand" });
        }
        return crewThread();
      },
      threadsList: (args) => {
        const parentThreadId = (args as { parentThreadId: string })
          .parentThreadId;
        if (parentThreadId === CREW_THREAD) return [{ id: childId }];
        if (parentThreadId === childId) return [{ id: grandchildId }];
        return [];
      },
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
    expect(harness.sdk.callsTo("threads.archiveAll")).toHaveLength(0);
  });

  it("archives the tree when every thread in it is safe", async () => {
    const childId = "thr_child";
    const { harness } = host({
      threadsGet: (args) =>
        args.threadId === childId
          ? crewThread({ id: childId, environmentId: null })
          : crewThread(),
      threadsList: (args) => {
        const parentThreadId = (args as { parentThreadId: string })
          .parentThreadId;
        return parentThreadId === CREW_THREAD ? [{ id: childId }] : [];
      },
      environmentPullRequest: () => ({
        outcome: "available",
        pullRequest: {
          url: "https://github.com/hmps/bb-plugins/pull/9",
          state: "merged",
        },
      }),
      archiveAll: () => ({
        ok: true,
        archivedThreadIds: [CREW_THREAD, childId],
      }),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`Settled ${CREW_THREAD}: archived 2 thread(s).`);
    expect(harness.sdk.callsTo("threads.archiveAll")).toEqual([
      [{ threadId: CREW_THREAD }],
    ]);
  });

  it("says --force-archive is not supported", async () => {
    const { harness } = host({ threadsGet: () => crewThread() });

    const result = await harness.runCli([
      "settle",
      CREW_THREAD,
      "--force-archive",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("--force-archive: not supported in v1.");
    expect(harness.sdk.callsTo("threads.archiveAll")).toHaveLength(0);
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
