import { describe, expect, it } from "vitest";
import {
  isProjectColorId,
  NEUTRAL_COLOR_ID,
  PROJECT_COLORS,
  projectColor,
} from "./project-colors";

describe("project colours", () => {
  it("falls back to neutral for a missing or retired id", () => {
    expect(projectColor(null).id).toBe(NEUTRAL_COLOR_ID);
    expect(projectColor(undefined).id).toBe(NEUTRAL_COLOR_ID);
    expect(projectColor("chartreuse").id).toBe(NEUTRAL_COLOR_ID);
  });

  it("returns the entry for a known id", () => {
    expect(projectColor("violet").label).toBe("Violet");
  });

  it("accepts exactly the palette's ids", () => {
    for (const color of PROJECT_COLORS) {
      expect(isProjectColorId(color.id)).toBe(true);
    }
    expect(isProjectColorId("chartreuse")).toBe(false);
  });
});
