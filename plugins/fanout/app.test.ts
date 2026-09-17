import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("E10 ui_policy_priority_save_inspection", () => {
  it("declares the policy choices, bounded priority input, atomic save, and pending label", async () => {
    const app = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
    expect(app).toContain('<option value="offload">Offload</option>');
    expect(app).toContain('<option value="priority">Priority</option>');
    expect(app).toContain('aria-label={`Priority for ${row.name}`}');
    expect(app).toContain('min={1}');
    expect(app).toContain('max={1000}');
    expect(app).toContain('placementPolicy,');
    expect(app).toContain("Selection is unavailable while the replacement sample is pending.");
    expect(app).toContain("toast.error");
  });
});


describe("E11 UI projection inspection", () => {
  it("renders the server status without a separate selector", async () => {
    const app = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
    expect(app).toContain('rpc.call("listMachines", null)');
    expect(app).toContain("setStatusText(result.statusText)");
    expect(app).toContain('aria-label="Placement status"');
    expect(app).toContain("{statusText}</pre>");
    expect(app).not.toContain("selectPlacement");
  });
});
