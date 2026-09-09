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

function commanderThread() {
  return makeThreadResponse({
    id: COMMANDER_THREAD,
    projectId: COMMANDER_PROJECT,
    parentThreadId: null,
  });
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
        send: () => ({ ok: true, delivery: "sent" }),
        archiveAll:
          options.archiveAll ?? (() => ({ ok: true, archivedThreadIds: [] })),
        interactions: {
          list: options.interactionsList ?? (() => []),
        },
      },
      environments: {
        status:
          options.environmentStatus ??
          (() => ({
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
          })),
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
    expect(harness.sdk.callsTo("threads.get")).toHaveLength(2);

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

    await harness.emitThreadEvent("interaction.pending", {
      thread: makeThreadResponse({
        id: COMMANDER_THREAD,
        projectId: COMMANDER_PROJECT,
        parentThreadId: "thr_grandparent",
      }),
      interaction: approvalInteraction("int_1"),
    });

    expect(harness.sdk.callsTo("threads.send")).toHaveLength(0);
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

    const result = await harness.runCli([
      "sitrep",
      "--commander",
      COMMANDER_THREAD,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("last:idle");
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
      `${CREW_THREAD} · Build the Sentinel · active · pr:https://github.com/hmps/bb-plugins/pull/9 open · worktree:clean · interactions:1 · last:none`,
    );
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
      environmentStatus: () => ({
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
      }),
    });

    const result = await harness.runCli(["settle", CREW_THREAD]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Refused: ${CREW_THREAD} has uncommitted changes on its worktree.`,
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
    expect(result.stderr).toContain("still has an open pull request");
    expect(harness.sdk.callsTo("threads.archiveAll")).toHaveLength(0);
  });

  it("archives the thread tree when the worktree is clean and the PR is merged", async () => {
    const { harness } = host({
      threadsGet: () => crewThread(),
      environmentPullRequest: () => ({
        outcome: "available",
        pullRequest: {
          url: "https://github.com/hmps/bb-plugins/pull/9",
          state: "merged",
        },
      }),
      archiveAll: () => ({
        ok: true,
        archivedThreadIds: [CREW_THREAD, "thr_grandchild"],
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
    ).toBe("thr_1 · Title · idle · pr:none · worktree:clean · interactions:0 · last:none");
  });
});
