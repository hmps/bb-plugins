// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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

function render(
  data: ReturnType<typeof board>,
  rpc: Record<string, (input: unknown) => unknown> = {},
) {
  return renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    { rpc: { board: () => data, ...rpc } },
  );
}

const GENERATED_AT = Date.now() - 5 * 60_000;
const ROOT = "thr_root";
const DECISION = { id: "d5ead93f8671645367df1271", revision: 1 };

/** A survey card waiting on a decision, as the board RPC sends it. */
function surveyCard(change: Record<string, unknown> = {}) {
  return {
    id: "sb-2",
    bead: "sb-2",
    title: "Pick a vendor",
    mission: "survey",
    project: "vaam-main",
    threadId: "thr_crew",
    threadStatus: "idle",
    pr: null,
    flags: [],
    column: "waiting",
    lifecycle: "awaiting-decision",
    stage: "Awaiting decision",
    tone: "alert",
    nextAction: "Decide",
    owner: "Commander thr_root",
    ownerIdle: true,
    attention: [
      {
        ...DECISION,
        kind: "decision",
        summary: "Which vendor?",
        fingerprint: "f".repeat(64),
        surfaced: false,
        messageRef: null as string | null,
      },
    ],
    integrity: null,
    problems: [],
    outcome: null,
    note: null,
    commanderRoot: ROOT,
    actions: [
      { kind: "go", attention: DECISION, text: "none", target: ROOT },
      { kind: "decision", attention: DECISION, text: "required", target: ROOT },
      { kind: "survey-act", attention: null, text: "optional", target: ROOT },
      { kind: "survey-defer", attention: null, text: "optional", target: ROOT },
      { kind: "survey-reject", attention: null, text: "optional", target: ROOT },
      { kind: "close", attention: null, text: "required", target: ROOT },
      { kind: "cancel", attention: null, text: "required", target: ROOT },
    ],
    actionNote: null,
    sent: [],
    ...change,
  };
}

function boardWith(card: Record<string, unknown>) {
  return board({
    generatedAt: GENERATED_AT,
    columns: columns.map((id) =>
      id === "waiting"
        ? { id, title: id, total: 1, cards: [card] }
        : { id, title: id, total: 0, cards: [] },
    ),
  });
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

describe("card actions", () => {
  it("shows the actions that fit the card, and the end ones on the open card", async () => {
    render(boardWith(surveyCard()));
    await screen.findByText("Pick a vendor");
    for (const label of ["Go", "Answer", "Act", "Defer", "Reject"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.click(screen.getByText("Pick a vendor"));
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("sends only from the confirm step, with the exact message", async () => {
    let calls = 0;
    const view = render(boardWith(surveyCard()), {
      act: () => {
        calls += 1;
        return { sent: true, target: ROOT, error: null };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Go" }));
    expect(calls).toBe(0);
    expect(screen.getByText(`· sends to ${ROOT}`, { exact: false })).toBeTruthy();
    expect(screen.getByLabelText("Message preview").textContent).toBe(
      "Board answer · Pick a vendor (sb-2)\nDecision: go\n" +
        `<!-- attention:${DECISION.id}@1#${"f".repeat(64)} -->`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls).toBe(1));
    expect(view.rpcCalls.find((call) => call.method === "act")?.input).toEqual({
      project: "all",
      bead: "sb-2",
      kind: "go",
      text: "",
      attention: DECISION,
      generatedAt: GENERATED_AT,
    });
    // The board loads again to show the sent state.
    await waitFor(() =>
      expect(
        view.rpcCalls.filter((call) => call.method === "board"),
      ).toHaveLength(2),
    );
  });

  it("needs the text a required action asks for, and goes back without a send", async () => {
    const view = render(boardWith(surveyCard()));
    fireEvent.click(await screen.findByRole("button", { name: "Answer" }));
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Your answer"), {
      target: { value: "Vendor B" },
    });
    expect(send.disabled).toBe(false);
    expect(screen.getByLabelText("Message preview").textContent).toContain(
      "Decision: Vendor B",
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(view.rpcCalls.some((call) => call.method === "act")).toBe(false);
  });

  it("shows a refusal from the server in the confirm step", async () => {
    render(boardWith(surveyCard()), {
      act: () => ({
        sent: false,
        target: null,
        error: "The board changed since you loaded it. Refresh, then try again.",
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Act" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The board changed since you loaded it. Refresh, then try again.",
    );
  });

  it("shows a sent answer as waiting, and why a card has no actions", async () => {
    render(
      boardWith(
        surveyCard({
          actions: [],
          actionNote:
            "No board actions: the snapshot names no Commander thread to answer.",
          sent: [
            { kind: "go", attention: DECISION, line: "Decision: go", sentAt: 1 },
          ],
        }),
      ),
    );
    expect(
      await screen.findByText(
        "Sent, waiting for the Commander: Decision: go",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "No board actions: the snapshot names no Commander thread to answer.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Go" })).toBeNull();
  });

  it("shows the Commander's question on the open card", async () => {
    const surfaced = surveyCard();
    surfaced.attention[0] = {
      ...surfaced.attention[0]!,
      surfaced: true,
      messageRef: `@thread:${ROOT}#msg=4`,
    };
    render(boardWith(surfaced), {
      question: () => ({
        text: "Vendor A or vendor B?",
        threadId: ROOT,
        error: null,
      }),
    });
    fireEvent.click(await screen.findByText("Pick a vendor"));
    expect(await screen.findByText("Vendor A or vendor B?")).toBeTruthy();
  });
});
