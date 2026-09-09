// The four rpcs, against an injected `bd` runner. The load-bearing parts are
// the JSON mapping (bd omits every empty field), the id guard that keeps
// arbitrary text out of argv, and the verbatim NewThreadRequest forwarding —
// the host drops a provider/model choice that carries no
// `executionInputSources` provenance and silently re-derives it.
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { buildThreadTitle, resolveBdPath, type BdRunner } from "./server";

const ROOT = "/tmp/beads-root";

const epic = {
  id: "vaam-27c",
  title: "Reliability epic",
  description: "The umbrella issue.",
  status: "open",
  priority: 1,
  issue_type: "epic",
  labels: ["reliability"],
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-02T00:00:00Z",
  dependency_count: 0,
  dependent_count: 0,
};

const child = {
  id: "vaam-27c.1",
  title: "Retry the flaky uploader",
  description: "Retry with backoff.",
  design: "Exponential, capped at 30s.",
  acceptance_criteria: "No 5xx in the upload dashboard for a week.",
  notes: "Started on the client side.",
  status: "in_progress",
  priority: 0,
  issue_type: "task",
  assignee: "Hampus Persson",
  labels: [],
  parent: "vaam-27c",
  dependencies: [
    { depends_on_id: "vaam-27c", type: "parent-child" },
    { depends_on_id: "vaam-999", type: "blocks" },
    { depends_on_id: "vaam-888", type: "blocks" },
    { depends_on_id: "vaam-777", type: "related" },
  ],
  created_at: "2026-08-03T00:00:00Z",
  updated_at: "2026-08-04T00:00:00Z",
};

/** A `bd` that answers `list` and `show` from the two fixtures above. */
function fakeBd(): BdRunner {
  return (args) => {
    if (args[0] === "list") return Promise.resolve(JSON.stringify([epic, child]));
    if (args[0] === "show") {
      const row = [epic, child].find((issue) => issue.id === args[1]);
      return Promise.resolve(JSON.stringify(row === undefined ? [] : [row]));
    }
    throw new Error(`unexpected bd call: ${args.join(" ")}`);
  };
}

async function loadPlugin(runBd: BdRunner = fakeBd()) {
  const host = createFakePluginHost({
    pluginId: "vaam",
    settings: { beadsRoot: ROOT },
    sdk: {
      projects: {
        list: () => [
          { id: "proj_other", sources: [{ path: "/elsewhere" }] },
          { id: "proj_vaam", sources: [{ path: ROOT }] },
        ],
      },
      threads: { spawn: () => ({ id: "thr-99" }) },
    },
  });
  await plugin(host.bb, { runBd, warmOnLoad: false });
  return host;
}

/** What `experimental_NewThreadComposer` submits, once the user has picked. */
const composerRequest = {
  projectId: "proj_vaam",
  providerId: "anthropic",
  model: "claude-opus-5",
  reasoningLevel: "high",
  permissionMode: "accept-edits",
  serviceTier: "fast",
  executionInputSources: {
    providerId: "explicit",
    model: "explicit",
    reasoningLevel: "explicit",
    permissionMode: "explicit",
    serviceTier: "explicit",
  },
  environment: { type: "host", hostId: "host-1" },
  input: [{ type: "text", text: "Work on bead vaam-27c.1" }],
};

describe("listBeads", () => {
  it("maps every tree field and resolves the project by root path", async () => {
    const { harness } = await loadPlugin();

    await expect(harness.callRpc("listBeads", {})).resolves.toEqual({
      root: ROOT,
      projectId: "proj_vaam",
      beads: [
        {
          id: "vaam-27c",
          title: "Reliability epic",
          description: "The umbrella issue.",
          status: "open",
          priority: 1,
          issueType: "epic",
          assignee: null,
          labels: ["reliability"],
          parentId: null,
          blockedBy: [],
          createdAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-08-02T00:00:00Z",
          closedAt: null,
        },
        {
          id: "vaam-27c.1",
          title: "Retry the flaky uploader",
          description: "Retry with backoff.",
          status: "in_progress",
          priority: 0,
          issueType: "task",
          assignee: "Hampus Persson",
          labels: [],
          parentId: "vaam-27c",
          blockedBy: ["vaam-999", "vaam-888"],
          createdAt: "2026-08-03T00:00:00Z",
          updatedAt: "2026-08-04T00:00:00Z",
          closedAt: null,
        },
      ],
    });
  });

  it("keeps only `blocks` dependencies in blockedBy", async () => {
    const { harness } = await loadPlugin();
    const result = (await harness.callRpc("listBeads", {})) as {
      beads: Array<{ id: string; blockedBy: string[] }>;
    };
    expect(
      result.beads.find((bead) => bead.id === "vaam-27c.1")?.blockedBy,
    ).toEqual(["vaam-999", "vaam-888"]);
  });

  it("passes --all only when closed beads are asked for", async () => {
    const runBd = vi.fn(fakeBd());
    const { harness } = await loadPlugin(runBd);

    await harness.callRpc("listBeads", {});
    await harness.callRpc("listBeads", { includeClosed: true });

    expect(runBd.mock.calls[0]?.[0]).toEqual(["list", "--json", "-n", "0"]);
    expect(runBd.mock.calls[1]?.[0]).toEqual([
      "list",
      "--json",
      "-n",
      "0",
      "--all",
    ]);
    expect(runBd.mock.calls[0]?.[1]).toEqual({ cwd: ROOT });
  });

  it("serves a repeated call from the 5s cache", async () => {
    const runBd = vi.fn(fakeBd());
    const { harness } = await loadPlugin(runBd);

    await harness.callRpc("listBeads", {});
    await harness.callRpc("listBeads", {});

    expect(runBd).toHaveBeenCalledTimes(1);
  });

  it("serves a stale cache at once and refreshes behind it", async () => {
    vi.useFakeTimers();
    try {
      const runBd = vi.fn(fakeBd());
      const { harness } = await loadPlugin(runBd);

      await harness.callRpc("listBeads", {});
      vi.advanceTimersByTime(31_000);
      const second = await harness.callRpc("listBeads", {});

      expect((second as { beads: unknown[] }).beads).toHaveLength(2);
      expect(runBd).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-runs bd when force is set", async () => {
    const runBd = vi.fn(fakeBd());
    const { harness } = await loadPlugin(runBd);

    await harness.callRpc("listBeads", {});
    await harness.callRpc("listBeads", { force: true });

    expect(runBd).toHaveBeenCalledTimes(2);
  });

  it("shares one bd run between concurrent callers", async () => {
    const runBd = vi.fn(fakeBd());
    const { harness } = await loadPlugin(runBd);

    await Promise.all([
      harness.callRpc("listBeads", {}),
      harness.callRpc("listBeads", {}),
    ]);

    expect(runBd).toHaveBeenCalledTimes(1);
  });

  it("warms the cache at load", async () => {
    const runBd = vi.fn(fakeBd());
    const host = createFakePluginHost({
      pluginId: "vaam",
      settings: { beadsRoot: ROOT },
      sdk: { projects: { list: () => [] } },
    });
    await plugin(host.bb, { runBd });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runBd).toHaveBeenCalledTimes(1);
    await host.harness.callRpc("listBeads", {});
    expect(runBd).toHaveBeenCalledTimes(1);
  });

  it("surfaces a bd failure as its message", async () => {
    const { harness } = await loadPlugin(() => {
      throw new Error('bd list failed in /tmp/beads-root: no beads database');
    });

    await expect(harness.callRpc("listBeads", {})).rejects.toThrow(
      /no beads database/,
    );
  });

  it("reports the project as null when no project holds the root", async () => {
    const host = createFakePluginHost({
      pluginId: "vaam",
      settings: { beadsRoot: ROOT },
      sdk: { projects: { list: () => [] } },
    });
    await plugin(host.bb, { runBd: fakeBd(), warmOnLoad: false });

    await expect(host.harness.callRpc("listBeads", {})).resolves.toMatchObject({
      projectId: null,
    });
  });
});

describe("getBead", () => {
  it("answers from the cached list without a bd show", async () => {
    const runBd = vi.fn(fakeBd());
    const { harness } = await loadPlugin(runBd);

    await harness.callRpc("listBeads", {});
    const result = await harness.callRpc("getBead", { id: "vaam-27c.1" });

    expect(result).toMatchObject({
      bead: { id: "vaam-27c.1", design: "Exponential, capped at 30s." },
    });
    expect(runBd.mock.calls.map((call) => call[0][0])).toEqual(["list"]);
  });

  it("returns the long-form fields the detail pane shows", async () => {
    const { harness } = await loadPlugin();

    await expect(
      harness.callRpc("getBead", { id: "vaam-27c.1" }),
    ).resolves.toMatchObject({
      bead: {
        id: "vaam-27c.1",
        design: "Exponential, capped at 30s.",
        acceptanceCriteria: "No 5xx in the upload dashboard for a week.",
        notes: "Started on the client side.",
        dependencies: [
          { dependsOnId: "vaam-27c", type: "parent-child" },
          { dependsOnId: "vaam-999", type: "blocks" },
          { dependsOnId: "vaam-888", type: "blocks" },
          { dependsOnId: "vaam-777", type: "related" },
        ],
      },
    });
  });

  it("defaults the absent long-form fields to empty strings", async () => {
    const { harness } = await loadPlugin();

    await expect(
      harness.callRpc("getBead", { id: "vaam-27c" }),
    ).resolves.toMatchObject({
      bead: { design: "", acceptanceCriteria: "", notes: "", dependencies: [] },
    });
  });

  it("rejects an id that is not a bead id, without running bd", async () => {
    const runBd = vi.fn(fakeBd());
    const { harness } = await loadPlugin(runBd);

    await expect(
      harness.callRpc("getBead", { id: "vaam-27c; rm -rf /" }),
    ).rejects.toThrow();
    expect(runBd).not.toHaveBeenCalled();
  });
});

describe("beadPrompt", () => {
  it("seeds the composer with the bead's own context", async () => {
    const { harness } = await loadPlugin();

    const result = (await harness.callRpc("beadPrompt", {
      id: "vaam-27c.1",
    })) as { projectId: string | null; prompt: string };

    expect(result.projectId).toBe("proj_vaam");
    expect(result.prompt).toContain(
      "Work on bead vaam-27c.1: Retry the flaky uploader",
    );
    expect(result.prompt).toContain("bd update vaam-27c.1 --status in_progress");
    expect(result.prompt).toContain("Retry with backoff.");
    expect(result.prompt).toContain(
      "No 5xx in the upload dashboard for a week.",
    );
  });

  it("writes (none) when the bead has no acceptance criteria", async () => {
    const { harness } = await loadPlugin();

    const result = (await harness.callRpc("beadPrompt", { id: "vaam-27c" })) as {
      prompt: string;
    };

    expect(result.prompt).toContain("Acceptance criteria:\n(none)");
  });
});

describe("spawnForBead", () => {
  it("forwards every composer selection and titles the thread", async () => {
    const { harness } = await loadPlugin();

    await expect(
      harness.callRpc("spawnForBead", {
        id: "vaam-27c.1",
        request: composerRequest,
      }),
    ).resolves.toEqual({ threadId: "thr-99" });

    const [args] = harness.sdk.callsTo("threads.spawn");
    expect(args?.[0]).toMatchObject({
      ...composerRequest,
      title: buildThreadTitle("vaam-27c.1", "Retry the flaky uploader"),
    });
  });

  it("logs the spawn", async () => {
    const { harness } = await loadPlugin();

    await harness.callRpc("spawnForBead", {
      id: "vaam-27c.1",
      request: composerRequest,
    });

    expect(
      harness.inspection.logEntries.some((entry) =>
        entry.message.includes("spawned thread thr-99 for bead vaam-27c.1"),
      ),
    ).toBe(true);
  });

  it("rejects a request with no provider selection", async () => {
    const { harness } = await loadPlugin();

    await expect(
      harness.callRpc("spawnForBead", {
        id: "vaam-27c.1",
        request: { ...composerRequest, providerId: "" },
      }),
    ).rejects.toThrow();
  });
});

describe("resolveBdPath", () => {
  const home = "/home/me";
  it("keeps an explicit path", () => {
    expect(resolveBdPath("~/bin/bd", { home, exists: () => false })).toBe(
      "/home/me/bin/bd",
    );
  });
  it("prefers PATH when the shim is there", () => {
    const exists = (file: string) => file === "/usr/bin/bd";
    expect(resolveBdPath("bd", { home, path: "/sbin:/usr/bin", exists })).toBe(
      "/usr/bin/bd",
    );
  });
  it("falls back to the mise shim when PATH lacks bd", () => {
    const exists = (file: string) => file === "/home/me/.local/share/mise/shims/bd";
    expect(resolveBdPath("bd", { home, path: "/usr/bin", exists })).toBe(
      "/home/me/.local/share/mise/shims/bd",
    );
  });
  it("returns the bare name when nothing matches", () => {
    expect(resolveBdPath("bd", { home, path: "/usr/bin", exists: () => false })).toBe("bd");
  });
});
