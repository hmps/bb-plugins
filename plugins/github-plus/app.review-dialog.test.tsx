// @vitest-environment jsdom

// "Review with agent" must open the review dialog and seed it from the
// `reviewPrompt` rpc, instead of spawning a thread on the first click.
import { describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

const pull = {
  repo: "get-bb/bb",
  number: 42,
  title: "Navigation fix",
  state: "OPEN",
  author: "octocat",
  body: "",
  url: "https://github.com/get-bb/bb/pull/42",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  baseRefName: "main",
  headRefName: "fix-navigation",
  additions: 1,
  deletions: 1,
  changedFiles: 0,
  labels: [],
  assignees: [],
  reviewDecision: "",
  mergeStateStatus: "CLEAN",
  reviewRequests: [],
  checks: [],
  comments: [],
  reviews: [],
  reviewThreads: [],
  files: [],
};

describe("Review with agent", () => {
  it("opens the review dialog and seeds it from reviewPrompt", async () => {
    const reviewPrompt = vi.fn(() => ({
      prompt: "Review GitHub pull request get-bb/bb#42: Navigation fix",
      projectId: "project-1",
      title: "Navigation fix",
    }));
    const startReview = vi.fn(() => ({ threadId: "thr-never" }));

    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr-1", params: null },
      {
        rpc: {
          pullForThread: () => ({
            pull: { repo: "get-bb/bb", number: 42, environmentId: "env-1" },
          }),
          getPull: () => ({ pull }),
          listLinks: () => ({ links: {} }),
          reviewPrompt,
          startReview,
        },
      },
    );

    await slot.findByText("Navigation fix");
    expect(reviewPrompt).not.toHaveBeenCalled();

    slot.getByRole("button", { name: "Review with agent" }).click();

    await vi.waitFor(() => expect(reviewPrompt).toHaveBeenCalledTimes(1));
    // The legacy one-click spawn must not fire from the dialog entry point.
    expect(startReview).not.toHaveBeenCalled();
    slot.lifecycle.unmount();
  });
});
