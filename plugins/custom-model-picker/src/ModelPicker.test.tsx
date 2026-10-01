// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ExperimentalComposerSelection, PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

type ModelsArgs = Parameters<PluginBrowserBbSdk["providers"]["models"]>[0];
type ModelsResult = Awaited<ReturnType<PluginBrowserBbSdk["providers"]["models"]>>;
type Provider = ModelsResult["providers"][number];
type Model = ModelsResult["models"][number];

// The harness composer echoes each request and keeps no state. This wrapper
// keeps the settled selection, like the host composer, so a read returns the
// current model and reasoning level. `settle` lets a test change the result.
const composerState = vi.hoisted(() => ({
  selection: {} as ExperimentalComposerSelection,
  settle: (next: ExperimentalComposerSelection) => next,
}));

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  type Composer = ReturnType<typeof actual.useComposer>;
  const wrapped = new WeakMap<Composer, Composer>();
  return {
    ...actual,
    useComposer() {
      const composer = actual.useComposer();
      let stateful = wrapped.get(composer);
      if (!stateful) {
        stateful = {
          ...composer,
          async experimental_setSelection(request) {
            // The harness records the request and applies its scope rules.
            const accepted = await composer.experimental_setSelection(request);
            const defined = Object.fromEntries(
              Object.entries(accepted).filter(([, value]) => value !== undefined),
            );
            composerState.selection = composerState.settle({
              ...composerState.selection,
              ...defined,
            });
            return { ...composerState.selection };
          },
        };
        wrapped.set(composer, stateful);
      }
      return stateful;
    },
  };
});

afterEach(cleanup);

beforeEach(() => {
  composerState.selection = { providerId: "claude-code", model: "opus", reasoningLevel: "high" };
  composerState.settle = (next) => next;
});

const efforts = (...levels: string[]) =>
  levels.map((reasoningEffort) => ({ reasoningEffort, description: `${reasoningEffort} effort` }));

const CATALOG: Record<string, Partial<Model>[]> = {
  "claude-code": [
    {
      model: "opus",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: efforts("low", "medium", "high", "xhigh", "max", "ultra"),
    } as Partial<Model>,
    {
      model: "sonnet",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: efforts("low", "medium", "high"),
    } as Partial<Model>,
  ],
  codex: [{ model: "gpt", defaultReasoningEffort: "medium", supportedReasoningEfforts: [] } as Partial<Model>],
};

function fakeModels(args: ModelsArgs = {}): Promise<ModelsResult> {
  const providers = [
    {
      id: "claude-code",
      displayName: "Claude Code",
      available: true,
      logoUrl: "https://example.test/claude.svg",
      reasoningLevels: [{ id: "xhigh", label: "Very High" }],
    },
    { id: "codex", displayName: "Codex", available: true, icon: { glyph: "Bot" } },
    { id: "offline", displayName: "Offline", available: false },
  ] as Provider[];
  const models = args.providerId ? (CATALOG[args.providerId] ?? []) : [];
  return Promise.resolve({
    modelLoadError: null,
    permissionCeiling: "full",
    providers,
    models: models.map(
      (model) => ({ ...model, displayName: model.model!.toUpperCase() }) as Model,
    ),
    selectedOnlyModels: [],
  });
}

async function renderPicker(
  settings: Record<string, string> = {},
  rpc: Parameters<typeof renderSlot>[2] extends infer O ? O extends { rpc?: infer R } ? R : never : never = {},
) {
  const app = await loadPluginApp(() => import("../app"));
  const action = app.composerCustomizations[0]!.actions![0]!;
  return renderSlot(action, {}, {
    settings,
    rpc,
    composer: { scope: { kind: "new-thread", projectId: "p1" } },
    sdk: { providers: { models: fakeModels } },
  });
}

function trigger() {
  return screen.getByRole("button", { name: /^Model:/ });
}

async function openMenu() {
  fireEvent.click(trigger());
  return screen.findByRole("dialog", { name: "Model and reasoning" });
}

const frame = () => new Promise((resolve) => setTimeout(resolve, 16));

// A stand-in for the bb 0.44.0 mobile follow-up composer. One frame after the
// editor blurs, it keeps its layout if the editor has focus again or a popup
// trigger in the composer is expanded. Otherwise it collapses (the host waits
// for the keyboard to close first, with no second check), and the compact
// layout unmounts the composer actions. jsdom has no `isContentEditable`, so
// a textarea stands in for the ProseMirror editor.
function mountMobileEditor(slot: Awaited<ReturnType<typeof renderPicker>>) {
  const editor = document.createElement("textarea");
  editor.setAttribute("aria-label", "Message");
  document.body.prepend(editor);
  const state = { collapsed: false };
  editor.addEventListener("focusout", () => {
    void frame().then(() => {
      if (state.collapsed || document.activeElement === editor) return;
      if (slot.container.querySelector('[aria-haspopup][aria-expanded="true"]')) return;
      state.collapsed = true;
      slot.unmount();
    });
  });
  editor.focus();
  return { editor, state };
}

// A touch tap in iOS WebKit order: pointerdown, pointerup, the compatibility
// mousedown, then click. WebKit sends the mousedown also when pointerdown was
// canceled. Unless the mousedown is canceled, it moves focus: into an input,
// or else to the body. The click comes two frames later, after the host's
// one-frame blur check. Returns true if the mousedown moved focus.
async function tap(element: HTMLElement) {
  const touch = { pointerType: "touch", button: 0, isPrimary: true };
  fireEvent.pointerDown(element, touch);
  fireEvent.pointerUp(element, touch);
  const focusMoves = fireEvent.mouseDown(element, { button: 0 });
  if (focusMoves) {
    if (element instanceof HTMLInputElement) element.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  }
  fireEvent.mouseUp(element, { button: 0 });
  await frame();
  await frame();
  if (element.isConnected) fireEvent.click(element);
  return focusMoves;
}

function filterInput(menu: HTMLElement) {
  return within(menu).getByRole("searchbox", { name: "Filter models" }) as HTMLInputElement;
}

function type(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

function onlyReads(selections: readonly object[]) {
  return selections.every((selection) => Object.keys(selection).length === 0);
}

function modelNames(container: HTMLElement) {
  return Array.from(container.querySelectorAll("[data-model-key]")).map(
    (row) => row.getAttribute("data-model-key"),
  );
}

describe("ModelPicker", () => {
  it("reads the selection without changing it and shows only allowlisted models", async () => {
    const slot = await renderPicker({ models: "codex/gpt\nclaude-code/opus" });

    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe(
      "Model: OPUS. Reasoning: High",
    ));
    // Mount sends only empty selections: a read, not a pick.
    expect(slot.inspection.composer.selections.length).toBeGreaterThan(0);
    expect(slot.inspection.composer.selections.every((s) => Object.keys(s).length === 0)).toBe(
      true,
    );
    // The unavailable provider is never queried.
    expect(
      slot.inspection.sdkCalls.some(
        (call) => (call.args[0] as ModelsArgs)?.providerId === "offline",
      ),
    ).toBe(false);

    const menu = await openMenu();
    await waitFor(() => expect(modelNames(menu)).toEqual(["codex/gpt", "claude-code/opus"]));
  });

  it("shows the BB provider icon in the trigger and the group labels", async () => {
    await renderPicker({ models: "claude-code/opus, codex/gpt" });
    await waitFor(() =>
      expect(
        trigger().querySelector("[data-provider-id]")?.getAttribute("data-provider-logo"),
      ).toBe("https://example.test/claude.svg"),
    );
    const icon = trigger().querySelector("[data-provider-id]")!;
    expect(icon.getAttribute("data-provider-kind")).toBe("agent");

    const menu = await openMenu();
    const codex = await within(menu).findByRole("group", { name: "Codex" });
    expect(codex.querySelector("[data-provider-id]")?.getAttribute("data-provider-glyph")).toBe(
      "Bot",
    );
  });

  it("is a popup trigger that reports its open state", async () => {
    await renderPicker();
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    await openMenu();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("opens from a touch tap without a blur of the mobile editor", async () => {
    const slot = await renderPicker();
    const { editor, state } = mountMobileEditor(slot);
    await waitFor(() => expect(trigger().textContent).toContain("OPUS"));

    expect(await tap(trigger())).toBe(false);
    expect(state.collapsed).toBe(false);
    const menu = await screen.findByRole("dialog", { name: "Model and reasoning" });
    expect(document.activeElement).toBe(editor);

    // A model tap also keeps the editor focused, and the pick closes the menu.
    expect(await tap(await within(menu).findByRole("button", { name: "SONNET" }))).toBe(false);
    await waitFor(() => expect(trigger().textContent).toContain("SONNET"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await frame();
    await frame();
    expect(state.collapsed).toBe(false);
    expect(document.activeElement).toBe(editor);
    expect(slot.inspection.composer.submits).toEqual([]);
    editor.remove();
  });

  it("keeps the mobile editor focused for reasoning and star taps", async () => {
    const setFavorites = vi.fn(async (input: unknown) => input as { keys: string[] });
    const slot = await renderPicker({}, { setFavorites });
    const { editor, state } = mountMobileEditor(slot);
    await tap(trigger());
    const menu = await screen.findByRole("dialog", { name: "Model and reasoning" });

    expect(await tap(await within(menu).findByRole("radio", { name: "Low" }))).toBe(false);
    await waitFor(() =>
      expect(slot.inspection.composer.selections.at(-1)).toEqual({ reasoningLevel: "low" }),
    );
    expect(await tap(within(menu).getByRole("button", { name: "Add OPUS to favorites" }))).toBe(
      false,
    );
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    expect(state.collapsed).toBe(false);
    expect(document.activeElement).toBe(editor);
    expect(slot.inspection.composer.submits).toEqual([]);
    editor.remove();
  });

  it("cancels the compatibility mousedown only after a touch pointerdown", async () => {
    await renderPicker({ models: "claude-code/opus" });
    const menu = await openMenu();
    type(filterInput(menu), "o");
    const touch = { pointerType: "touch", button: 0 };
    const mouse = { pointerType: "mouse", button: 0 };
    const controls = [
      trigger(),
      await within(menu).findByRole("button", { name: "OPUS" }),
      within(menu).getByRole("button", { name: "Add OPUS to favorites" }),
      within(menu).getByRole("radio", { name: "Low" }),
      within(menu).getByRole("button", { name: "Clear filter" }),
    ];
    for (const control of controls) {
      // Touch: WebKit sends the mousedown after a canceled pointerdown.
      expect(fireEvent.pointerDown(control, touch)).toBe(false);
      expect(fireEvent.mouseDown(control, { button: 0 })).toBe(false);
      // The touch mark cancels one mousedown only.
      expect(fireEvent.mouseDown(control, { button: 0 })).toBe(true);
      // Mouse: nothing is canceled, so a click focuses the control as usual.
      expect(fireEvent.pointerDown(control, mouse)).toBe(true);
      expect(fireEvent.mouseDown(control, { button: 0 })).toBe(true);
      // A touch that sends no mousedown (a scroll) does not cancel a later
      // mouse press.
      fireEvent.pointerDown(control, touch);
      fireEvent.pointerCancel(control, touch);
      expect(fireEvent.pointerDown(control, mouse)).toBe(true);
      expect(fireEvent.mouseDown(control, { button: 0 })).toBe(true);
    }
    // The filter input has no guard: a touch focuses it.
    expect(fireEvent.pointerDown(filterInput(menu), touch)).toBe(true);
    expect(fireEvent.mouseDown(filterInput(menu), { button: 0 })).toBe(true);
  });

  it("keeps the default focus behavior for mouse and keyboard", async () => {
    await renderPicker();
    expect(fireEvent.pointerDown(trigger(), { pointerType: "mouse", button: 0 })).toBe(true);
    expect(fireEvent.mouseDown(trigger(), { button: 0 })).toBe(true);

    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "Enter" });
    fireEvent.click(trigger());
    const menu = await screen.findByRole("dialog", { name: "Model and reasoning" });
    // The open moves focus to the filter, and Escape returns it to the trigger.
    await waitFor(() => expect(document.activeElement).toBe(filterInput(menu)));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it("accepts a deliberate touch focus in the filter without a collapse", async () => {
    const slot = await renderPicker({ models: "claude-code/opus, codex/gpt, claude-code/sonnet" });
    const { editor, state } = mountMobileEditor(slot);
    await waitFor(() => expect(trigger().textContent).toContain("OPUS"));
    await tap(trigger());
    const menu = await screen.findByRole("dialog", { name: "Model and reasoning" });
    // A touch open does not move focus to the filter.
    expect(document.activeElement).toBe(editor);

    // The filter tap is not canceled, so the browser moves focus to it. The
    // editor blurs, but the expanded trigger keeps the composer open.
    const input = filterInput(menu);
    expect(await tap(input)).toBe(true);
    expect(state.collapsed).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole("dialog", { name: "Model and reasoning" })).toBe(menu);

    type(input, "son");
    await waitFor(() => expect(modelNames(menu)).toEqual(["claude-code/sonnet"]));
    // Reasoning, clear, and model taps still keep focus where it is.
    expect(await tap(within(menu).getByRole("radio", { name: "Low" }))).toBe(false);
    await waitFor(() =>
      expect(slot.inspection.composer.selections.at(-1)).toEqual({ reasoningLevel: "low" }),
    );
    expect(document.activeElement).toBe(input);
    expect(await tap(within(menu).getByRole("button", { name: "Clear filter" }))).toBe(false);
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    type(input, "son");
    expect(await tap(within(menu).getByRole("button", { name: "SONNET" }))).toBe(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The close gives focus back to the editor, so the keyboard stays up.
    await waitFor(() => expect(document.activeElement).toBe(editor));
    await frame();
    await frame();
    expect(state.collapsed).toBe(false);
    expect(trigger().textContent).toContain("SONNET");
    expect(slot.inspection.composer.submits).toEqual([]);
    editor.remove();
  });

  it("filters favorites and provider groups by name, provider, and id", async () => {
    const slot = await renderPicker({
      models: "claude-code/opus, codex/gpt, claude-code/sonnet",
      favorites: "claude-code/sonnet\ngone/model",
    });
    const menu = await openMenu();
    await waitFor(() =>
      expect(modelNames(menu)).toEqual(["claude-code/sonnet", "claude-code/opus", "codex/gpt"]),
    );
    const input = filterInput(menu);

    // Display name, with other case and surrounding spaces.
    type(input, "  SonN ");
    expect(modelNames(menu)).toEqual(["claude-code/sonnet"]);
    expect(within(menu).getByRole("group", { name: "Favorites" })).toBeTruthy();
    expect(menu.textContent).not.toContain("gone/model");

    // Provider name and provider id.
    type(input, "claude code");
    expect(modelNames(menu)).toEqual(["claude-code/sonnet", "claude-code/opus"]);
    type(input, "CODEX");
    expect(modelNames(menu)).toEqual(["codex/gpt"]);
    expect(within(menu).queryByRole("group", { name: "Favorites" })).toBeNull();

    // The provider/model key, and a favorite that is not in the catalog.
    type(input, "claude-code/op");
    expect(modelNames(menu)).toEqual(["claude-code/opus"]);
    type(input, "gone");
    expect(modelNames(menu)).toEqual([]);
    expect(within(menu).getByRole("group", { name: "Favorites" }).textContent).toContain(
      "gone/model",
    );
    expect(within(menu).queryByText(/No models match/)).toBeNull();

    // No match, then the clear control.
    type(input, " zzz ");
    expect(modelNames(menu)).toEqual([]);
    expect(within(menu).getByRole("status").textContent).toBe("No models match “zzz”.");
    // The reasoning controls stay.
    expect(within(menu).getByRole("radiogroup", { name: "Reasoning" })).toBeTruthy();
    fireEvent.click(within(menu).getByRole("button", { name: "Clear filter" }));
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(modelNames(menu)).toEqual(["claude-code/sonnet", "claude-code/opus", "codex/gpt"]);
    expect(within(menu).queryByRole("button", { name: "Clear filter" })).toBeNull();

    // Filtering never picks a model.
    expect(onlyReads(slot.inspection.composer.selections)).toBe(true);
    expect(slot.inspection.composer.submits).toEqual([]);
  });

  it("keeps filter keys away from the composer and never picks on Enter", async () => {
    const slot = await renderPicker({ models: "claude-code/opus, claude-code/sonnet" });
    const host = vi.fn();
    document.addEventListener("keydown", host);
    try {
      const menu = await openMenu();
      const input = filterInput(menu);
      type(input, "sonnet");
      fireEvent.keyDown(input, { key: "s" });
      expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
      expect(host).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "Model and reasoning" })).toBe(menu);
      expect(trigger().textContent).toContain("OPUS");
      expect(onlyReads(slot.inspection.composer.selections)).toBe(true);
      expect(slot.inspection.composer.submits).toEqual([]);
    } finally {
      document.removeEventListener("keydown", host);
    }
  });

  it("clears the filter when the menu opens again", async () => {
    await renderPicker({ models: "claude-code/opus, claude-code/sonnet" });
    let menu = await openMenu();
    type(filterInput(menu), "opus");
    fireEvent.keyDown(filterInput(menu), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    menu = await openMenu();
    expect(filterInput(menu).value).toBe("");
    await waitFor(() => expect(modelNames(menu)).toEqual(["claude-code/opus", "claude-code/sonnet"]));

    // A pick closes the menu without the open-change callback.
    type(filterInput(menu), "sonnet");
    fireEvent.click(within(menu).getByRole("button", { name: "SONNET" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    menu = await openMenu();
    expect(filterInput(menu).value).toBe("");
    await waitFor(() => expect(modelNames(menu)).toEqual(["claude-code/opus", "claude-code/sonnet"]));
  });

  it("keeps the configured order when the allowlist alternates providers", async () => {
    await renderPicker({ models: "claude-code/opus, codex/gpt, claude-code/sonnet" });
    const menu = await openMenu();
    await waitFor(() =>
      expect(modelNames(menu)).toEqual(["claude-code/opus", "codex/gpt", "claude-code/sonnet"]),
    );
    // One labelled group per provider run, so each label stays next to its models.
    expect(
      within(menu).getAllByRole("group").map((group) => [
        group.getAttribute("aria-labelledby") &&
          document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent,
        modelNames(group),
      ]),
    ).toEqual([
      ["Claude Code", ["claude-code/opus"]],
      ["Codex", ["codex/gpt"]],
      ["Claude Code", ["claude-code/sonnet"]],
    ]);
  });

  it("applies a pick through the composer API and sends no message", async () => {
    const slot = await renderPicker();
    const menu = await openMenu();
    fireEvent.click(await within(menu).findByRole("button", { name: "SONNET" }));

    await waitFor(() =>
      expect(slot.inspection.composer.selections.at(-1)).toEqual({
        providerId: "claude-code",
        model: "sonnet",
      }),
    );
    await waitFor(() => expect(trigger().textContent).toContain("SONNET"));
    expect(slot.inspection.composer.submits).toEqual([]);
    expect(slot.inspection.composer.text).toBe("");
  });

  it("shows favorites first and keeps the rest in configured order", async () => {
    await renderPicker({
      models: "claude-code/opus, codex/gpt, claude-code/sonnet",
      favorites: "claude-code/sonnet\ngone/model",
    });
    const menu = await openMenu();
    const favorites = await within(menu).findByRole("group", { name: "Favorites" });
    expect(modelNames(favorites)).toEqual(["claude-code/sonnet"]);
    expect(favorites.textContent).toContain("gone/model");
    expect(favorites.textContent).toContain("not available here");
    // Each model shows once. The rest keeps its runs and order.
    expect(modelNames(menu)).toEqual(["claude-code/sonnet", "claude-code/opus", "codex/gpt"]);
  });

  it("saves a star change through the plugin RPC and shows the saved result", async () => {
    const setFavorites = vi.fn(async (input: unknown) => input as { keys: string[] });
    const slot = await renderPicker({ favorites: "codex/gpt" }, { setFavorites });
    const menu = await openMenu();

    const star = await within(menu).findByRole("button", { name: "Add OPUS to favorites" });
    expect(star.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(star);

    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toEqual([
        { method: "setFavorites", input: { keys: ["codex/gpt", "claude-code/opus"] } },
      ]),
    );
    const favorites = await within(menu).findByRole("group", { name: "Favorites" });
    await waitFor(() =>
      expect(modelNames(favorites)).toEqual(["codex/gpt", "claude-code/opus"]),
    );
    expect(
      within(menu).getByRole("button", { name: "Remove OPUS from favorites" }).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    expect(slot.inspection.composer.submits).toEqual([]);
  });

  it("offers the catalog efforts without max and ultra, and marks the current one", async () => {
    await renderPicker();
    await waitFor(() => expect(trigger().textContent).toBe("OPUSH"));
    const menu = await openMenu();
    const group = await within(menu).findByRole("radiogroup", { name: "Reasoning" });
    await waitFor(() =>
      expect(within(group).getAllByRole("radio").map((radio) => radio.textContent)).toEqual([
        "Low",
        "Medium",
        "High",
        "Very High",
      ]),
    );
    expect(within(group).getByRole("radio", { name: "High" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("shows a current max level even though the menu does not offer it", async () => {
    composerState.selection = { providerId: "claude-code", model: "opus", reasoningLevel: "max" };
    await renderPicker();
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toContain("Reasoning: Max"));
    const menu = await openMenu();
    expect(within(menu).getByTestId("reasoning-current").textContent).toBe("Max");
    expect(within(menu).queryByRole("radio", { name: "Max" })).toBeNull();
  });

  it("changes only the reasoning level and shows the settled level", async () => {
    const slot = await renderPicker();
    const menu = await openMenu();
    fireEvent.click(await within(menu).findByRole("radio", { name: "Low" }));

    await waitFor(() =>
      expect(slot.inspection.composer.selections.at(-1)).toEqual({ reasoningLevel: "low" }),
    );
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe(
      "Model: OPUS. Reasoning: Low",
    ));
    expect(within(menu).getByRole("radio", { name: "Low" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(slot.inspection.composer.submits).toEqual([]);
  });

  it("reports a reasoning level that the composer did not accept", async () => {
    composerState.settle = (next) => ({ ...next, reasoningLevel: "medium" });
    await renderPicker();
    const menu = await openMenu();
    fireEvent.click(await within(menu).findByRole("radio", { name: "Low" }));

    expect(
      (await within(menu).findByRole("alert")).textContent,
    ).toBe("The composer did not accept Low reasoning. It kept medium.");
    expect(trigger().getAttribute("aria-label")).toBe("Model: OPUS. Reasoning: Medium");
  });

  it("keeps the models on screen while a provider with errors loads again", async () => {
    let calls = 0;
    const slot = await renderSlot(
      (await loadPluginApp(() => import("../app"))).composerCustomizations[0]!.actions![0]!,
      {},
      {
        composer: { scope: { kind: "new-thread", projectId: "p1" } },
        sdk: {
          providers: {
            models: (args: ModelsArgs = {}) => {
              if (args.providerId === "codex") return Promise.reject(new Error("timeout"));
              if (args.providerId === "claude-code" && ++calls > 1) {
                return new Promise<ModelsResult>(() => {});
              }
              return fakeModels(args);
            },
          },
        },
      },
    );
    // The first load is ready, with an error for Codex.
    await waitFor(() => expect(trigger().getAttribute("title")).toBe("Claude Code · OPUS"));
    expect(calls).toBe(1);
    expect(slot.inspection.composer.submits).toEqual([]);

    // Opening the menu loads again because of the error, and the reload hangs.
    const menu = await openMenu();
    await waitFor(() => expect(calls).toBe(2));
    expect(modelNames(menu)).toEqual(["claude-code/opus", "claude-code/sonnet"]);
    expect(within(menu).queryByText("Loading models…")).toBeNull();
    expect(within(menu).getByText("Codex: timeout")).toBeTruthy();
  });

  it("says when the current model has no reasoning setting", async () => {
    composerState.selection = { providerId: "codex", model: "gpt" };
    await renderPicker();
    const menu = await openMenu();
    expect(await within(menu).findByText("This model has no reasoning setting.")).toBeTruthy();
    expect(within(menu).getByTestId("reasoning-current").textContent).toBe("Unknown");
  });
});
