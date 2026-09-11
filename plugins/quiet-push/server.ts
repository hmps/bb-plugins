// bb-plugin-quiet-push backend.
//
// The builtin Push notifications plugin notifies on every turn end of a
// top-level thread. It has no filter, and the Plugin SDK has no notification
// hook. The builtin does skip a thread that was read after the event: it
// waits two seconds, reads the thread again, and drops the send when
// `lastReadAt` is at or after both its event time and `latestAttentionAt`.
//
// That check is the seam. An agent calls `mute_notification` during its turn.
// When the turn ends, this plugin marks the thread read. bb stamps
// `lastReadAt` with the server clock when the request arrives. bb starts every
// plugin's event handler in the same loop, so the builtin has recorded its
// event time before the request can arrive. The builtin then drops the
// mobile, web, and desktop send alike.
//
// Only a turn end is muted. A failure or a pending question still notifies,
// because both need the user. A muted turn also leaves no unread marker in
// the sidebar.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const TOOL_NAME = "mute_notification";

const TOOL_DESCRIPTION =
  "Mute the notification for the turn you are about to end. The user gets no phone, web, or desktop notification when this turn ends. A failure or a pending question still notifies.";

export const TOOL_INSTRUCTIONS = `The user gets a phone, web, and desktop notification each time your turn ends in a top-level thread. Call \`${TOOL_NAME}\` once, before you end the turn, when your final message needs nothing from the user.

Mute when:
- an automated message started the turn (a child thread report, a Sentinel relay, a scheduled run), and you only acknowledge it, wait, or record it;
- you reply to routine bookkeeping that the user will read later anyway.

Do not mute when you finish the task the user asked for, when you need a decision or input, or when you report a failure or a blocker. When you are unsure, do not mute.`;

const USAGE = `Usage: bb quiet-push mute [--thread <thread-id>]

Mute the notification for the current turn of a thread. Without --thread,
the command mutes the thread it runs in.`;

export default function plugin(bb: BbPluginApi) {
  /** Threads whose current turn ends without a notification. */
  const muted = new Set<string>();

  bb.agents.registerTool({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    instructions: TOOL_INSTRUCTIONS,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    presentation: {
      label: { pending: "Muting notification", completed: "Muted notification" },
      suppress: true,
    },
    execute(_params, ctx) {
      muted.add(ctx.threadId);
      return "Muted. This turn ends without a notification.";
    },
  });

  // The builtin never notifies for a child thread, so only a top-level
  // thread gets the tool and its instructions.
  bb.agents.configure((context) => ({
    tools: context.thread.parentThreadId === null ? [TOOL_NAME] : [],
    skills: [],
  }));

  bb.cli.register({
    name: "quiet-push",
    summary: "Mute the notification for the current turn of a thread",
    commands: [
      {
        name: "mute",
        summary: "Mute the notification for the current turn",
        usage: "bb quiet-push mute [--thread <thread-id>]",
      },
    ],
    run(argv, ctx) {
      const [sub, ...rest] = argv;
      if (sub !== "mute") {
        const help = sub === undefined || sub === "help" || sub === "--help";
        return help
          ? { exitCode: 0, stdout: USAGE }
          : { exitCode: 1, stderr: USAGE };
      }
      const flagIndex = rest.indexOf("--thread");
      const threadId = flagIndex === -1 ? ctx.threadId : rest[flagIndex + 1];
      if (!threadId) {
        return {
          exitCode: 1,
          stderr: "quiet-push: no thread. Run it inside a thread or pass --thread <thread-id>.",
        };
      }
      muted.add(threadId);
      return { exitCode: 0, stdout: `Muted the current turn of ${threadId}.` };
    },
  });

  // The builtin reads the thread two seconds after the event, so one quick
  // retry still lands in time. The first loopback request after a quiet
  // spell can fail with a bare "fetch failed".
  async function markRead(threadId: string): Promise<void> {
    try {
      await bb.sdk.threads.markRead({ threadId });
    } catch (error) {
      bb.log.info(`markRead retry for ${threadId}: ${describe(error)}`);
      await bb.sdk.threads.markRead({ threadId });
    }
  }

  bb.events.on("thread.idle", async ({ thread }) => {
    if (!muted.delete(thread.id)) return;
    try {
      await markRead(thread.id);
      bb.log.info(`muted the turn end of ${thread.id}`);
    } catch (error) {
      bb.log.warn(`could not mute ${thread.id}: ${describe(error)}`);
    }
  });

  // A failed turn notifies as usual, and the mute must not leak into the
  // next turn. The same holds for a thread that is gone.
  const forget = ({ thread }: { thread: { id: string } }) => {
    muted.delete(thread.id);
  };
  bb.events.on("thread.failed", forget);
  bb.events.on("thread.archived", forget);
  bb.events.on("thread.deleted", forget);
}

/** An error message plus its cause, which holds the socket error for "fetch failed". */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause === undefined) return error.message;
  const detail =
    cause instanceof Error
      ? `${(cause as { code?: string }).code ?? cause.name}: ${cause.message}`
      : String(cause);
  return `${error.message} (${detail})`;
}
