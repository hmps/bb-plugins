// bb-plugin-command-palette — thread actions in bb's own quick palette.
//
// bb 0.40 owns the quick palette (Mod+Shift+P) and its thread search, so this
// plugin no longer draws a palette of its own. It registers rows the host
// renders, matches, and orders; each row acts on the thread in view and calls
// the backend over the plugin's RPC route. Registration happens once, outside
// React, so a row's title is fixed and `isAvailable` must answer synchronously.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { snoozePresets, snoozeWakeTime } from "@/lib/snooze";
import { rpc } from "@/lib/rpc-client";

/**
 * Whether the t3sidebar plugin is there, cached for the synchronous
 * `isAvailable` callbacks.
 *
 * The probe runs once at startup. Until it answers, the settle and snooze rows
 * stay hidden rather than appear and then fail.
 */
let lifecycleAvailable = false;

async function probeLifecycle(): Promise<void> {
  try {
    lifecycleAvailable = (await rpc.lifecycleAvailable()).available;
  } catch {
    lifecycleAvailable = false;
  }
}

/** A row needs a thread; the palette also opens where there is none. */
const hasThread = (context: { threadId: string | null }): boolean =>
  context.threadId !== null;

/** A row needs a thread and the plugin that owns the lifecycle state. */
const hasLifecycle = (context: { threadId: string | null }): boolean =>
  context.threadId !== null && lifecycleAvailable;

/**
 * Both directions of every toggle get their own row.
 *
 * A registration's title is fixed and `isAvailable` cannot read thread state,
 * so the palette cannot show "Pin" or "Unpin" by turn. Listing both keeps the
 * rows honest, and typing "pin" narrows to the pair.
 */
const THREAD_ACTIONS = [
  { id: "pin", action: "pin", title: "Pin thread" },
  { id: "unpin", action: "unpin", title: "Unpin thread" },
  { id: "mark-read", action: "markRead", title: "Mark thread read" },
  { id: "mark-unread", action: "markUnread", title: "Mark thread unread" },
  { id: "archive", action: "archive", title: "Archive thread" },
] as const;

/** Actions the t3sidebar plugin owns. */
const LIFECYCLE_ACTIONS = [
  { id: "settle", action: "settle", title: "Settle thread" },
  {
    id: "settle-and-archive",
    action: "settleAndArchive",
    title: "Settle and archive thread",
  },
  { id: "unsettle", action: "unsettle", title: "Unsettle thread" },
  { id: "unsnooze", action: "unsnooze", title: "Unsnooze thread" },
] as const;

export default definePluginApp((app) => {
  void probeLifecycle();

  const perform = async (
    threadId: string | null,
    action: string,
    label: string,
  ): Promise<void> => {
    if (threadId === null) return;
    try {
      await rpc.threadAction(threadId, action);
    } catch (error) {
      toast.error(`${label} failed: ${(error as Error).message}`);
    }
  };

  for (const entry of [...THREAD_ACTIONS, ...LIFECYCLE_ACTIONS]) {
    const needsLifecycle = LIFECYCLE_ACTIONS.some((row) => row.id === entry.id);
    app.slots.commandPaletteAction({
      id: entry.id,
      title: entry.title,
      isAvailable: needsLifecycle ? hasLifecycle : hasThread,
      run: (context) => perform(context.threadId, entry.action, entry.title),
    });
  }

  // Snooze needs a wake time and a palette row cannot ask for one, so every
  // preset is its own row. The time is computed on activation, not here, or a
  // long-running app would snooze against a stale clock.
  for (const preset of snoozePresets) {
    app.slots.commandPaletteAction({
      id: preset.id,
      title: preset.label,
      isAvailable: hasLifecycle,
      async run({ threadId }) {
        if (threadId === null) return;
        try {
          await rpc.snooze(threadId, snoozeWakeTime(preset.id, Date.now()));
        } catch (error) {
          toast.error(`${preset.label} failed: ${(error as Error).message}`);
        }
      },
    });
  }
});
