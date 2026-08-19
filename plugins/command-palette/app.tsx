// bb-plugin-command-palette — a ⌘K palette over threads and thread actions.
//
// The palette must be reachable from every screen, so it mounts its own React
// root from a content script instead of a plugin slot. SDK React hooks
// (useRpc, useBbNavigate) only work inside a slot component, so this file talks
// to the backend over raw fetch and navigates with pushState. See lib/.
import * as React from "react";
import { createRoot } from "react-dom/client";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  currentThreadId,
  navigate,
  newThreadPath,
  threadPath,
} from "@/lib/navigate";
import { snoozeChoices } from "@/lib/snooze";
import {
  rpc,
  type PaletteProject,
  type PaletteThread,
} from "@/lib/rpc-client";

interface PaletteData {
  lifecycleAvailable: boolean;
  threads: PaletteThread[];
  projects: PaletteProject[];
}

/** Root list, or the actions for one thread. */
type View = { kind: "root" } | { kind: "actions"; threadId: string };

/** Actions that change a flag the list shows; the palette stays open for them. */
const STAY_OPEN = new Set(["pin", "unpin", "markRead", "markUnread"]);

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-sm border border-border px-1 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

/** The thread cmdk currently highlights, read from the DOM cmdk owns. */
function highlightedThreadId(): string | null {
  const element = document.querySelector<HTMLElement>(
    '[cmdk-item][data-selected="true"][data-thread-id]',
  );
  return element?.dataset.threadId ?? null;
}

function caretAtEnd(input: HTMLInputElement): boolean {
  return input.selectionStart === input.value.length;
}

function caretAtStart(input: HTMLInputElement): boolean {
  return input.selectionStart === 0 && input.selectionEnd === 0;
}

function Palette() {
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState<View>({ kind: "root" });
  const [query, setQuery] = React.useState("");
  const [data, setData] = React.useState<PaletteData | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [currentId, setCurrentId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [threads, projects] = await Promise.all([
        rpc.listThreads(),
        rpc.listProjects(),
      ]);
      setData({
        lifecycleAvailable: threads.lifecycleAvailable,
        threads: threads.threads,
        projects: projects.projects,
      });
    } catch (error) {
      toast.error(`Command palette: ${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // ⌘K / Ctrl-K toggles, in the capture phase so the host cannot swallow it.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setOpen((wasOpen) => !wasOpen);
    };
    document.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      document.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);

  // Every opening reads fresh data: a stale thread list is worse than a wait.
  React.useEffect(() => {
    if (!open) return;
    setView({ kind: "root" });
    setQuery("");
    setCurrentId(currentThreadId(window.location.pathname));
    void load();
  }, [open, load]);

  const close = () => setOpen(false);

  const goToRoot = () => {
    setView({ kind: "root" });
    setQuery("");
  };

  const openThread = (thread: PaletteThread) => {
    navigate(threadPath(thread.id, thread.projectId));
    close();
  };

  const runAction = async (threadId: string, action: string) => {
    try {
      await rpc.threadAction(threadId, action);
    } catch (error) {
      toast.error(`${action} failed: ${(error as Error).message}`);
      return;
    }
    if (STAY_OPEN.has(action)) {
      await load();
      return;
    }
    close();
  };

  const runSnooze = async (threadId: string, snoozedUntil: number) => {
    try {
      await rpc.snooze(threadId, snoozedUntil);
    } catch (error) {
      toast.error(`Snooze failed: ${(error as Error).message}`);
      return;
    }
    close();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const input = event.target as HTMLInputElement;
    const isInput = input instanceof HTMLInputElement;

    if (view.kind === "root") {
      const forward =
        event.key === "Tab" ||
        (event.key === "ArrowRight" && isInput && caretAtEnd(input));
      if (!forward) return;
      const threadId = highlightedThreadId();
      if (threadId === null) return;
      event.preventDefault();
      setView({ kind: "actions", threadId });
      setQuery("");
      return;
    }

    const back =
      (event.key === "ArrowLeft" && isInput && caretAtStart(input)) ||
      (event.key === "Backspace" && isInput && input.value === "");
    if (!back) return;
    event.preventDefault();
    goToRoot();
  };

  const activeThread =
    view.kind === "actions"
      ? (data?.threads.find((thread) => thread.id === view.threadId) ?? null)
      : null;

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <div onKeyDownCapture={onKeyDown} className="contents">
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder={
            activeThread === null
              ? "Search threads, or start a new one…"
              : `${activeThread.title} — pick an action`
          }
        />
        <CommandList>
          <CommandEmpty>
            {loading ? "Loading…" : "Nothing matches."}
          </CommandEmpty>
          {view.kind === "root" ? (
            <RootView
              data={data}
              currentThread={
                data?.threads.find((thread) => thread.id === currentId) ?? null
              }
              onThread={openThread}
              onAction={(threadId, action) => void runAction(threadId, action)}
              onSnooze={(threadId, at) => void runSnooze(threadId, at)}
              onClose={close}
            />
          ) : activeThread === null ? null : (
            <ActionsView
              thread={activeThread}
              lifecycleAvailable={data?.lifecycleAvailable ?? false}
              onOpen={() => openThread(activeThread)}
              onAction={(action) => void runAction(activeThread.id, action)}
              onSnooze={(at) => void runSnooze(activeThread.id, at)}
              onBack={goToRoot}
            />
          )}
        </CommandList>
      </div>
    </CommandDialog>
  );
}

function RootView({
  data,
  currentThread,
  onThread,
  onAction,
  onSnooze,
  onClose,
}: {
  data: PaletteData | null;
  currentThread: PaletteThread | null;
  onThread: (thread: PaletteThread) => void;
  onAction: (threadId: string, action: string) => void;
  onSnooze: (threadId: string, snoozedUntil: number) => void;
  onClose: () => void;
}) {
  const startThread = (projectId: string | null) => {
    navigate(newThreadPath(projectId));
    onClose();
  };
  return (
    <>
      {currentThread === null ? null : (
        <>
          <CommandGroup heading={`Current thread · ${currentThread.title}`}>
            <ThreadActionItems
              thread={currentThread}
              lifecycleAvailable={data?.lifecycleAvailable ?? false}
              onAction={(action) => onAction(currentThread.id, action)}
              onSnooze={(at) => onSnooze(currentThread.id, at)}
            />
          </CommandGroup>
          <CommandSeparator />
        </>
      )}
      <CommandGroup heading="Actions">
        <CommandItem
          value="home"
          keywords={["new thread", "compose"]}
          onSelect={() => startThread(null)}
        >
          Home
          <span className="ml-auto text-xs text-muted-foreground">
            New thread
          </span>
        </CommandItem>
        {(data?.projects ?? []).map((project) => (
          <CommandItem
            key={project.id}
            value={`new thread in ${project.name} ${project.id}`}
            onSelect={() => startThread(project.id)}
          >
            New thread in {project.name}
          </CommandItem>
        ))}
      </CommandGroup>
      <CommandSeparator />
      <CommandGroup heading="Threads">
        {(data?.threads ?? []).map((thread) => (
          <CommandItem
            key={thread.id}
            data-thread-id={thread.id}
            value={`${thread.title} ${thread.projectName} ${thread.id}`}
            onSelect={() => onThread(thread)}
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{thread.title}</span>
              {thread.projectName === "" ? null : (
                <span className="truncate text-xs text-muted-foreground">
                  {thread.projectName}
                </span>
              )}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {thread.isUnread ? <Badge>New</Badge> : null}
              {thread.isPinned ? <Badge>Pinned</Badge> : null}
              {thread.settled ? <Badge>Settled</Badge> : null}
              {thread.snoozedUntil === null ? null : <Badge>Snoozed</Badge>}
              <span className="text-xs text-muted-foreground">›</span>
            </div>
          </CommandItem>
        ))}
      </CommandGroup>
    </>
  );
}

/** The actions for one thread, flat, so a group or a view can hold them. */
function ThreadActionItems({
  thread,
  lifecycleAvailable,
  onAction,
  onSnooze,
}: {
  thread: PaletteThread;
  lifecycleAvailable: boolean;
  onAction: (action: string) => void;
  onSnooze: (snoozedUntil: number) => void;
}) {
  const choices = React.useMemo(() => snoozeChoices(Date.now()), [thread.id]);
  return (
    <>
      <CommandItem
        value={thread.isPinned ? "unpin" : "pin"}
        onSelect={() => onAction(thread.isPinned ? "unpin" : "pin")}
      >
        {thread.isPinned ? "Unpin" : "Pin"}
      </CommandItem>
      <CommandItem
        value={thread.isUnread ? "mark read" : "mark unread"}
        onSelect={() => onAction(thread.isUnread ? "markRead" : "markUnread")}
      >
        {thread.isUnread ? "Mark read" : "Mark unread"}
      </CommandItem>
      <CommandItem value="archive" onSelect={() => onAction("archive")}>
        Archive
      </CommandItem>
      {lifecycleAvailable ? (
        <>
          <CommandItem
            value={thread.settled ? "unsettle" : "settle"}
            onSelect={() => onAction(thread.settled ? "unsettle" : "settle")}
          >
            {thread.settled ? "Unsettle" : "Settle"}
          </CommandItem>
          {thread.snoozedUntil === null ? null : (
            <CommandItem value="unsnooze" onSelect={() => onAction("unsnooze")}>
              Unsnooze
            </CommandItem>
          )}
          {choices.map((choice) => (
            <CommandItem
              key={choice.id}
              value={choice.label}
              onSelect={() => onSnooze(choice.snoozedUntil)}
            >
              {choice.label}
            </CommandItem>
          ))}
        </>
      ) : null}
    </>
  );
}

function ActionsView({
  thread,
  lifecycleAvailable,
  onOpen,
  onAction,
  onSnooze,
  onBack,
}: {
  thread: PaletteThread;
  lifecycleAvailable: boolean;
  onOpen: () => void;
  onAction: (action: string) => void;
  onSnooze: (snoozedUntil: number) => void;
  onBack: () => void;
}) {
  return (
    <>
      <CommandGroup heading={thread.title}>
        <CommandItem value="open thread" onSelect={onOpen}>
          Open
        </CommandItem>
        <ThreadActionItems
          thread={thread}
          lifecycleAvailable={lifecycleAvailable}
          onAction={onAction}
          onSnooze={onSnooze}
        />
      </CommandGroup>
      <CommandSeparator />
      <CommandGroup>
        <CommandItem value="back to all threads" onSelect={onBack}>
          Back
        </CommandItem>
      </CommandGroup>
    </>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "command-palette",
    mount({ signal }) {
      const container = document.createElement("div");
      container.dataset.pluginCommandPalette = "";
      document.body.append(container);
      const root = createRoot(container);
      root.render(<Palette />);

      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        root.unmount();
        container.remove();
      };
      signal.addEventListener("abort", dispose, { once: true });
      return dispose;
    },
  });
});
