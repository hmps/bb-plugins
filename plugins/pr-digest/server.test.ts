import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import plugin, { inferBuildTriggerId } from "./server";

const LIVE_SHA = "a".repeat(40);
const TARGET_SHA = "b".repeat(40);
const OTHER_SHA = "c".repeat(40);

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

interface RunnerOptions {
  commits?: string[];
  trigger?: "immediate" | "pending";
  onTrigger?: (callback: ExecCallback) => void;
  onFirstCompare?: () => void;
}

function installRunner({
  commits = [TARGET_SHA],
  trigger = "immediate",
  onTrigger,
  onFirstCompare,
}: RunnerOptions = {}) {
  execFileMock.mockReset();
  let currentCommits = commits;
  let compareCount = 0;
  let heldCompare: ExecCallback | undefined;
  execFileMock.mockImplementation(
    (_bin: string, args: string[], _options: unknown, callback: ExecCallback) => {
      const json = (value: unknown) => callback(null, JSON.stringify(value), "");
      if (args[0] === "run" && args[1] === "services") {
        json({
          status: {
            traffic: [{ revisionName: "vaam-web-build-live-build", percent: 100 }],
          },
        });
        return;
      }
      if (args[0] === "run" && args[1] === "revisions") {
        json([
          {
            metadata: {
              name: "vaam-web-build-live-build",
              creationTimestamp: "2026-01-01T00:00:00Z",
            },
            status: { conditions: [{ type: "Ready", status: "True" }] },
          },
        ]);
        return;
      }
      if (args[0] === "builds" && args[1] === "list") {
        json([
          {
            id: "live-build",
            buildTriggerId: "inferred-trigger",
            status: "SUCCESS",
            createTime: "2026-01-01T00:00:00Z",
            substitutions: { COMMIT_SHA: LIVE_SHA, REPO_NAME: "vaam" },
            steps: [{ args: ["gcloud run deploy vaam-web --region=europe-west1"] }],
          },
        ]);
        return;
      }
      if (args[0] === "builds" && args[1] === "triggers") {
        if (trigger === "pending") {
          onTrigger?.(callback);
          return;
        }
        json({});
        return;
      }
      if (args[0] === "api" && args[1]?.includes("/compare/")) {
        compareCount += 1;
        if (compareCount === 1 && onFirstCompare) {
          heldCompare = callback;
          onFirstCompare();
          return;
        }
        json({
          ahead_by: currentCommits.length,
          commits: currentCommits.map((sha) => ({
            sha,
            html_url: `https://github.com/vaam-io/vaam/commit/${sha}`,
            author: { login: "octo" },
            commit: {
              message: "Release candidate",
              author: { name: "Octo" },
              committer: { date: "2026-01-02T00:00:00Z" },
            },
          })),
        });
        return;
      }
      if (args[0] === "api" && args[1]?.includes("/commits/")) {
        json({
          sha: LIVE_SHA,
          html_url: `https://github.com/vaam-io/vaam/commit/${LIVE_SHA}`,
          author: { login: "octo" },
          commit: { message: "Live", author: { name: "Octo" } },
        });
        return;
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    },
  );
  return {
    setCommits(next: string[]) {
      currentCommits = next;
    },
    resolveFirstCompare(commitsForResponse: string[]) {
      const callback = heldCompare;
      heldCompare = undefined;
      callback?.(
        null,
        JSON.stringify({
          ahead_by: commitsForResponse.length,
          commits: commitsForResponse.map((sha) => ({
            sha,
            html_url: `https://github.com/vaam-io/vaam/commit/${sha}`,
            author: { login: "octo" },
            commit: {
              message: "Release candidate",
              author: { name: "Octo" },
              committer: { date: "2026-01-02T00:00:00Z" },
            },
          })),
        }),
        "",
      );
    },
  };
}

function triggerCalls(): unknown[][] {
  return execFileMock.mock.calls.filter(
    ([, args]: [string, string[]]) =>
      args[0] === "builds" && args[1] === "triggers" && args[2] === "run",
  );
}

async function setup(settings: Record<string, string> = {}) {
  const host = createFakePluginHost({ pluginId: "pr-digest", settings });
  await plugin(host.bb);
  return host;
}

describe("startBuild", () => {
  it("rejects a malformed SHA before dispatch", async () => {
    installRunner();
    const { harness } = await setup();

    await expect(
      harness.behavior.callRpc("startBuild", { sha: "not-a-full-sha" }),
    ).rejects.toThrow(/rpc input validation failed/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("does not dispatch a valid SHA missing from the current unreleased list", async () => {
    installRunner({ commits: [OTHER_SHA] });
    const { harness } = await setup();

    await expect(
      harness.behavior.callRpc("startBuild", { sha: TARGET_SHA }),
    ).rejects.toThrow(/no longer in the current unreleased list/);
    expect(triggerCalls()).toHaveLength(0);
  });

  it("uses an explicit trigger over the inferred trigger with the exact argv", async () => {
    installRunner();
    const { harness } = await setup({ buildTrigger: "explicit-trigger" });

    await expect(
      harness.behavior.callRpc("startBuild", { sha: TARGET_SHA }),
    ).resolves.toEqual({ sha: TARGET_SHA, triggerId: "explicit-trigger" });
    expect(triggerCalls()).toHaveLength(1);
    expect(triggerCalls()[0]?.[1]).toEqual([
      "builds",
      "triggers",
      "run",
      "explicit-trigger",
      `--sha=${TARGET_SHA}`,
      "--region",
      "global",
      "--project",
      "vaam-286504",
      "--quiet",
      "--format=json",
    ]);
  });

  it("uses the configured trigger region independently of the build region", async () => {
    installRunner();
    const { harness } = await setup({ buildTriggerRegion: "us-central1" });

    await harness.behavior.callRpc("startBuild", { sha: TARGET_SHA });

    expect(triggerCalls()[0]?.[1]).toContain("us-central1");
    expect(triggerCalls()[0]?.[1]).not.toContain("europe-west1");
  });

  it("shares concurrent requests for the same SHA", async () => {
    let resolveTriggerStarted: (() => void) | undefined;
    const triggerStarted = new Promise<void>((resolve) => {
      resolveTriggerStarted = resolve;
    });
    let triggerCallback: ExecCallback | undefined;
    installRunner({
      trigger: "pending",
      onTrigger(callback) {
        triggerCallback = callback;
        resolveTriggerStarted?.();
      },
    });
    const { harness } = await setup();

    const first = harness.behavior.callRpc("startBuild", { sha: TARGET_SHA });
    await triggerStarted;
    const second = harness.behavior.callRpc("startBuild", { sha: TARGET_SHA });
    expect(triggerCalls()).toHaveLength(1);
    triggerCallback?.(null, "{}", "");

    await expect(Promise.all([first, second])).resolves.toEqual([
      { sha: TARGET_SHA, triggerId: "inferred-trigger" },
      { sha: TARGET_SHA, triggerId: "inferred-trigger" },
    ]);
  });

  it("scopes cooldown results to build settings but preserves unrelated-setting retries", async () => {
    installRunner();
    const { harness } = await setup();

    await harness.behavior.callRpc("startBuild", { sha: TARGET_SHA });
    await harness.behavior.callRpc("startBuild", { sha: TARGET_SHA });
    expect(triggerCalls()).toHaveLength(1);

    await harness.behavior.setSettings({ hideOwnOpen: true });
    await harness.behavior.callRpc("startBuild", { sha: TARGET_SHA });
    expect(triggerCalls()).toHaveLength(1);

    await harness.behavior.setSettings({ buildTrigger: "new-explicit-trigger" });
    await expect(
      harness.behavior.callRpc("startBuild", { sha: TARGET_SHA }),
    ).resolves.toEqual({ sha: TARGET_SHA, triggerId: "new-explicit-trigger" });
    expect(triggerCalls()).toHaveLength(2);
  });

  it("authorizes against an independent fresh lookup, not a cached refresh in flight", async () => {
    let signalHeldCompare: (() => void) | undefined;
    const firstCompareHeld = new Promise<void>((resolve) => {
      signalHeldCompare = resolve;
    });
    const runner = installRunner({
      commits: [TARGET_SHA],
      onFirstCompare() {
        signalHeldCompare?.();
      },
    });
    const { harness } = await setup();

    const displayRefresh = harness.behavior.callRpc("release", { force: true });
    await firstCompareHeld;
    runner.setCommits([OTHER_SHA]);

    await expect(
      harness.behavior.callRpc("startBuild", { sha: TARGET_SHA }),
    ).rejects.toThrow(/no longer in the current unreleased list/);
    expect(triggerCalls()).toHaveLength(0);

    runner.resolveFirstCompare([TARGET_SHA]);
    await expect(displayRefresh).resolves.toMatchObject({
      unreleased: [{ sha: TARGET_SHA }],
    });
  });
});

describe("inferBuildTriggerId", () => {
  it("requires exact service and region evidence before inferring", () => {
    const deploy = (id: string, triggerId: string, extra = {}) => ({
      id,
      buildTriggerId: triggerId,
      substitutions: { COMMIT_SHA: LIVE_SHA, REPO_NAME: "vaam", ...extra },
      steps: [{ args: ["gcloud run deploy vaam-web --region=europe-west1"] }],
    });

    expect(
      inferBuildTriggerId(
        [deploy("one", "trigger-one"), deploy("two", "trigger-two")],
        "vaam-web",
        "europe-west1",
        "vaam-io/vaam",
      ),
    ).toBeNull();
    expect(
      inferBuildTriggerId(
        [
          {
            ...deploy("service-prefix", "wrong"),
            steps: [
              { args: ["gcloud run deploy vaam-web-admin --region=europe-west1"] },
            ],
          },
          {
            ...deploy("no-region", "wrong"),
            steps: [{ args: ["gcloud run deploy vaam-web"] }],
          },
          deploy("wrong-repo", "wrong", { REPO_NAME: "another-repo" }),
          {
            ...deploy("wrong-region", "wrong"),
            steps: [{ args: ["gcloud run deploy vaam-web --region=us-central1"] }],
          },
          deploy("right", "right"),
        ],
        "vaam-web",
        "europe-west1",
        "vaam-io/vaam",
      ),
    ).toBe("right");
  });
});
