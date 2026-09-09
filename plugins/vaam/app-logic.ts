// Pure helpers for the Vaam panel: sub-path routing and the bead tree. Kept
// out of app.tsx so they can be tested without jsdom.

/** Only the bead fields the tree needs. `Bead` from server.ts satisfies it. */
export interface BeadNodeInput {
  id: string;
  parentId: string | null;
  priority: number;
}

export interface BeadTreeNode<T extends BeadNodeInput> {
  bead: T;
  children: BeadTreeNode<T>[];
}

/**
 * The panel owns /plugins/vaam/vaam/*. The first segment names the section,
 * so more sections can be added beside Beads without touching the routes
 * already in browser history.
 */
export type Route =
  | { section: "beads"; beadId: string | null };

export function parseSubPath(subPath: string): Route {
  const parts = subPath.split("/").filter((part) => part.length > 0);
  if (parts[0] === "beads" && parts.length >= 2) {
    return { section: "beads", beadId: parts[1]! };
  }
  return { section: "beads", beadId: null };
}

export function routeToSubPath(route: Route): string {
  return route.beadId === null ? "" : `beads/${route.beadId}`;
}

/**
 * The parent to attach `bead` to, or null when it is a root. A parent that is
 * missing from the set makes the bead a root — that is how a child survives
 * when its closed parent is filtered out. A parent link that would close a
 * cycle is dropped too: `bd` never writes one, but an unchecked cycle would
 * make the tree renderer recurse forever.
 */
function attachableParent<T extends BeadNodeInput>(
  bead: T,
  byId: ReadonlyMap<string, T>,
): string | null {
  const parentId = bead.parentId;
  if (parentId === null || !byId.has(parentId)) return null;
  const seen = new Set<string>([bead.id]);
  let cursor: string | null = parentId;
  while (cursor !== null) {
    if (seen.has(cursor)) return null;
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return parentId;
}

/**
 * Group beads into a forest by `parentId`. Siblings sort by priority, then
 * id, at every level.
 */
export function buildBeadTree<T extends BeadNodeInput>(
  beads: readonly T[],
): BeadTreeNode<T>[] {
  const byId = new Map(beads.map((bead) => [bead.id, bead]));
  const nodes = new Map<string, BeadTreeNode<T>>();
  for (const bead of beads) nodes.set(bead.id, { bead, children: [] });

  const roots: BeadTreeNode<T>[] = [];
  for (const node of nodes.values()) {
    const parentId = attachableParent(node.bead, byId);
    const parent = parentId === null ? undefined : nodes.get(parentId);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }

  const sort = (list: BeadTreeNode<T>[]) => {
    list.sort(
      (a, b) =>
        a.bead.priority - b.bead.priority || a.bead.id.localeCompare(b.bead.id),
    );
    for (const child of list) sort(child.children);
  };
  sort(roots);
  return roots;
}

/** Every id on the path from a root down to `beadId`, that id included. */
export function pathToBead<T extends BeadNodeInput>(
  beads: readonly T[],
  beadId: string,
): string[] {
  const byId = new Map(beads.map((bead) => [bead.id, bead]));
  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | null = beadId;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    path.unshift(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return path;
}
