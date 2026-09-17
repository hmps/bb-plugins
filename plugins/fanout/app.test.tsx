// @vitest-environment jsdom

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

afterEach(() => cleanup());

const machines = [
  { hostId: "titan", name: "Titan", connected: true, running: 2, capacity: 10, enabled: true, priority: 20 },
  { hostId: "msi", name: "MSI", connected: true, running: 0, capacity: 12, enabled: true, priority: 1 },
];

function control(placementPolicy: "offload" | "priority", rows = machines) {
  return {
    placementPolicy,
    configRevision: 4,
    pendingSelection: true,
    machines: rows,
    selection: {
      policy: placementPolicy,
      thresholdPercent: 80,
      snapshotVersion: "session:4",
      configRevision: 4,
      sampleRevision: 3,
      originHostId: null,
      projectId: null,
      sampleAgeMs: 10,
      observedAt: 1,
      expiresAt: 30_001,
      configuredOrder: ["msi", "titan"],
      eligibleOrder: ["msi", "titan"],
      exclusions: {},
      kind: "unavailable data" as const,
      winner: null,
      reason: "origin/project context required",
    },
    statusText: `${placementPolicy} status`,
  };
}

function render(
  policy: "offload" | "priority",
  saveMachines: () => ReturnType<typeof control> | Promise<ReturnType<typeof control>> = () => control(policy),
) {
  return renderSlot(app.settingsSections[0]!, {}, {
    rpc: {
      listMachines: () => control(policy),
      saveMachines,
    },
  });
}

describe("E10 mounted settings fixture", () => {
  it.each(["offload", "priority"] as const)("validates and atomically saves %s drafts", async (policy) => {
    const saved = control(policy, [
      { ...machines[0], capacity: 11, priority: 30 },
      { ...machines[1], enabled: false, priority: 2 },
    ]);
    const saveMachines = vi.fn(() => saved);
    const slot = render(policy, saveMachines);

    const priority = await slot.findByRole("spinbutton", { name: "Priority for Titan" });
    fireEvent.change(priority, { target: { value: "0" } });
    expect((slot.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(slot.getByText("Max threads and priority must be whole numbers between 1 and 1000.")).not.toBeNull();

    fireEvent.change(priority, { target: { value: "30" } });
    fireEvent.change(slot.getByRole("spinbutton", { name: "Max threads on Titan" }), { target: { value: "11" } });
    fireEvent.click(slot.getByRole("checkbox", { name: "Use MSI for fan-out" }));
    fireEvent.change(slot.getByRole("spinbutton", { name: "Priority for MSI" }), { target: { value: "2" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveMachines).toHaveBeenCalledTimes(1));
    expect(saveMachines).toHaveBeenCalledWith({
      placementPolicy: policy,
      machines: [
        { hostId: "titan", capacity: 11, enabled: true, priority: 30 },
        { hostId: "msi", capacity: 12, enabled: false, priority: 2 },
      ],
    });
    expect(slot.inspection.rpcCalls.filter(call => call.method === "saveMachines")).toHaveLength(1);
    expect(slot.getByLabelText("Placement status").textContent).toContain(`${policy} status`);
    expect(slot.getByText(policy === "priority"
      ? "Priority selection is unavailable while the replacement sample is pending."
      : "Any cached offload selection remains available while the replacement sample is pending.")).not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("shows a save error and keeps the edited draft", async () => {
    const saveMachines = vi.fn(async () => { throw new Error("storage unavailable"); });
    const slot = render("priority", saveMachines);

    const priority = await slot.findByRole("spinbutton", { name: "Priority for MSI" });
    fireEvent.change(priority, { target: { value: "7" } });
    fireEvent.change(slot.getByRole("combobox", { name: "Placement policy" }), { target: { value: "offload" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));

    expect((await slot.findByRole("alert")).textContent).toContain("Could not save machines: storage unavailable");
    expect((slot.getByRole("spinbutton", { name: "Priority for MSI" }) as HTMLInputElement).value).toBe("7");
    expect((slot.getByRole("combobox", { name: "Placement policy" }) as HTMLSelectElement).value).toBe("offload");
    expect((slot.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
    expect(saveMachines).toHaveBeenCalledTimes(1);
    slot.lifecycle.unmount();
  });
});
