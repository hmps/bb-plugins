// @vitest-environment jsdom

import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

afterEach(() => cleanup());

const columns = ["progress", "waiting", "blocked", "review", "deploy", "done"];

function board(change: Record<string, unknown> = {}) {
  return {
    project: "all",
    generatedAt: Date.now() - 5 * 60_000,
    host: "titan",
    source: "current",
    error: null,
    projects: ["fia"],
    columns: columns.map((id) => ({ id, title: id, total: 0, cards: [] })),
    ...change,
  };
}

function render(data: ReturnType<typeof board>) {
  return renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    { rpc: { board: () => data } },
  );
}

describe("Mission Queue panel", () => {
  it("shows the snapshot's age and host", async () => {
    render(board());
    expect(await screen.findByText(/^As of .+ \(5m ago\) · titan$/)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getAllByText("Empty")).toHaveLength(columns.length);
  });

  it("warns that a failed source leaves the cards incomplete", async () => {
    render(
      board({
        source: "partial",
        error: "The SITREP on titan exited 1: a source could not be read.",
      }),
    );
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain(
      "The last SITREP could not read a source. These cards are incomplete.",
    );
    expect(notice.textContent).toContain("exited 1");
    expect(screen.getAllByText("Empty")).toHaveLength(columns.length);
  });

  it("says no snapshot yet, and shows no columns", async () => {
    render(board({ source: "unavailable", generatedAt: null, host: null }));
    expect(await screen.findByText("No snapshot yet")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "No SITREP has published a snapshot yet. Run the SITREP to publish one.",
    );
    expect(screen.queryByText("Empty")).toBeNull();
  });
});
