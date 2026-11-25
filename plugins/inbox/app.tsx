// bb-plugin-inbox — the frontend bundle.
//
// One "Inbox" destination in the navigation rail:
//   - a badge with the number of open items (warning tone while one is unread);
//   - a sidebar with the item list: unread first, then newest ask first, and a
//     collapsed "Snoozed (N)" group at the bottom;
//   - a page that shows one item (its id is the subPath) with the actions that
//     answer, finish, snooze, dismiss, or hand it on.
// The three share one store (hooks/use-inbox.ts). This file talks to the
// server only through the RPC contract, and imports its types only.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Markdown,
  UrlLink,
  definePluginApp,
  useBbNavigate,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { CardDecision, Item } from "./contract";
import {
  KIND_LABELS,
  SOURCE_LABELS,
  badgeFor,
  canAcceptRecommendation,
  cardAnswers,
  errorText,
  groupItems,
  isSnoozed,
  isUnread,
  laterToday,
  nextMondayMorning,
  parseLocalDateTime,
  recommendationText,
  relativeAge,
  threadLine,
  tomorrowMorning,
  wakeLabel,
  type DecisionPick,
} from "./lib/inbox";
import {
  upsertItem,
  useInbox,
  useNow,
  type InboxRpc,
} from "./hooks/use-inbox";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
import { useIsCompactViewport } from "./components/ui/hooks/use-compact-viewport";
import { cn } from "./lib/utils";

const PANEL_ID = "inbox";
const PANEL_PATH = "inbox";
/** How long the confirmation line stays after an action. */
const FLASH_MS = 4_000;

/** The item id in the subPath, or null at the panel root. */
function selectedIdFrom(subPath: string): string | null {
  const segment = subPath.split("/")[0] ?? "";
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

// ---------------------------------------------------------------------------
// Badge

function useInboxBadge() {
  const { items } = useInbox();
  const now = useNow();
  return badgeFor(items, now);
}

// ---------------------------------------------------------------------------
// Small pieces

function KindChip({ item }: { item: Item }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded bg-muted px-1 py-px text-[10px] font-medium leading-4 text-muted-foreground">
      {KIND_LABELS[item.kind]}
    </span>
  );
}

function UnreadDot({ unread }: { unread: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-[7px] size-1.5 shrink-0 rounded-full",
        unread ? "bg-primary" : "bg-transparent",
      )}
    />
  );
}

function ItemRow({
  item,
  selected,
  now,
  onSelect,
}: {
  item: Item;
  selected: boolean;
  now: number;
  onSelect: (item: Item) => void;
}) {
  const unread = isUnread(item);
  const snoozed = isSnoozed(item, now);
  return (
    <li>
      <button
        type="button"
        data-item-id={item.id}
        aria-current={selected ? "page" : undefined}
        aria-label={`${unread ? "Unread. " : ""}${KIND_LABELS[item.kind]}: ${item.question}`}
        onClick={() => onSelect(item)}
        className={cn(
          "flex w-full gap-2 rounded-md px-2 py-2 text-left transition-colors duration-150",
          "hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          selected && "bg-state-active hover:bg-state-active",
        )}
      >
        <UnreadDot unread={unread} />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <KindChip item={item} />
            {snoozed && item.snoozedUntil !== null && (
              <span className="truncate">
                until {wakeLabel(item.snoozedUntil, now)}
              </span>
            )}
            <span className="flex-1" />
            {item.askCount > 1 && (
              <span
                className="tabular-nums"
                title={`Asked ${item.askCount} times`}
              >
                ×{item.askCount}
              </span>
            )}
            <span className="tabular-nums">
              {relativeAge(item.lastAskedAt, now)}
            </span>
          </span>
          <span
            className={cn(
              "line-clamp-2 text-[13px] leading-snug break-words",
              unread ? "font-medium text-foreground" : "text-foreground/85",
            )}
          >
            {item.question}
          </span>
          <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">{threadLine(item)}</span>
            <span className="shrink-0 opacity-70">
              {SOURCE_LABELS[item.source]}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

/** The list the sidebar shows, and the page shows on a phone. */
function ItemList({ selectedId }: { selectedId: string | null }) {
  const { items, loaded, error } = useInbox();
  const now = useNow();
  const navigate = useBbNavigate();
  const { open, snoozed } = groupItems(items, now);
  const selectedIsSnoozed = snoozed.some((item) => item.id === selectedId);
  const [showSnoozed, setShowSnoozed] = useState(selectedIsSnoozed);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedIsSnoozed) setShowSnoozed(true);
  }, [selectedIsSnoozed]);

  // When j/k moves the selection while a row has focus, focus follows it.
  useEffect(() => {
    const root = listRef.current;
    if (!root || !selectedId) return;
    if (!root.contains(document.activeElement)) return;
    const row = root.querySelector<HTMLElement>(
      `[data-item-id="${CSS.escape(selectedId)}"]`,
    );
    row?.focus();
  }, [selectedId]);

  const select = (item: Item) =>
    navigate.toPluginPanel(PANEL_PATH, { subPath: item.id });

  return (
    <div ref={listRef} className="flex flex-col gap-1">
      {error && (
        <p role="alert" className="px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      )}
      {!loaded && (
        <p className="px-2 py-3 text-xs text-muted-foreground">Loading…</p>
      )}
      {loaded && open.length === 0 && (
        <p className="px-2 py-6 text-center text-[13px] text-muted-foreground">
          Nothing waits on you.
        </p>
      )}
      {open.length > 0 && (
        <ul aria-label="Waiting" className="flex flex-col gap-px">
          {open.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              now={now}
              selected={item.id === selectedId}
              onSelect={select}
            />
          ))}
        </ul>
      )}
      {snoozed.length > 0 && (
        <div className="mt-2 border-t border-border pt-2">
          <button
            type="button"
            aria-expanded={showSnoozed}
            onClick={() => setShowSnoozed((value) => !value)}
            className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-xs font-medium text-muted-foreground hover:bg-state-hover hover:text-foreground"
          >
            <Icon
              name={showSnoozed ? "ChevronDown" : "ChevronRight"}
              className="size-3.5"
              aria-hidden
            />
            Snoozed ({snoozed.length})
          </button>
          {showSnoozed && (
            <ul aria-label="Snoozed" className="mt-1 flex flex-col gap-px">
              {snoozed.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  now={now}
                  selected={item.id === selectedId}
                  onSelect={select}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function InboxSidebar({ subPath }: PluginNavPanelProps) {
  return (
    <nav aria-label="Inbox items" className="h-full overflow-y-auto p-2">
      <ItemList selectedId={selectedIdFrom(subPath)} />
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Page

function DetectionLine() {
  const { detection } = useInbox();
  if (!detection) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {detection.enabled
        ? `Prose detection on (${detection.model}).`
        : `Prose detection off: ${detection.reason ?? "not configured"}`}
    </p>
  );
}

function Flash({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p
      role="status"
      className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-2 text-xs text-foreground"
    >
      <Icon name="Check" className="size-3.5 text-muted-foreground" aria-hidden />
      {text}
    </p>
  );
}

function InboxHome({ flash }: { flash: string | null }) {
  const { items, loaded } = useInbox();
  const now = useNow();
  const compact = useIsCompactViewport();
  const navigate = useBbNavigate();
  const { open, snoozed } = groupItems(items, now);
  const unread = open.filter(isUnread).length;

  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <Flash text={flash} />
        {compact ? (
          <ItemList selectedId={null} />
        ) : (
          <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 text-center">
            <Icon
              name="Inbox"
              className="size-6 text-muted-foreground/60"
              aria-hidden
            />
            {!loaded ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : open.length === 0 ? (
              <>
                <p className="text-sm font-medium text-foreground">
                  Nothing waits on you.
                </p>
                <p className="text-xs text-muted-foreground">
                  {snoozed.length > 0
                    ? `${snoozed.length} snoozed.`
                    : "New asks from your threads show up here."}
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-foreground">
                  {open.length} waiting
                  {unread > 0 ? ` · ${unread} unread` : ""}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    navigate.toPluginPanel(PANEL_PATH, {
                      subPath: open[0]!.id,
                    })
                  }
                >
                  Open the first
                </Button>
                <p className="text-xs text-muted-foreground">
                  Use j and k to move through the list.
                </p>
              </>
            )}
          </div>
        )}
        <div className={cn(compact ? "pt-2" : "text-center")}>
          <DetectionLine />
        </div>
      </div>
    </div>
  );
}

const CLOSE_LABELS: Record<string, string> = {
  answered: "Answered",
  done: "Done",
  dismissed: "Dismissed",
  handed: "Handed to the parent thread",
  archived: "Thread archived",
  "card-settled": "Settled in the thread",
  resolved: "Resolved in the thread",
  closed: "Closed",
};

type Run = (
  confirmation: string | ((item: Item) => string),
  action: () => Promise<Item>,
) => Promise<void>;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function OptionButton({
  label,
  detail,
  recommended,
  disabled,
  onClick,
}: {
  label: string;
  detail?: string;
  recommended: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors duration-150",
        "hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        recommended ? "border-primary/40" : "border-border",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-foreground">{label}</span>
        {detail && (
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {detail}
          </span>
        )}
      </span>
      {recommended && (
        <span className="shrink-0 text-[11px] font-medium text-primary">
          Recommended
        </span>
      )}
    </button>
  );
}

function Links({ decision }: { decision: CardDecision }) {
  if (decision.links.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
      {decision.links.map((link) => (
        <li key={link.href}>
          <UrlLink href={link.href} className="text-primary hover:underline">
            {link.label}
          </UrlLink>
        </li>
      ))}
    </ul>
  );
}

/** Options for a tool or detected item, or a card with one decision. */
function SingleOptions({
  item,
  busy,
  run,
  rpc,
}: {
  item: Item;
  busy: boolean;
  run: Run;
  rpc: InboxRpc;
}) {
  const decision = item.card?.decisions.length === 1 ? item.card.decisions[0]! : null;
  if (decision) {
    if (decision.options.length === 0) return null;
    return (
      <Section title="Options">
        <div className="space-y-1.5">
          {decision.options.map((option, index) => (
            <OptionButton
              key={index}
              label={option.label}
              detail={option.does}
              recommended={decision.suggested === index}
              disabled={busy}
              onClick={() =>
                void run(`Answered: ${option.label}`, () =>
                  rpc.call("items_answer", {
                    id: item.id,
                    answers: [{ option: index }],
                  }),
                )
              }
            />
          ))}
        </div>
        <Links decision={decision} />
      </Section>
    );
  }
  if (item.source === "card" || !item.options || item.options.length === 0) {
    return null;
  }
  return (
    <Section title="Options">
      <div className="space-y-1.5">
        {item.options.map((label) => (
          <OptionButton
            key={label}
            label={label}
            recommended={item.recommendation === label}
            disabled={busy}
            onClick={() =>
              void run(`Answered: ${label}`, () =>
                rpc.call("items_answer", { id: item.id, text: label }),
              )
            }
          />
        ))}
      </div>
    </Section>
  );
}

/** A card with several decisions: one pick or own answer each, one Submit. */
function MultiDecisionForm({
  item,
  decisions,
  busy,
  run,
  rpc,
}: {
  item: Item;
  decisions: CardDecision[];
  busy: boolean;
  run: Run;
  rpc: InboxRpc;
}) {
  const [picks, setPicks] = useState<DecisionPick[]>(() =>
    decisions.map(() => null),
  );
  const answers = cardAnswers(picks);
  const setPick = (index: number, pick: DecisionPick) =>
    setPicks((current) => current.map((value, i) => (i === index ? pick : value)));

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!answers) return;
        void run("Answered", () =>
          rpc.call("items_answer", { id: item.id, answers }),
        );
      }}
    >
      {decisions.map((decision, index) => {
        const pick = picks[index] ?? null;
        const name = `${item.id}-decision-${index}`;
        return (
          <fieldset key={index} className="space-y-2">
            <legend className="text-sm font-medium text-foreground">
              <span className="mr-1.5 text-muted-foreground tabular-nums">
                {index + 1}.
              </span>
              {decision.question}
            </legend>
            {decision.context && (
              <Markdown
                content={decision.context}
                className="text-sm text-muted-foreground"
              />
            )}
            <div className="space-y-1">
              {decision.options.map((option, optionIndex) => (
                <label
                  key={optionIndex}
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 text-sm hover:bg-state-hover",
                    pick?.kind === "option" && pick.option === optionIndex
                      ? "border-foreground/40 bg-state-active"
                      : "border-border",
                  )}
                >
                  <input
                    type="radio"
                    name={name}
                    className="mt-1 accent-current"
                    checked={pick?.kind === "option" && pick.option === optionIndex}
                    onChange={() =>
                      setPick(index, { kind: "option", option: optionIndex })
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-foreground">
                      {option.label}
                    </span>
                    {option.does && (
                      <span className="block text-xs text-muted-foreground">
                        {option.does}
                      </span>
                    )}
                  </span>
                  {decision.suggested === optionIndex && (
                    <span className="shrink-0 text-[11px] font-medium text-primary">
                      Recommended
                    </span>
                  )}
                </label>
              ))}
            </div>
            <input
              type="text"
              aria-label={`Own answer for decision ${index + 1}`}
              placeholder="Or write your own answer"
              value={pick?.kind === "text" ? pick.text : ""}
              onChange={(event) =>
                setPick(
                  index,
                  event.target.value
                    ? { kind: "text", text: event.target.value }
                    : null,
                )
              }
              className="h-8 w-full rounded-md border border-input bg-transparent px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <Links decision={decision} />
          </fieldset>
        );
      })}
      <Button type="submit" size="sm" disabled={busy || !answers}>
        Submit answers
      </Button>
    </form>
  );
}

function ReplyBox({
  item,
  busy,
  run,
  rpc,
}: {
  item: Item;
  busy: boolean;
  run: Run;
  rpc: InboxRpc;
}) {
  const [text, setText] = useState("");
  const isCard = item.source === "card";
  const send = () => {
    const value = text.trim();
    if (!value) return;
    void run("Replied", () =>
      rpc.call(
        "items_answer",
        isCard
          ? { id: item.id, answers: [{ text: value }] }
          : { id: item.id, text: value },
      ),
    );
  };
  return (
    <Section title={isCard ? "Own answer" : "Reply"}>
      <textarea
        aria-label={isCard ? "Own answer" : "Reply"}
        value={text}
        rows={3}
        placeholder={isCard ? "Write your own answer" : "Write a reply to the thread"}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            send();
          }
        }}
        className="block w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          Ctrl/⌘ + Enter sends
        </span>
        <Button size="sm" disabled={busy || !text.trim()} onClick={send}>
          Send
        </Button>
      </div>
    </Section>
  );
}

function SnoozeMenu({
  item,
  busy,
  run,
  rpc,
}: {
  item: Item;
  busy: boolean;
  run: Run;
  rpc: InboxRpc;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  // A click outside closes the menu.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);
  const now = Date.now();
  const snooze = (until: number) => {
    setOpen(false);
    void run(`Snoozed until ${wakeLabel(until, Date.now())}`, () =>
      rpc.call("items_snooze", { id: item.id, until }),
    );
  };
  const customUntil = parseLocalDateTime(custom, now);

  return (
    <div ref={rootRef} className="relative">
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="Clock" aria-hidden />
        Snooze
      </Button>
      {open && (
        <div
          role="menu"
          aria-label="Snooze until"
          className="absolute bottom-full left-0 z-10 mb-1 w-64 space-y-0.5 rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          {[
            { label: "Later today", until: laterToday(now) },
            { label: "Tomorrow", until: tomorrowMorning(now) },
            { label: "Next Monday", until: nextMondayMorning(now) },
          ].map((choice) => (
            <button
              key={choice.label}
              type="button"
              role="menuitem"
              onClick={() => snooze(choice.until)}
              className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-state-hover"
            >
              <span>{choice.label}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {wakeLabel(choice.until, now)}
              </span>
            </button>
          ))}
          <div className="flex items-center gap-1 border-t border-border px-1 pt-1.5 pb-1">
            <input
              type="datetime-local"
              aria-label="Snooze until date and time"
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={customUntil === null}
              onClick={() => customUntil !== null && snooze(customUntil)}
            >
              Set
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The item ids in list order: open first, then snoozed. */
function listOrder(items: readonly Item[], now: number): string[] {
  const { open, snoozed } = groupItems(items, now);
  return [...open, ...snoozed].map((item) => item.id);
}

function ItemView({
  id,
  onFlash,
}: {
  id: string;
  onFlash: (text: string) => void;
}) {
  const { items, loaded, rpc } = useInbox();
  const now = useNow();
  const navigate = useBbNavigate();
  const listed = items.find((item) => item.id === id) ?? null;
  const [fetched, setFetched] = useState<Item | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const marked = useRef<string | null>(null);
  const item = listed ?? (fetched?.id === id ? fetched : null);

  // An item not in the list is closed or gone: fetch it once to show why.
  useEffect(() => {
    if (!loaded || listed || fetched?.id === id) return;
    let live = true;
    setMissing(false);
    rpc.call("items_get", { id }).then(
      (result) => live && setFetched(result),
      () => live && setMissing(true),
    );
    return () => {
      live = false;
    };
  }, [id, loaded, listed, fetched?.id, rpc]);

  // Opening an unread item marks it read, once.
  useEffect(() => {
    if (!listed || listed.readAt !== null || marked.current === id) return;
    marked.current = id;
    rpc.call("items_mark_read", { id }).then(upsertItem, () => {
      // Not fatal: the item stays unread and the next open tries again.
      marked.current = null;
    });
  }, [id, listed, rpc]);

  useEffect(() => setError(null), [id]);

  const run: Run = async (confirmation, action) => {
    setBusy(true);
    setError(null);
    const openIds = groupItems(items, Date.now()).open.map((other) => other.id);
    try {
      const updated = await action();
      const text =
        typeof confirmation === "function" ? confirmation(updated) : confirmation;
      const leaves = updated.status !== "open";
      upsertItem(updated);
      // Keep showing the closed item until the next one opens.
      if (updated.status === "closed") setFetched(updated);
      onFlash(text);
      if (leaves) {
        // Go on to the next open item, or back to the empty state.
        const index = openIds.indexOf(id);
        const next =
          index >= 0
            ? (openIds[index + 1] ?? openIds[index - 1])
            : openIds[0];
        navigate.toPluginPanel(PANEL_PATH, { subPath: next ?? "" });
      }
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  if (!item) {
    return (
      <div className="h-full overflow-y-auto p-4 md:p-5">
        <div className="mx-auto w-full max-w-3xl space-y-3 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            {missing ? "This item is gone." : "Loading…"}
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "" })}
          >
            Back to the inbox
          </Button>
        </div>
      </div>
    );
  }

  const closed = item.status === "closed";
  const snoozed = isSnoozed(item, now);
  const decisions = item.card?.decisions ?? [];
  const multi = item.source === "card" && decisions.length > 1;
  const recommendation = recommendationText(item);
  const canAccept = !closed && canAcceptRecommendation(item);
  const openThread = () =>
    navigate.toThread(
      item.threadId,
      item.messageSeq !== null && item.messageSeq >= 0
        ? { messageSeq: item.messageSeq }
        : undefined,
    );

  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <article className="mx-auto w-full max-w-3xl space-y-5" aria-busy={busy}>
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <KindChip item={item} />
            <span>{SOURCE_LABELS[item.source]}</span>
            <span aria-hidden>·</span>
            <span title={new Date(item.lastAskedAt).toLocaleString()}>
              {relativeAge(item.lastAskedAt, now)} ago
            </span>
            {item.askCount > 1 && (
              <>
                <span aria-hidden>·</span>
                <span>asked {item.askCount} times</span>
              </>
            )}
            {snoozed && item.snoozedUntil !== null && (
              <>
                <span aria-hidden>·</span>
                <span>snoozed until {wakeLabel(item.snoozedUntil, now)}</span>
              </>
            )}
          </div>
          <h1 className="text-lg leading-snug font-semibold text-foreground break-words">
            {item.question}
          </h1>
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">{threadLine(item)}</span>
            <button
              type="button"
              onClick={openThread}
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              Open thread
              <Icon name="ArrowUpRight" className="size-3" aria-hidden />
            </button>
          </div>
        </header>

        {closed && (
          <p className="rounded-md bg-muted px-3 py-2 text-sm text-foreground">
            {CLOSE_LABELS[item.closeReason ?? "closed"] ?? "Closed"}
            {item.answer ? `: ${item.answer}` : "."}
          </p>
        )}

        {item.context && !multi && (
          <Markdown content={item.context} className="text-sm" />
        )}

        {recommendation && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-primary">
                Recommended
              </p>
              <p className="text-sm text-foreground break-words">
                {recommendation}
              </p>
            </div>
            {canAccept && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run("Accepted the recommendation", () =>
                    rpc.call(
                      "items_answer",
                      // Send the text on screen: a repeated ask can change the
                      // recommendation before this page refreshes. A card's
                      // suggested options do not change.
                      item.source === "card" || !item.recommendation
                        ? { id: item.id, acceptRecommendation: true }
                        : { id: item.id, text: item.recommendation },
                    ),
                  )
                }
              >
                Accept recommendation
              </Button>
            )}
          </div>
        )}

        {!closed &&
          (multi ? (
            <MultiDecisionForm
              key={item.id}
              item={item}
              decisions={decisions}
              busy={busy}
              run={run}
              rpc={rpc}
            />
          ) : (
            <>
              <SingleOptions item={item} busy={busy} run={run} rpc={rpc} />
              <ReplyBox key={item.id} item={item} busy={busy} run={run} rpc={rpc} />
            </>
          ))}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {!closed && (
          <footer className="flex flex-wrap items-center gap-1 border-t border-border pt-3">
            {item.kind === "do" && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run("Marked done", () =>
                    rpc.call("items_done", { id: item.id }),
                  )
                }
              >
                <Icon name="Check" aria-hidden />
                Done
              </Button>
            )}
            {snoozed ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run("Back in the inbox", () =>
                    rpc.call("items_unsnooze", { id: item.id }),
                  )
                }
              >
                Unsnooze
              </Button>
            ) : (
              <SnoozeMenu item={item} busy={busy} run={run} rpc={rpc} />
            )}
            {item.parentThreadId && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run("Handed to the parent thread", () =>
                    rpc.call("items_hand_to_parent", { id: item.id }),
                  )
                }
              >
                Hand to parent
              </Button>
            )}
            <span className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              className="text-muted-foreground"
              onClick={() =>
                void run("Dismissed", () =>
                  rpc.call("items_dismiss", { id: item.id }),
                )
              }
            >
              Dismiss
            </Button>
          </footer>
        )}
      </article>
    </div>
  );
}

function InboxPage({ subPath }: PluginNavPanelProps) {
  const selectedId = selectedIdFrom(subPath);
  const { items } = useInbox();
  const now = useNow();
  const navigate = useBbNavigate();
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  // j / k move through the list from anywhere on the page or the sidebar.
  const order = listOrder(items, now);
  const orderRef = useRef(order);
  orderRef.current = order;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.key !== "j" && event.key !== "k") return;
      if (isEditable(event.target)) return;
      const ids = orderRef.current;
      if (ids.length === 0) return;
      // A second page in a split sees the event as handled and skips it.
      event.preventDefault();
      const index = selectedId ? ids.indexOf(selectedId) : -1;
      const nextIndex =
        event.key === "j"
          ? Math.min(ids.length - 1, index + 1)
          : Math.max(0, index - 1);
      const next = ids[nextIndex];
      if (next && next !== selectedId) {
        navigate.toPluginPanel(PANEL_PATH, { subPath: next });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navigate, selectedId]);

  if (!selectedId) return <InboxHome flash={flash} />;
  return (
    <div className="flex h-full flex-col">
      {flash && (
        <div className="mx-auto w-full max-w-3xl px-4 pt-4 md:px-5">
          <Flash text={flash} />
        </div>
      )}
      <div className="min-h-0 flex-1">
        <ItemView key={selectedId} id={selectedId} onFlash={setFlash} />
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: PANEL_ID,
    title: "Inbox",
    icon: "Inbox",
    path: PANEL_PATH,
    component: InboxPage,
    experimental_sidebar: InboxSidebar,
    experimental_useBadge: useInboxBadge,
  });
});
