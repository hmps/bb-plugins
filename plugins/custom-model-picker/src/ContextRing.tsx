import { useCallback, useEffect, useRef, useState } from "react";
import { useComposerView, useSdk } from "@get-bb/plugin-sdk/app";
import { CONTROL_HOVER_TRANSITION } from "@/components/ui/motion";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  changesUsage,
  formatTokens,
  readUsage,
  usagePercent,
  usageTone,
  type ContextUsage,
  type UsageTone,
} from "./contextUsage";
import { isEditable, keepEditorFocus } from "./editorFocus";

const TONE_CLASS: Record<UsageTone, string> = {
  normal: "text-muted-foreground",
  warning: "text-warning-text",
  destructive: "text-destructive",
};

/**
 * The context usage of one thread from `threads.context`. It reads on mount,
 * when the thread sends a usage event (a run sends one as the context grows),
 * when a run starts or ends, and when the window gets focus. A thread change
 * stops the old subscription and drops its reads, so a late answer for one
 * thread never shows in another. A failed read keeps the last value.
 */
export function useThreadContextUsage(threadId: string | null, isRunning: boolean) {
  // The effect reads the SDK through a ref, so a new SDK object from the host
  // does not restart the subscription.
  const sdk = useSdk();
  const sdkRef = useRef(sdk);
  sdkRef.current = sdk;
  const [state, setState] = useState<{ threadId: string; usage: ContextUsage | null } | null>(
    null,
  );
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!threadId) return;
    const sdk = sdkRef.current;
    let active = true;
    let controller: AbortController | null = null;
    // One read at a time. A request during a read starts one more read after it.
    let reading = false;
    let again = false;
    const load = async () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      do {
        again = false;
        controller = new AbortController();
        try {
          const result = await sdk.threads.context({ threadId, signal: controller.signal });
          if (!active) return;
          setState({ threadId, usage: readUsage(result) });
        } catch {
          if (!active) return;
        }
      } while (again);
      reading = false;
    };
    refreshRef.current = () => void load();
    void load();
    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      threadId,
      callback: (event) => {
        if (changesUsage(event)) void load();
      },
    });
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      controller?.abort();
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      refreshRef.current = () => {};
    };
  }, [threadId]);

  // The mount read above covers the first value; this reads again only when a
  // run starts or ends.
  const wasRunning = useRef(isRunning);
  useEffect(() => {
    if (wasRunning.current === isRunning) return;
    wasRunning.current = isRunning;
    refreshRef.current();
  }, [isRunning]);

  const refresh = useCallback(() => refreshRef.current(), []);
  const usage = state && state.threadId === threadId ? state.usage : null;
  return { usage, refresh };
}

function RingIcon({ percent }: { percent: number }) {
  const radius = 6.5;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
      <circle cx="8" cy="8" r={radius} fill="none" strokeWidth="3" className="stroke-border" />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap={percent > 0 ? "round" : "butt"}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - percent / 100)}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

function UsagePanel({ usage }: { usage: ContextUsage }) {
  const percent = usagePercent(usage);
  const tone = TONE_CLASS[usageTone(percent)];
  return (
    <div className="flex flex-col gap-2 text-xs max-md:text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground">
          {usage.estimated ? "Estimated context" : "Context window"}
        </span>
        <span className={cn("font-medium tabular-nums", tone)}>{percent}% used</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div className={cn("h-full rounded-full bg-current", tone)} style={{ width: `${percent}%` }} />
      </div>
      <div className="flex items-baseline justify-between gap-2 text-muted-foreground tabular-nums">
        <span>
          {formatTokens(usage.usedTokens)} / {formatTokens(usage.modelContextWindow)} tokens
        </span>
        <span>{100 - percent}% left</span>
      </div>
    </div>
  );
}

function RingPopover({ usage, onOpen }: { usage: ContextUsage; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const percent = usagePercent(usage);
  const label = `${usage.estimated ? "Estimated context window" : "Context window"} ${percent}% used`;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onOpen();
      }}
    >
      <PopoverTrigger
        {...keepEditorFocus}
        aria-label={label}
        title={label}
        // The host action wrapper is 36px high and clips its content, so a
        // larger invisible hit area would only cover the picker. On touch the
        // button itself fills that height.
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:size-9",
          CONTROL_HOVER_TRANSITION,
          TONE_CLASS[usageTone(percent)],
        )}
      >
        <RingIcon percent={percent} />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        collisionPadding={8}
        aria-label="Context window"
        // The panel has no controls. Focus stays in the editor after a tap,
        // or on the ring after a keyboard open, so Escape still closes it.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          // Moving focus to the ring would close the touch keyboard.
          if (isEditable(document.activeElement)) event.preventDefault();
        }}
        className="w-56 max-w-[calc(100vw-1rem)] p-2"
      >
        <UsagePanel usage={usage} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * A small context usage ring for the thread composer. It shows nothing in
 * other composers, and nothing while the thread has no valid usage, so a
 * missing value never shows as 0% used.
 */
export function ContextRing() {
  const view = useComposerView();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const { usage, refresh } = useThreadContextUsage(threadId, view.run.isRunning);
  if (!threadId || !usage) return null;
  // A new thread starts closed.
  return <RingPopover key={threadId} usage={usage} onOpen={refresh} />;
}
