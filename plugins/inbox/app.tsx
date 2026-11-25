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
import type { CardDecision, CloseReason, Item, ItemKind } from "./contract";
import {
  KIND_LABELS,
  SOURCE_LABELS,
  SOURCE_PHRASES,
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
import {
  ApproveGlyph,
  CheckGlyph,
  CircleCheckGlyph,
  HandGlyph,
  SplitGlyph,
  ThumbGlyph,
  TrayGlyph,
} from "./components/ui/glyphs";
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

/** Each kind keeps one glyph and one hue, in the list and on the page. */
const KIND_STYLE: Record<
  ItemKind,
  { Glyph: typeof SplitGlyph; hue: string }
> = {
  decide: { Glyph: SplitGlyph, hue: "text-timeline-accent" },
  approve: { Glyph: ApproveGlyph, hue: "text-attention" },
  do: { Glyph: HandGlyph, hue: "text-warning" },
};

function KindTag({ kind, large = false }: { kind: ItemKind; large?: boolean }) {
  const { Glyph, hue } = KIND_STYLE[kind];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center font-medium",
        large
          ? "gap-1.5 text-xs text-foreground"
          : "gap-1 text-[11px] text-muted-foreground",
      )}
    >
      <Glyph className={cn(large ? "size-3.5" : "size-3", hue)} strokeWidth={2.25} />
      {KIND_LABELS[kind]}
    </span>
  );
}

/** Key caps for keyboard hints. */
function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border bg-surface-raised px-1 font-sans text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
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
            <KindTag kind={item.kind} />
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
        <p className="flex items-center gap-2 px-2 py-2 text-[13px] text-muted-foreground">
          <CheckGlyph className="size-3.5 text-success" strokeWidth={2.5} />
          All clear
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

/** Whether final replies are read for asks, as one quiet status line. */
function DetectionStatus() {
  const { detection } = useInbox();
  if (!detection) return null;
  return (
    <p className="flex items-start justify-center gap-2 text-xs text-muted-foreground">
      <span
        aria-hidden
        className={cn(
          "mt-[5px] size-1.5 shrink-0 rounded-full",
          detection.enabled ? "bg-success" : "bg-muted-foreground/40",
        )}
      />
      <span className="text-balance">
        {detection.enabled
          ? `Final replies are scanned for asks (${detection.model}).`
          : `Final replies are not scanned for asks: ${detection.reason ?? "not configured"}`}
      </span>
    </p>
  );
}

function Flash({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p
      role="status"
      className="flex items-center gap-2 rounded-lg bg-surface-recessed px-3 py-2 text-[13px] text-foreground motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-200"
    >
      <CheckGlyph className="size-3.5 shrink-0 text-success" strokeWidth={2.5} />
      {text}
    </p>
  );
}

/** The tray mark; with `cleared`, a check settles on its corner. */
function TrayEmblem({ cleared }: { cleared: boolean }) {
  return (
    <div className="relative grid size-16 place-items-center rounded-2xl border border-border bg-surface-raised text-muted-foreground">
      <TrayGlyph className="size-7" strokeWidth={1.5} />
      {cleared && (
        <span className="absolute -right-2 -bottom-2 grid size-6 place-items-center rounded-full bg-success text-background ring-4 ring-background motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:fade-in motion-safe:duration-500 motion-safe:ease-out">
          <CheckGlyph className="size-3.5" strokeWidth={3} />
        </span>
      )}
    </div>
  );
}

function InboxHome({ flash }: { flash: string | null }) {
  const { items, loaded, error } = useInbox();
  const now = useNow();
  const compact = useIsCompactViewport();
  const navigate = useBbNavigate();
  const { open, snoozed } = groupItems(items, now);
  const unread = open.filter(isUnread).length;
  const nextWake = snoozed[0]?.snoozedUntil ?? null;
  // A phone has no sidebar: the page shows the list while it has rows,
  // and shows it on a load error, which only the list displays.
  const showList =
    compact && (open.length > 0 || snoozed.length > 0 || error !== null);

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4 md:p-6">
      <div className="mx-auto w-full max-w-2xl">
        <Flash text={flash} />
      </div>
      {showList ? (
        <div className="mx-auto w-full max-w-2xl flex-1 pt-2">
          <ItemList selectedId={null} />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center px-2 py-12 text-center">
          {!loaded ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : open.length === 0 ? (
            <>
              <TrayEmblem cleared />
              <h1 className="mt-7 text-xl font-semibold tracking-[-0.02em] text-foreground">
                Nothing waits on you.
              </h1>
              <p className="mt-2 max-w-sm text-sm leading-relaxed text-balance text-muted-foreground">
                When a thread needs a decision, an approval, or a task only
                you can do, it lands here.
              </p>
              {snoozed.length > 0 && nextWake !== null && (
                <p className="mt-4 text-xs text-muted-foreground tabular-nums">
                  {snoozed.length} snoozed · the next one is back{" "}
                  {wakeLabel(nextWake, now)}
                </p>
              )}
            </>
          ) : (
            <>
              <TrayEmblem cleared={false} />
              <h1 className="mt-7 text-xl font-semibold tracking-[-0.02em] text-foreground tabular-nums">
                {open.length} waiting
                {unread > 0 && (
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    · {unread} unread
                  </span>
                )}
              </h1>
              <Button
                className="mt-5"
                onClick={() =>
                  navigate.toPluginPanel(PANEL_PATH, {
                    subPath: open[0]!.id,
                  })
                }
              >
                Open the first
              </Button>
              <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Kbd>J</Kbd>
                <Kbd>K</Kbd>
                move through the list
              </p>
            </>
          )}
        </div>
      )}
      {loaded && (
        <div className="shrink-0 pt-6 pb-2">
          <DetectionStatus />
        </div>
      )}
    </div>
  );
}

const CLOSE_LABELS: Record<CloseReason, string> = {
  answered: "Answered",
  "answered-in-thread": "Answered in the thread",
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
  /** Where a failure shows: next to the header actions or the answer. */
  place?: "header" | "answer",
) => Promise<void>;

/** A quiet sentence-case label over a group inside the answer panel. */
function PanelLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-4 pt-3 pb-1.5 text-xs font-medium text-muted-foreground">
      {children}
    </p>
  );
}

function RecommendedTag() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/12 px-2 py-0.5 text-[11px] font-medium text-foreground">
      <ThumbGlyph className="size-3 text-success" strokeWidth={2.25} />
      Recommended
    </span>
  );
}

/** One answer. A click sends it at once, so the row reads as a choice. */
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
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150",
          "hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground break-words">
            {label}
          </span>
          {detail && (
            <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground break-words">
              {detail}
            </span>
          )}
        </span>
        {recommended && <RecommendedTag />}
        <Icon
          name="ChevronRight"
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground/60 transition-transform duration-150 ease-out group-hover:translate-x-0.5 group-hover:text-foreground"
        />
      </button>
    </li>
  );
}

function Links({ decision }: { decision: CardDecision }) {
  if (decision.links.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 px-4 pb-3 text-xs">
      {decision.links.map((link) => (
        <li key={link.href}>
          <UrlLink
            href={link.href}
            className="inline-flex items-center gap-1 text-foreground underline decoration-border underline-offset-[3px] hover:decoration-foreground"
          >
            {link.label}
            <Icon name="ArrowUpRight" className="size-3" aria-hidden />
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
  label,
}: {
  item: Item;
  busy: boolean;
  run: Run;
  rpc: InboxRpc;
  label: string;
}) {
  const decision = item.card?.decisions.length === 1 ? item.card.decisions[0]! : null;
  if (decision) {
    if (decision.options.length === 0) return null;
    return (
      <div className="border-t border-border first:border-t-0">
        <PanelLabel>{label}</PanelLabel>
        <ul aria-label="Options" className="pb-1">
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
        </ul>
        <Links decision={decision} />
      </div>
    );
  }
  if (item.source === "card" || !item.options || item.options.length === 0) {
    return null;
  }
  return (
    <div className="border-t border-border first:border-t-0">
      <PanelLabel>{label}</PanelLabel>
      <ul aria-label="Options" className="pb-1">
        {item.options.map((option) => (
          <OptionButton
            key={option}
            label={option}
            recommended={item.recommendation === option}
            disabled={busy}
            onClick={() =>
              void run(`Answered: ${option}`, () =>
                rpc.call("items_answer", { id: item.id, text: option }),
              )
            }
          />
        ))}
      </ul>
    </div>
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
  const answered = picks.filter((pick) => cardAnswers([pick]) !== null).length;
  const setPick = (index: number, pick: DecisionPick) =>
    setPicks((current) => current.map((value, i) => (i === index ? pick : value)));

  return (
    <form
      className="border-t border-border first:border-t-0"
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
          <fieldset
            key={index}
            className="space-y-2.5 border-b border-border px-4 py-4"
          >
            <legend className="float-left mb-1 flex w-full items-baseline gap-2 text-sm font-semibold text-foreground">
              <span className="grid size-5 shrink-0 translate-y-px place-items-center rounded-full bg-surface-recessed text-[11px] font-medium text-muted-foreground tabular-nums">
                {index + 1}
              </span>
              <span className="min-w-0 break-words">{decision.question}</span>
            </legend>
            {decision.context && (
              <Markdown
                content={decision.context}
                className="clear-left max-w-[66ch] pl-7 text-[13px] leading-relaxed text-muted-foreground"
              />
            )}
            <div className="clear-left space-y-1.5 pl-7">
              {decision.options.map((option, optionIndex) => {
                const checked =
                  pick?.kind === "option" && pick.option === optionIndex;
                return (
                  <label
                    key={optionIndex}
                    className={cn(
                      "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-colors duration-150",
                      "has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring",
                      checked
                        ? "border-foreground/30 bg-surface-selected"
                        : "border-border hover:bg-state-hover",
                    )}
                  >
                    <input
                      type="radio"
                      name={name}
                      className="mt-[3px] accent-current"
                      checked={checked}
                      onChange={() =>
                        setPick(index, { kind: "option", option: optionIndex })
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-foreground">
                        {option.label}
                      </span>
                      {option.does && (
                        <span className="block text-[13px] leading-snug text-muted-foreground">
                          {option.does}
                        </span>
                      )}
                    </span>
                    {decision.suggested === optionIndex && <RecommendedTag />}
                  </label>
                );
              })}
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
                className="h-9 w-full rounded-lg border border-dashed border-border bg-transparent px-3 text-sm placeholder:text-muted-foreground focus-visible:border-solid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            {decision.links.length > 0 && (
              <div className="-mx-4 -mb-3 pl-7">
                <Links decision={decision} />
              </div>
            )}
          </fieldset>
        );
      })}
      <div className="flex items-center justify-between gap-3 bg-surface-raised px-4 py-3">
        <span className="text-xs text-muted-foreground tabular-nums">
          {answered} of {decisions.length} answered
        </span>
        <Button type="submit" size="sm" disabled={busy || !answers}>
          Submit answers
        </Button>
      </div>
    </form>
  );
}

function ReplyBox({
  item,
  busy,
  run,
  rpc,
  label,
}: {
  item: Item;
  busy: boolean;
  run: Run;
  rpc: InboxRpc;
  label: string;
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
    <div className="border-t border-border transition-colors duration-150 first:border-t-0 focus-within:bg-surface-raised focus-within:ring-1 focus-within:ring-ring focus-within:ring-inset">
      <PanelLabel>{label}</PanelLabel>
      <textarea
        aria-label={isCard ? "Own answer" : "Reply"}
        value={text}
        rows={2}
        placeholder={isCard ? "Write your own answer" : "Write a reply to the thread"}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            send();
          }
        }}
        className="block field-sizing-content min-h-14 w-full resize-none bg-transparent px-4 py-1 text-sm leading-relaxed placeholder:text-muted-foreground/80 focus-visible:outline-none"
      />
      <div className="flex items-center justify-end gap-3 px-4 pt-1 pb-3">
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Kbd>Ctrl</Kbd>/<Kbd>⌘</Kbd>
          <span aria-hidden>+</span>
          <Kbd>Enter</Kbd>
          <span className="ml-0.5">sends</span>
        </span>
        <Button
          size="sm"
          variant={text.trim() ? "default" : "outline"}
          disabled={busy || !text.trim()}
          onClick={send}
        >
          Send
        </Button>
      </div>
    </div>
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
      "header",
    );
  };
  const customUntil = parseLocalDateTime(custom, now);

  return (
    <div ref={rootRef}>
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
          className="absolute top-full right-2 z-10 mt-1 w-64 max-w-[calc(100vw-2rem)] space-y-0.5 rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
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
  const [errorPlace, setErrorPlace] = useState<"header" | "answer">("answer");
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

  const run: Run = async (confirmation, action, place = "answer") => {
    setBusy(true);
    setError(null);
    setErrorPlace(place);
    const openIds = groupItems(items, Date.now()).open.map((other) => other.id);
    try {
      const updated = await action();
      // The card can settle in its thread before this answer reaches it.
      const text =
        updated.closeReason === "card-settled"
          ? "The card was already settled in its thread"
          : typeof confirmation === "function"
            ? confirmation(updated)
            : confirmation;
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
        <div className="mx-auto w-full max-w-2xl space-y-3 py-10 text-center">
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

  const recommendationRow = recommendation && (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 bg-surface-raised px-4 py-3.5">
      <div className="min-w-[14rem] flex-1">
        <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <ThumbGlyph className="size-3.5 text-success" strokeWidth={2.25} />
          Recommended
        </p>
        <p className="mt-1 text-sm leading-relaxed text-foreground break-words">
          {recommendation}
        </p>
      </div>
      {canAccept && (
        <Button
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
          <CheckGlyph className="size-4" strokeWidth={2.5} />
          Accept recommendation
        </Button>
      )}
    </div>
  );
  const doneRow = item.kind === "do" && (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-border px-4 py-3.5 first:border-t-0">
      <p className="min-w-[14rem] flex-1 text-sm text-foreground">
        Did it yourself? Mark it done.
      </p>
      <Button
        variant={recommendation ? "outline" : "default"}
        disabled={busy}
        onClick={() =>
          void run("Marked done", () => rpc.call("items_done", { id: item.id }))
        }
      >
        <Icon name="Check" aria-hidden />
        Done
      </Button>
    </div>
  );
  const hasOptions =
    item.source === "card"
      ? decisions.length === 1 && decisions[0]!.options.length > 0
      : (item.options?.length ?? 0) > 0;

  return (
    <div className="h-full overflow-y-auto px-4 py-5 md:px-8 md:py-8">
      <article className="mx-auto w-full max-w-2xl" aria-busy={busy}>
        <header>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <KindTag kind={item.kind} large />
            <button
              type="button"
              onClick={openThread}
              title="Open thread"
              aria-label={`Open thread: ${threadLine(item)}`}
              className="group -my-1 inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground transition-colors duration-150 hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span className="min-w-0 truncate">{threadLine(item)}</span>
              <Icon
                name="ArrowUpRight"
                className="size-3 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                aria-hidden
              />
            </button>
            <span className="flex-1" />
            {!closed && (
              <div className="relative -my-1 -mr-2 flex items-center">
                {snoozed ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run("Back in the inbox", () =>
                        rpc.call("items_unsnooze", { id: item.id }),
                        "header",
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
                        "header",
                      )
                    }
                  >
                    Hand to parent
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  className="text-muted-foreground"
                  onClick={() =>
                    void run("Dismissed", () =>
                      rpc.call("items_dismiss", { id: item.id }),
                      "header",
                    )
                  }
                >
                  Dismiss
                </Button>
              </div>
            )}
          </div>
          {error && errorPlace === "header" && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}
          <h1 className="mt-4 text-[22px] leading-[1.3] font-semibold tracking-[-0.02em] text-balance text-foreground break-words">
            {item.question}
          </h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span>{SOURCE_PHRASES[item.source]}</span>
            <span aria-hidden>·</span>
            <time
              dateTime={new Date(item.lastAskedAt).toISOString()}
              title={new Date(item.lastAskedAt).toLocaleString()}
              className="tabular-nums"
            >
              {relativeAge(item.lastAskedAt, now)} ago
            </time>
            {item.askCount > 1 && (
              <>
                <span aria-hidden>·</span>
                <span className="tabular-nums">asked {item.askCount} times</span>
              </>
            )}
            {snoozed && item.snoozedUntil !== null && (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1">
                  <Icon name="Clock" className="size-3" aria-hidden />
                  snoozed until {wakeLabel(item.snoozedUntil, now)}
                </span>
              </>
            )}
          </p>
        </header>

        {closed && (
          <p className="mt-6 flex items-start gap-2 rounded-lg bg-surface-recessed px-3.5 py-3 text-sm text-foreground">
            <CircleCheckGlyph className="mt-px size-4 shrink-0 text-success" />
            <span className="min-w-0 break-words">
              {CLOSE_LABELS[item.closeReason ?? "closed"] ?? "Closed"}
              {item.answer ? `: ${item.answer}` : "."}
            </span>
          </p>
        )}

        {item.context && !multi && (
          <Markdown
            content={item.context}
            className="mt-6 max-w-[66ch] text-sm leading-relaxed text-foreground/90"
          />
        )}

        {closed
          ? recommendation && (
              <div className="mt-6 overflow-hidden rounded-xl border border-border">
                {recommendationRow}
              </div>
            )
          : (
              <section
                aria-label="Answer"
                className="mt-7 overflow-hidden rounded-xl border border-border"
              >
                {recommendationRow}
                {doneRow}
                {multi ? (
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
                    <SingleOptions
                      item={item}
                      busy={busy}
                      run={run}
                      rpc={rpc}
                      label={recommendation ? "Or pick an answer" : "Pick an answer"}
                    />
                    <ReplyBox
                      key={item.id}
                      item={item}
                      busy={busy}
                      run={run}
                      rpc={rpc}
                      label={
                        hasOptions || recommendation
                          ? "Or answer in your own words"
                          : item.source === "card"
                            ? "Your answer"
                            : "Reply to the thread"
                      }
                    />
                  </>
                )}
              </section>
            )}

        {error && errorPlace === "answer" && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
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
        <div className="mx-auto w-full max-w-2xl px-4 pt-4 md:px-0 md:pt-6">
          <Flash text={flash} />
        </div>
      )}
      <div className="min-h-0 flex-1">
        <ItemView key={selectedId} id={selectedId} onFlash={setFlash} />
      </div>
    </div>
  );
}

/** bb has no built-in "Inbox" glyph (it falls back to a bolt); this is Lucide's `inbox` tray. */
const TRAY_ICON = "inbox/tray";

function TrayIcon({ className }: { className?: string }) {
  return <TrayGlyph className={className} />;
}

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: TRAY_ICON, component: TrayIcon });
  app.slots.navPanel({
    id: PANEL_ID,
    title: "Inbox",
    icon: TRAY_ICON,
    path: PANEL_PATH,
    component: InboxPage,
    experimental_sidebar: InboxSidebar,
    experimental_useBadge: useInboxBadge,
  });
});
