import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  experimental_ProviderIcon as ProviderIcon,
  useComposer,
  useComposerView,
  useRpc,
  useSdk,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalComposerSelection, PluginComposerScope } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { CONTROL_HOVER_TRANSITION } from "@/components/ui/motion";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  describeOutcome,
  filterCatalog,
  loadCatalog,
  modelKey,
  routingForNewThread,
  routingForThread,
  routingKey,
  selectionOutcome,
  type Catalog,
  type CatalogEntry,
  type CatalogProvider,
} from "./catalog";
import { parseAllowlist } from "./allowlist";
import { splitFavorites, toggleFavorite } from "./favorites";
import { entryMatches, keyMatches, normalizeQuery } from "./search";
import {
  describeReasoningOutcome,
  reasoningChoices,
  reasoningLabel,
  reasoningOutcome,
} from "./reasoning";
import type { FavoritesContract } from "./rpc";
import { isEditable, keepEditorFocus } from "./editorFocus";

type CurrentSelection = Pick<
  ExperimentalComposerSelection,
  "providerId" | "model" | "reasoningLevel"
>;

// A reload keeps the last catalog for the same routing, so the menu does not
// empty while a provider with errors is tried again.
type CatalogState =
  | { status: "idle"; key: null }
  | { status: "loading"; key: string; previous?: Catalog }
  | { status: "ready"; key: string; catalog: Catalog }
  | { status: "error"; key: string; message: string; previous?: Catalog };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function scopeKey(scope: PluginComposerScope): string {
  switch (scope.kind) {
    case "thread":
      return `thread:${scope.threadId}`;
    case "new-thread":
      return `new-thread:${scope.projectId ?? ""}`;
    default:
      return scope.kind;
  }
}

function entryLabel(entry: CatalogEntry): string {
  return `${entry.providerName} · ${entry.displayName}`;
}

function shownCatalog(state: CatalogState): Catalog | null {
  if (state.status === "ready") return state.catalog;
  if (state.status === "loading" || state.status === "error") return state.previous ?? null;
  return null;
}

function pickSelection(selection: ExperimentalComposerSelection): CurrentSelection {
  return {
    providerId: selection.providerId,
    model: selection.model,
    reasoningLevel: selection.reasoningLevel,
  };
}

/**
 * Groups consecutive entries of one provider. It never moves an entry, so an
 * allowlist that alternates providers keeps its order, with one label per run.
 */
function groupProviderRuns(entries: readonly CatalogEntry[]) {
  const runs: { key: string; providerId: string; name: string; entries: CatalogEntry[] }[] = [];
  for (const entry of entries) {
    const last = runs.at(-1);
    if (last && last.providerId === entry.providerId) {
      last.entries.push(entry);
    } else {
      runs.push({
        key: `${runs.length}:${entry.providerId}`,
        providerId: entry.providerId,
        name: entry.providerName,
        entries: [entry],
      });
    }
  }
  return runs;
}

function AgentIcon({ provider, providerId, className }: {
  provider?: CatalogProvider;
  providerId: string;
  className?: string;
}) {
  return (
    <ProviderIcon
      providerKind="agent"
      provider={provider?.icon ?? { id: providerId }}
      className={cn("size-3.5 shrink-0", className)}
      aria-hidden
    />
  );
}

function MenuGroup({ label, icon, children }: {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="pb-1">
      <div id={id} className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[11px] leading-4 text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      {children}
    </div>
  );
}

function StarButton({ label, favorite, disabled, onToggle }: {
  label: string;
  favorite: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={favorite}
      aria-label={favorite ? `Remove ${label} from favorites` : `Add ${label} to favorites`}
      title={favorite ? "Remove from favorites" : "Add to favorites"}
      disabled={disabled}
      {...keepEditorFocus}
      onClick={onToggle}
      className={cn(
        "relative flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring active:scale-[0.96] disabled:opacity-50",
        CONTROL_HOVER_TRANSITION,
        favorite && "text-foreground",
      )}
    >
      <span aria-hidden className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" />
      <Icon name="Star" className={cn("size-3.5", favorite && "fill-current")} aria-hidden />
    </button>
  );
}

function ModelRow({ entry, provider, selected, favorite, handoff, showIcon, disabled, onPick, onToggleFavorite }: {
  entry: CatalogEntry;
  provider?: CatalogProvider;
  selected: boolean;
  favorite: boolean;
  handoff: boolean;
  showIcon: boolean;
  disabled: boolean;
  onPick: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <div className="flex items-center gap-0.5 pr-1">
      <button
        type="button"
        aria-pressed={selected}
        data-model-key={entry.key}
        disabled={disabled}
        {...keepEditorFocus}
        onClick={onPick}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] leading-5 outline-none hover:bg-state-hover focus-visible:bg-state-hover disabled:opacity-50",
          CONTROL_HOVER_TRANSITION,
        )}
      >
        {showIcon ? <AgentIcon provider={provider} providerId={entry.providerId} /> : null}
        <span className="truncate">{entry.displayName}</span>
        {entry.route ? (
          <span className="shrink-0 text-[11px] leading-4 text-muted-foreground">{entry.route}</span>
        ) : null}
        {handoff ? <span className="shrink-0 text-[11px] leading-4 text-muted-foreground">handoff</span> : null}
        {selected ? <Icon name="Check" className="ml-auto size-4 shrink-0" aria-hidden /> : null}
      </button>
      <StarButton
        label={entry.displayName}
        favorite={favorite}
        disabled={disabled}
        onToggle={onToggleFavorite}
      />
    </div>
  );
}

/**
 * A model and reasoning picker bound to the composer that mounted it. It reads
 * the composer's selection with an empty `experimental_setSelection({})`,
 * which changes nothing, and writes only when the user picks a value.
 *
 * On touch, the trigger, model rows, stars, reasoning levels, and clear
 * button cancel both the pointerdown and the compatibility mousedown (see
 * `keepEditorFocus`), and the menu does not move focus into itself. The
 * mobile composer checks `aria-expanded` only once, one frame after a blur,
 * and later collapses without a second check. If the editor blurs before the
 * tap click opens the menu, the composer collapses and unmounts the trigger. With
 * the editor kept focused, the keyboard stays open while the menu is open.
 * The filter input is the one exception: a deliberate tap focuses it. That
 * blur is safe because the trigger is already expanded, and the close gives
 * focus back to the editor. A mouse or keyboard open focuses the filter input.
 */
export function ModelPicker({ className }: { className?: string }) {
  const composer = useComposer();
  const view = useComposerView();
  const sdk = useSdk();
  const settings = useSettings();
  const rpc = useRpc<FavoritesContract>();

  const reasoningHeadingId = useId();
  const [open, setOpen] = useState(false);
  // How the last open started. A touch open leaves focus in the editor.
  const openedByTouch = useRef(false);
  // The editor that had focus when a touch open started. The close gives focus
  // back to it, also after the filter input took focus.
  const touchReturnFocus = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState<CurrentSelection | null>(null);
  const [catalog, setCatalogState] = useState<CatalogState>({ status: "idle", key: null });
  const [pending, setPending] = useState<"model" | "reasoning" | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);
  // The favorites the last write returned. The settings value wins again as
  // soon as it changes, so an edit in the settings page also shows.
  const [savedFavorites, setSavedFavorites] = useState<{ base: unknown; keys: string[] } | null>(null);
  const [savingFavorites, setSavingFavorites] = useState(false);

  // Every write bumps the sequence, so a read that started earlier cannot
  // overwrite the settled result of a later write.
  const sequence = useRef(0);
  const mounted = useRef(true);
  // The ref updates synchronously so concurrent reads see a load in flight.
  const catalogRef = useRef(catalog);
  const setCatalog = useCallback((next: CatalogState) => {
    catalogRef.current = next;
    setCatalogState(next);
  }, []);
  const threadEnvironments = useRef(new Map<string, string | null>());

  const scope = view.scope;
  const currentScopeKey = scopeKey(scope);

  const allowlist = useMemo(
    () => parseAllowlist(settings.values?.models),
    [settings.values?.models],
  );
  const favoritesSetting = settings.values?.favorites;
  const favoriteKeys = useMemo(
    () =>
      savedFavorites && savedFavorites.base === favoritesSetting
        ? savedFavorites.keys
        : parseAllowlist(favoritesSetting),
    [savedFavorites, favoritesSetting],
  );

  const threadEnvironmentId = useCallback(
    async (threadId: string) => {
      const cache = threadEnvironments.current;
      if (cache.has(threadId)) return cache.get(threadId) ?? null;
      const thread = await sdk.threads.get({ threadId });
      cache.set(threadId, thread.environmentId);
      return thread.environmentId;
    },
    [sdk],
  );

  const refresh = useCallback(async () => {
    const started = sequence.current;
    let selection;
    try {
      selection = await composer.experimental_setSelection({});
    } catch (cause) {
      if (!mounted.current) return;
      setCatalog({ status: "error", key: "selection", message: messageOf(cause) });
      return;
    }
    if (!mounted.current || started !== sequence.current) return;
    setCurrent(pickSelection(selection));

    let routing;
    try {
      routing =
        scope.kind === "thread"
          ? routingForThread(await threadEnvironmentId(scope.threadId))
          : routingForNewThread(selection.environment);
    } catch (cause) {
      if (!mounted.current) return;
      setCatalog({ status: "error", key: "thread", message: messageOf(cause) });
      return;
    }
    const key = routingKey(routing);
    const previous = catalogRef.current;
    if (previous.key === key) {
      if (previous.status === "loading") return;
      if (previous.status === "ready" && previous.catalog.errors.length === 0) return;
    }

    // A reload for the same routing keeps the old models on screen.
    const kept = previous.key === key ? (shownCatalog(previous) ?? undefined) : undefined;
    setCatalog({ status: "loading", key, previous: kept });
    try {
      const loaded = await loadCatalog(sdk.providers, routing);
      if (!mounted.current || catalogRef.current.key !== key) return;
      setCatalog({ status: "ready", key, catalog: loaded });
    } catch (cause) {
      if (!mounted.current || catalogRef.current.key !== key) return;
      setCatalog({ status: "error", key, message: messageOf(cause), previous: kept });
    }
  }, [composer, scope, sdk, setCatalog, threadEnvironmentId]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Read again when the composer instance changes scope, when the window
  // gets focus, and after a turn ends. The host has no selection
  // subscription, so these are the points where an outside change shows up.
  useEffect(() => {
    void refreshRef.current();
  }, [currentScopeKey, view.run.isRunning]);

  useEffect(() => {
    const onFocus = () => void refreshRef.current();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const ready = shownCatalog(catalog);
  const filtered = useMemo(
    () => (ready ? filterCatalog(ready.entries, allowlist) : null),
    [ready, allowlist],
  );
  const split = useMemo(
    () => (filtered ? splitFavorites(filtered.entries, favoriteKeys) : null),
    [filtered, favoriteKeys],
  );
  const needle = normalizeQuery(query);
  const shown = useMemo(
    () =>
      split && {
        favorites: split.favorites.filter((entry) => entryMatches(entry, needle)),
        missing: split.missing.filter((key) => keyMatches(key, needle)),
        rest: split.rest.filter((entry) => entryMatches(entry, needle)),
      },
    [split, needle],
  );

  const currentKey =
    current?.providerId && current.model
      ? modelKey(current.providerId, current.model)
      : null;
  const currentEntry =
    currentKey && ready
      ? (ready.entries.find((entry) => entry.key === currentKey) ??
        ready.selectedOnly.find((entry) => entry.key === currentKey))
      : undefined;
  const currentProvider = current?.providerId ? ready?.providers[current.providerId] : undefined;
  const modelLabel =
    current === null
      ? "Model"
      : currentEntry
        ? currentEntry.displayName
        : (current.model ?? "No model");
  const reasoningText = current?.reasoningLevel
    ? reasoningLabel(current.reasoningLevel, currentProvider)
    : null;
  const reasoningShortText =
    ({ low: "L", medium: "M", high: "H", xhigh: "XH" } as Record<string, string>)[
      current?.reasoningLevel ?? ""
    ] ?? reasoningText;
  const choices = reasoningChoices(currentEntry);

  const choose = useCallback(
    async (entry: CatalogEntry) => {
      if (entry.key === currentKey) return;
      sequence.current += 1;
      setPending("model");
      setSelectError(null);
      try {
        const actual = await composer.experimental_setSelection({
          providerId: entry.providerId,
          model: entry.model,
        });
        if (!mounted.current) return;
        // Show what the composer settled on, even when it differs.
        setCurrent(pickSelection(actual));
        const outcome = selectionOutcome(entry, actual);
        if (outcome.kind === "applied") {
          setOpen(false);
        } else {
          const message = describeOutcome(outcome, entryLabel(entry));
          setSelectError(message);
          toast.error(message);
        }
      } catch (cause) {
        if (!mounted.current) return;
        // Keep the previous display: nothing is known to have changed.
        const message = messageOf(cause);
        setSelectError(message);
        toast.error(`Could not select ${entryLabel(entry)}: ${message}`);
      } finally {
        if (mounted.current) setPending(null);
      }
    },
    [composer, currentKey],
  );

  const chooseReasoning = useCallback(
    async (level: NonNullable<CurrentSelection["reasoningLevel"]>) => {
      if (!current || level === current.reasoningLevel) return;
      const label = reasoningLabel(level, currentProvider);
      sequence.current += 1;
      setPending("reasoning");
      setSelectError(null);
      try {
        // Only the level: the composer keeps its provider and model.
        const actual = await composer.experimental_setSelection({ reasoningLevel: level });
        if (!mounted.current) return;
        // Fields the composer did not report keep their last read value.
        setCurrent((previous) => ({
          providerId: actual.providerId ?? previous?.providerId,
          model: actual.model ?? previous?.model,
          reasoningLevel: actual.reasoningLevel,
        }));
        const outcome = reasoningOutcome({ ...current, reasoningLevel: level }, actual);
        if (outcome.kind !== "applied") {
          const message = describeReasoningOutcome(outcome, label);
          setSelectError(message);
          toast.error(message);
        }
      } catch (cause) {
        if (!mounted.current) return;
        const message = messageOf(cause);
        setSelectError(message);
        toast.error(`Could not set ${label} reasoning: ${message}`);
      } finally {
        if (mounted.current) setPending(null);
      }
    },
    [composer, current, currentProvider],
  );

  const setFavorite = useCallback(
    async (key: string) => {
      const base = favoritesSetting;
      setSavingFavorites(true);
      try {
        const saved = await rpc.call("setFavorites", {
          keys: toggleFavorite(favoriteKeys, key),
        });
        if (mounted.current) setSavedFavorites({ base, keys: saved.keys });
      } catch (cause) {
        toast.error(`Could not save favorites: ${messageOf(cause)}`);
      } finally {
        if (mounted.current) setSavingFavorites(false);
      }
    },
    [favoriteKeys, favoritesSetting, rpc],
  );

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    // Clear on open, not on close, so the list does not change while the
    // close animation runs. A pick closes the menu without this callback.
    setQuery("");
    const active = document.activeElement;
    touchReturnFocus.current =
      openedByTouch.current && active instanceof HTMLElement && isEditable(active) ? active : null;
    setSelectError(null);
    void refresh();
  };

  const busy = pending !== null;
  const hint = scope.kind === "thread" ? current?.providerId : undefined;
  const favoriteSet = new Set(favoriteKeys);
  const loading = catalog.status === "idle" || catalog.status === "loading" || settings.isLoading;
  const unmatched = filtered?.unmatched.filter((key) => !favoriteSet.has(key)) ?? [];
  // Only a filter hides every row here. An empty configuration has its own note.
  const noMatch =
    needle !== "" &&
    shown !== null &&
    !settings.isLoading &&
    (filtered?.entries.length ?? 0) + (split?.missing.length ?? 0) > 0 &&
    shown.favorites.length + shown.missing.length + shown.rest.length === 0;

  const row = (entry: CatalogEntry, showIcon: boolean) => (
    <ModelRow
      key={entry.key}
      entry={entry}
      provider={ready?.providers[entry.providerId]}
      selected={entry.key === currentKey}
      favorite={favoriteSet.has(entry.key)}
      handoff={hint !== undefined && entry.providerId !== hint}
      showIcon={showIcon}
      disabled={busy || savingFavorites}
      onPick={() => void choose(entry)}
      onToggleFavorite={() => void setFavorite(entry.key)}
    />
  );

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        disabled={busy || view.run.isSubmitting}
        onPointerDown={(event) => {
          openedByTouch.current = event.pointerType !== "mouse";
          keepEditorFocus.onPointerDown(event);
        }}
        onMouseDown={keepEditorFocus.onMouseDown}
        onKeyDown={() => {
          openedByTouch.current = false;
        }}
        aria-label={`Model: ${modelLabel}. Reasoning: ${reasoningText ?? "unknown"}`}
        title={selectError ?? (currentEntry ? entryLabel(currentEntry) : modelLabel)}
        // The host action wrapper never shrinks, so the button sets its own
        // width. Below 390px it shows only an icon. From 390px the label is
        // capped to leave room for the host controls on the left.
        className={cn(
          "flex h-8 max-w-[min(14rem,calc(100vw-280px))] min-w-0 items-center gap-1.5 rounded-md px-2 text-[11px] leading-4 font-medium text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 max-[390px]:w-8 max-[390px]:max-w-none max-[390px]:justify-center max-[390px]:px-0",
          CONTROL_HOVER_TRANSITION,
          selectError && "text-destructive",
          className,
        )}
      >
        {current?.providerId ? (
          <AgentIcon provider={currentProvider} providerId={current.providerId} />
        ) : null}
        <span className="truncate max-[390px]:hidden">{busy ? "Selecting…" : modelLabel}</span>
        {reasoningText && !busy ? (
          <span className="shrink-0 opacity-70 max-[390px]:hidden">{reasoningShortText}</span>
        ) : null}
        {/* With no provider icon, the chevron keeps the narrow button visible. */}
        <Icon
          name="ChevronDown"
          className={cn("size-3.5 shrink-0 opacity-50", current?.providerId && "max-[390px]:hidden")}
          aria-hidden
        />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        collisionPadding={8}
        aria-label="Model and reasoning"
        ref={contentRef}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (!openedByTouch.current) searchRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          // Moving focus to the trigger would close the keyboard. The editor
          // either kept focus during a touch open, or lost it to the filter
          // input, which is gone now.
          const active = document.activeElement;
          const editor = touchReturnFocus.current;
          touchReturnFocus.current = null;
          if (isEditable(active) && !contentRef.current?.contains(active)) {
            event.preventDefault();
          } else if (editor?.isConnected) {
            event.preventDefault();
            editor.focus({ preventScroll: true });
          }
        }}
        className="flex max-h-[min(28rem,var(--radix-popover-content-available-height))] w-72 max-w-[calc(100vw-1rem)] flex-col overflow-hidden font-medium"
      >
        <div className="shrink-0 border-b p-1">
          <div className="flex items-center gap-1.5 px-2 pt-1 pb-1.5 text-[11px] leading-4 text-muted-foreground">
            <Icon name="Brain" className="size-3.5 shrink-0" aria-hidden />
            <span id={reasoningHeadingId}>Reasoning</span>
            <span className="ml-auto truncate" data-testid="reasoning-current">
              {reasoningText ?? "Unknown"}
            </span>
          </div>
          {choices.length > 0 ? (
            <div
              role="radiogroup"
              aria-labelledby={reasoningHeadingId}
              className="flex flex-wrap gap-1 px-1 pb-1"
            >
              {choices.map((choice) => {
                const checked = choice.level === current?.reasoningLevel;
                return (
                  <button
                    key={choice.level}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    title={choice.description || undefined}
                    disabled={busy}
                    {...keepEditorFocus}
                    onClick={() => void chooseReasoning(choice.level)}
                    className={cn(
                      "h-7 rounded-sm px-2 text-[11px] leading-4 outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring active:scale-[0.96] disabled:opacity-50",
                      CONTROL_HOVER_TRANSITION,
                      checked ? "bg-state-hover text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {reasoningLabel(choice.level, currentProvider)}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="px-2 pb-1 text-[11px] leading-4 text-muted-foreground">
              {!currentEntry
                ? "The catalog has no reasoning data for this model."
                : currentEntry.reasoningEfforts.length === 0
                  ? "This model has no reasoning setting."
                  : "This model offers only levels that this menu hides."}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 border-b py-1 pr-1 pl-3">
          <Icon name="Search" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={searchRef}
            type="search"
            name="model-filter"
            aria-label="Filter models"
            placeholder="Filter models"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Radix handles Escape on the document. Other keys stay here, so
              // no composer or host shortcut acts on them.
              if (event.key === "Escape") return;
              event.stopPropagation();
              if (event.key === "Enter") event.preventDefault();
            }}
            className="h-7 min-w-0 flex-1 bg-transparent text-[13px] leading-5 outline-none placeholder:text-muted-foreground max-md:pointer-coarse:text-base [&::-webkit-search-cancel-button]:appearance-none"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear filter"
              title="Clear filter"
              {...keepEditorFocus}
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
              className={cn(
                "relative flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring active:scale-[0.96]",
                CONTROL_HOVER_TRANSITION,
              )}
            >
              <span aria-hidden className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" />
              <Icon name="X" className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {selectError ? (
            <p role="alert" className="px-2 py-1.5 text-[11px] leading-4 text-destructive">
              {selectError}
            </p>
          ) : null}
          {loading && !ready ? (
            <p className="px-2 py-1.5 text-[11px] leading-4 text-muted-foreground">Loading models…</p>
          ) : null}
          {catalog.status === "error" ? (
            <p role="alert" className="px-2 py-1.5 text-[11px] leading-4 text-destructive">
              Could not load models: {catalog.message}
            </p>
          ) : null}
          {shown && !settings.isLoading ? (
            <>
              {shown.favorites.length > 0 || shown.missing.length > 0 ? (
                <MenuGroup
                  label="Favorites"
                  icon={<Icon name="Star" className="size-3.5 shrink-0" aria-hidden />}
                >
                  {shown.favorites.map((entry) => row(entry, true))}
                  {shown.missing.map((key) => (
                    <div key={key} className="flex items-center gap-0.5 pr-1">
                      <span className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-[13px] leading-5 text-muted-foreground">
                        <span className="truncate">{key}</span>
                        <span className="shrink-0 text-[11px] leading-4">not available here</span>
                      </span>
                      <StarButton
                        label={key}
                        favorite
                        disabled={busy || savingFavorites}
                        onToggle={() => void setFavorite(key)}
                      />
                    </div>
                  ))}
                </MenuGroup>
              ) : null}
              {groupProviderRuns(shown.rest).map((group) => (
                <MenuGroup
                  key={group.key}
                  label={group.name}
                  icon={
                    <AgentIcon
                      provider={ready?.providers[group.providerId]}
                      providerId={group.providerId}
                    />
                  }
                >
                  {group.entries.map((entry) => row(entry, false))}
                </MenuGroup>
              ))}
            </>
          ) : null}
          {filtered && !settings.isLoading && filtered.entries.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] leading-4 text-muted-foreground">
              No configured model is available here.
            </p>
          ) : null}
          {noMatch ? (
            <p role="status" className="px-2 py-1.5 text-[11px] leading-4 text-muted-foreground">
              No models match “{query.trim()}”.
            </p>
          ) : null}
          {ready?.errors.map((error) => (
            <p key={error.providerId} className="px-2 py-1.5 text-[11px] leading-4 text-destructive">
              {error.providerName}: {error.message}
            </p>
          ))}
          {unmatched.length > 0 ? (
            <p className="px-2 py-1.5 text-[11px] leading-4 text-muted-foreground">
              Not in this catalog: {unmatched.join(", ")}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
