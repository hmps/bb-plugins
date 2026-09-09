import { describe, expect, it } from "vitest";
import {
  buildBeadTree,
  parseSubPath,
  pathToBead,
  routeToSubPath,
} from "./app-logic";

interface Row {
  id: string;
  parentId: string | null;
  priority: number;
}

const bead = (id: string, parentId: string | null, priority = 2): Row => ({
  id,
  parentId,
  priority,
});

describe("buildBeadTree", () => {
  it("nests children under their parent", () => {
    const tree = buildBeadTree([
      bead("epic", null),
      bead("epic.1", "epic"),
      bead("epic.2", "epic"),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0]!.bead.id).toBe("epic");
    expect(tree[0]!.children.map((node) => node.bead.id)).toEqual([
      "epic.1",
      "epic.2",
    ]);
  });

  it("sorts every level by priority, then id", () => {
    const tree = buildBeadTree([
      bead("b", null, 2),
      bead("a", null, 2),
      bead("c", null, 0),
      bead("c.z", "c", 1),
      bead("c.a", "c", 3),
    ]);

    expect(tree.map((node) => node.bead.id)).toEqual(["c", "a", "b"]);
    expect(tree[0]!.children.map((node) => node.bead.id)).toEqual([
      "c.z",
      "c.a",
    ]);
  });

  it("promotes an orphan whose parent is filtered out", () => {
    // The closed parent is not in the set, so its child must still be
    // reachable rather than silently dropped.
    const tree = buildBeadTree([bead("epic.1", "epic-closed")]);

    expect(tree.map((node) => node.bead.id)).toEqual(["epic.1"]);
  });

  it("returns no roots for an empty set", () => {
    expect(buildBeadTree([])).toEqual([]);
  });

  it("makes a self-parented bead a root instead of dropping it", () => {
    const tree = buildBeadTree([bead("loop", "loop")]);

    expect(tree.map((node) => node.bead.id)).toEqual(["loop"]);
    expect(tree[0]!.children).toEqual([]);
  });

  it("breaks a parent cycle so the tree stays finite", () => {
    // A cycle would otherwise nest each bead inside the other and make the
    // row renderer recurse forever.
    const tree = buildBeadTree([bead("a", "b"), bead("b", "a")]);

    expect(tree.map((node) => node.bead.id)).toEqual(["a", "b"]);
    expect(tree.every((node) => node.children.length === 0)).toBe(true);
  });
});

describe("pathToBead", () => {
  it("lists every ancestor from the root down", () => {
    const beads = [
      bead("epic", null),
      bead("epic.1", "epic"),
      bead("epic.1.1", "epic.1"),
    ];

    expect(pathToBead(beads, "epic.1.1")).toEqual([
      "epic",
      "epic.1",
      "epic.1.1",
    ]);
  });

  it("stops on a parent cycle", () => {
    const beads = [bead("a", "b"), bead("b", "a")];

    expect(pathToBead(beads, "a")).toEqual(["b", "a"]);
  });
});

describe("subPath routing", () => {
  it("reads the root as the Beads section with nothing selected", () => {
    expect(parseSubPath("")).toEqual({ section: "beads", beadId: null });
  });

  it("reads a selected bead", () => {
    expect(parseSubPath("beads/vaam-27c.1")).toEqual({
      section: "beads",
      beadId: "vaam-27c.1",
    });
  });

  it("round-trips a route through its subPath", () => {
    const route = { section: "beads", beadId: "vaam-27c" } as const;

    expect(parseSubPath(routeToSubPath(route))).toEqual(route);
    expect(routeToSubPath({ section: "beads", beadId: null })).toBe("");
  });
});
