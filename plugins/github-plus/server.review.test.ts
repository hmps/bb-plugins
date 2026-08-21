// The review dialog's two rpcs: `reviewPrompt` seeds the dialog, `spawnReview`
// forwards the composer's resolved NewThreadRequest to `threads.spawn`.
//
// The forwarding is the load-bearing part: the host drops a requested
// providerId/model that carries no `executionInputSources` provenance and
// re-derives it from the project defaults, which would silently undo the
// user's pick in the dialog.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { buildReviewPrompt, buildThreadTitle } from "./server";

let binDir: string;
const originalPath = process.env.PATH;

const openPull = JSON.stringify([
  {
    number: 42,
    title: "Normalize pull details",
    state: "OPEN",
    author: { login: "bob" },
    labels: [],
    assignees: [],
    url: "https://github.com/acme/widgets/pull/42",
    body: "Normalize every GitHub shape.",
    updatedAt: "2026-08-19T13:00:00Z",
  },
]);

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "bb-github-plus-review-"));
  writeFileSync(
    join(binDir, "gh"),
    `#!/usr/bin/env bash
case "$*" in
  "--version") echo "gh version 2.96.0 (fake)";;
  "auth status --hostname github.com --active") echo "authenticated";;
  "pr list -R acme/widgets --state open"*) printf '%s\\n' '${openPull}';;
  *) printf '%s\\n' '[]';;
esac
`,
  );
  chmodSync(join(binDir, "gh"), 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
});

async function loadPlugin() {
  const host = createFakePluginHost({
    pluginId: "github-plus",
    settings: { extraRepos: "acme/widgets", defaultProject: "project-1" },
    sdk: {
      projects: { list: () => [] },
      threads: { spawn: () => ({ id: "thread-99" }) },
    },
  });
  await plugin(host.bb);
  await host.harness.callRpc("refresh");
  return host;
}

/** What `experimental_NewThreadComposer` submits, once the user has picked. */
const composerRequest = {
  projectId: "project-7",
  providerId: "anthropic",
  model: "claude-opus-4-6",
  reasoningLevel: "high",
  permissionMode: "accept-edits",
  serviceTier: "fast",
  executionInputSources: {
    providerId: "explicit",
    model: "explicit",
    reasoningLevel: "explicit",
    permissionMode: "explicit",
    serviceTier: "explicit",
  },
  environment: { type: "host", hostId: "host-1" },
  input: [{ type: "text", text: "Review this PR, but focus on the tests." }],
};

describe("review dialog rpcs", () => {
  it("seeds the dialog with the same prompt spawnOnItem would send", async () => {
    const { harness } = await loadPlugin();

    await expect(
      harness.callRpc("reviewPrompt", { repo: "acme/widgets", number: 42 }),
    ).resolves.toEqual({
      projectId: "project-1",
      title: "Normalize pull details",
      prompt: buildReviewPrompt("acme/widgets", 42, "Normalize pull details"),
    });
  });

  it("forwards every composer selection to threads.spawn unchanged", async () => {
    const { harness } = await loadPlugin();

    await expect(
      harness.callRpc("spawnReview", {
        repo: "acme/widgets",
        number: 42,
        request: composerRequest,
      }),
    ).resolves.toEqual({ threadId: "thread-99" });

    const [args] = harness.sdk.callsTo("threads.spawn");
    expect(args?.[0]).toMatchObject({
      ...composerRequest,
      title: buildThreadTitle("acme/widgets", 42, "Normalize pull details"),
    });
  });

  it("links the spawned thread to the PR", async () => {
    const { harness } = await loadPlugin();

    await harness.callRpc("spawnReview", {
      repo: "acme/widgets",
      number: 42,
      request: composerRequest,
    });

    await expect(harness.callRpc("listLinks")).resolves.toMatchObject({
      links: {
        "pr:acme/widgets#42": [
          { kind: "pr", repo: "acme/widgets", number: 42, threadId: "thread-99" },
        ],
      },
    });
  });

  it("rejects a request that is missing the provider selection", async () => {
    const { harness } = await loadPlugin();

    await expect(
      harness.callRpc("spawnReview", {
        repo: "acme/widgets",
        number: 42,
        request: { ...composerRequest, providerId: "" },
      }),
    ).rejects.toThrow();
  });
});
