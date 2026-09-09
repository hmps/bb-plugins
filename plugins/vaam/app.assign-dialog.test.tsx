// @vitest-environment jsdom

// "Assign agent" must open bb's own new-thread composer, seeded from the
// `beadPrompt` rpc, and create the thread through `spawnForBead` — never
// through a hand-rolled prompt box.
import { describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

const bead = {
  id: "vaam-27c.1",
  title: "Retry the flaky uploader",
  description: "Retry with backoff.",
  status: "in_progress",
  priority: 0,
  issueType: "task",
  assignee: "Hampus Persson",
  labels: [],
  parentId: null,
  blockedBy: [],
  createdAt: "2026-08-03T00:00:00Z",
  updatedAt: "2026-08-04T00:00:00Z",
  closedAt: null,
};

const detail = {
  ...bead,
  design: "",
  acceptanceCriteria: "No 5xx for a week.",
  notes: "",
  dependencies: [],
};

const PROMPT = "Work on bead vaam-27c.1: Retry the flaky uploader";

function render(overrides: Record<string, unknown> = {}) {
  return renderSlot(
    app.navPanels[0]!,
    { subPath: `beads/${bead.id}` },
    {
      rpc: {
        listBeads: () => ({
          root: "/tmp/beads-root",
          projectId: "proj_vaam",
          beads: [bead],
        }),
        getBead: () => ({ bead: detail }),
        beadPrompt: () => ({ projectId: "proj_vaam", prompt: PROMPT }),
        spawnForBead: () => ({ threadId: "thr-99" }),
        ...overrides,
      },
    },
  );
}

describe("Assign agent", () => {
  it("registers one Vaam nav panel", () => {
    expect(app.navPanels).toHaveLength(1);
    expect(app.navPanels[0]).toMatchObject({ id: "vaam", path: "vaam" });
  });

  it("mounts the host composer with the seeded prompt", async () => {
    const beadPrompt = vi.fn(() => ({
      projectId: "proj_vaam",
      prompt: PROMPT,
    }));
    const slot = render({ beadPrompt });

    (await slot.findByRole("button", { name: "Assign agent" })).click();

    const composer = await slot.findByTestId("bb-new-thread-composer");
    expect(beadPrompt).toHaveBeenCalledTimes(1);
    expect(composer.getAttribute("data-default-project-id")).toBe("proj_vaam");
    expect(composer.getAttribute("data-draft-key")).toBe(
      "vaam:bead:vaam-27c.1",
    );
    const input = slot.getByTestId(
      "bb-new-thread-composer-input",
    ) as HTMLTextAreaElement;
    expect(input.value).toBe(PROMPT);

    slot.lifecycle.unmount();
  });

  it("spawns through spawnForBead and opens the thread", async () => {
    const spawnForBead = vi.fn((_input: { id: string }) => ({
      threadId: "thr-99",
    }));
    const slot = render({ spawnForBead });

    (await slot.findByRole("button", { name: "Assign agent" })).click();
    (await slot.findByTestId("bb-new-thread-composer-submit")).click();

    await vi.waitFor(() => expect(spawnForBead).toHaveBeenCalledTimes(1));
    expect(spawnForBead.mock.calls[0]?.[0]).toMatchObject({ id: bead.id });
    await vi.waitFor(() =>
      expect(slot.navigateCalls).toContainEqual({
        method: "toThread",
        threadId: "thr-99",
      }),
    );

    slot.lifecycle.unmount();
  });
});
