import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { TOOL_NAME } from "./server";

const THREAD = "thr_top";

function host(options: { markRead?: (args: { threadId: string }) => unknown } = {}) {
  const fake = createFakePluginHost({
    pluginId: "quiet-push",
    sdk: {
      threads: {
        markRead:
          options.markRead ??
          ((args: { threadId: string }) => makeThreadResponse({ id: args.threadId })),
      },
    },
  });
  plugin(fake.bb);
  return fake.harness;
}

function thread(id = THREAD) {
  return makeThreadResponse({ id, parentThreadId: null });
}

async function idle(harness: ReturnType<typeof host>, id = THREAD) {
  const result = await harness.emitThreadEvent("thread.idle", {
    thread: thread(id),
    lastAssistantText: "done",
  });
  expect(result.errors).toEqual([]);
}

describe("quiet-push", () => {
  it("marks the thread read when a muted turn ends", async () => {
    const harness = host();
    await harness.callAgentTool(TOOL_NAME, {}, { threadId: THREAD });
    await idle(harness);

    expect(harness.sdk.callsTo("threads.markRead")).toEqual([[{ threadId: THREAD }]]);
  });

  it("leaves an unmuted turn alone", async () => {
    const harness = host();
    await idle(harness);

    expect(harness.sdk.callsTo("threads.markRead")).toHaveLength(0);
  });

  it("mutes one turn only", async () => {
    const harness = host();
    await harness.callAgentTool(TOOL_NAME, {}, { threadId: THREAD });
    await idle(harness);
    await idle(harness);

    expect(harness.sdk.callsTo("threads.markRead")).toHaveLength(1);
  });

  it("mutes only the thread that asked", async () => {
    const harness = host();
    await harness.callAgentTool(TOOL_NAME, {}, { threadId: THREAD });
    await idle(harness, "thr_other");

    expect(harness.sdk.callsTo("threads.markRead")).toHaveLength(0);
  });

  it("drops the mute when the turn fails", async () => {
    const harness = host();
    await harness.callAgentTool(TOOL_NAME, {}, { threadId: THREAD });
    await harness.emitThreadEvent("thread.failed", { thread: thread(), error: "boom" });
    await idle(harness);

    expect(harness.sdk.callsTo("threads.markRead")).toHaveLength(0);
  });

  it("retries a failed markRead once", async () => {
    let calls = 0;
    const harness = host({
      markRead: (args) => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return makeThreadResponse({ id: args.threadId });
      },
    });
    await harness.callAgentTool(TOOL_NAME, {}, { threadId: THREAD });
    await idle(harness);

    expect(calls).toBe(2);
    expect(harness.logEntries.some((entry) => entry.level === "warn")).toBe(false);
  });

  it("logs and survives a failed markRead", async () => {
    const harness = host({
      markRead: () => {
        throw new Error("thread_not_found");
      },
    });
    await harness.callAgentTool(TOOL_NAME, {}, { threadId: THREAD });
    await idle(harness);

    expect(
      harness.logEntries.some(
        (entry) => entry.level === "warn" && entry.message.includes("thread_not_found"),
      ),
    ).toBe(true);
  });

  it("offers the tool to top-level threads only", async () => {
    const harness = host();
    const top = await harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { parentThreadId: null } }),
    );
    const child = await harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { parentThreadId: "thr_parent" } }),
    );

    expect(top.tools.map((tool) => tool.name)).toEqual([TOOL_NAME]);
    expect(top.tools[0]?.instructions).toContain(TOOL_NAME);
    expect(child.tools).toEqual([]);
  });

  it("mutes the calling thread from the CLI", async () => {
    const harness = host();
    const result = await harness.runCli(["mute"], { threadId: THREAD });
    await idle(harness);

    expect(result.exitCode).toBe(0);
    expect(harness.sdk.callsTo("threads.markRead")).toEqual([[{ threadId: THREAD }]]);
  });

  it("mutes a named thread from the CLI", async () => {
    const harness = host();
    await harness.runCli(["mute", "--thread", "thr_named"], {});
    await idle(harness, "thr_named");

    expect(harness.sdk.callsTo("threads.markRead")).toEqual([[{ threadId: "thr_named" }]]);
  });

  it("refuses a CLI mute without a thread", async () => {
    const harness = host();
    const result = await harness.runCli(["mute"], {});

    expect(result.exitCode).toBe(1);
  });
});
