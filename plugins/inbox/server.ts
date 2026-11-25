// bb-plugin-inbox backend.
//
// The inbox holds the items that wait on the user. Three sources feed it:
//   - "card":     pending cards of the builtin decisions plugin, mirrored
//                 one item per card and kept in sync both ways.
//   - "tool":     the `inbox_ask` agent tool and `bb inbox ask`.
//   - "detected": a two-pass model check of each top-level thread's final
//                 reply (only with an OpenAI API key; see detection.ts).
//
// Answers go back to the source thread: a card through
// `threads.interactions.respond`, everything else as a thread message. Each
// new item pings once through the push-notifications plugin's RPC; the SDK
// has no push API of its own.
import {
  PluginCliError,
  cliCommand,
  defineCli,
  experimental_BbHttpError,
  experimental_PluginRpcRefusal,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  buildCardResponse,
  cardFields,
  describeCardResponse,
  isDecisionCard,
  parseCard,
  type InteractionLike,
} from "./cards";
import {
  DEFAULT_DETECTION_MODEL,
  ITEMS_CHANGED,
  LIMITS,
  PLUGIN_ID,
  PUSH_METHOD,
  PUSH_PLUGIN_ID,
  TOOL_NAME,
  askInputSchema,
  itemKindSchema,
  rpcContract,
  type AnswerCheckResult,
  type AskInput,
  type CardAnswer,
  type CliItem,
  type DetectionResult,
  type DetectionStatus,
  type Detector,
  type DetectorOptions,
  type Item,
  type ItemKind,
  type ItemsChanged,
} from "./contract";
import { createDetector as defaultCreateDetector } from "./detection";
import { clip, createStore, type NewItem, type ThreadSnapshot } from "./store";

export { rpcContract };

const DAY_MS = 24 * 60 * 60 * 1000;
const DISCOVERY_WINDOW_MS = 7 * DAY_MS;
const DISCOVERY_MAX_THREADS = 200;
const DISCOVERY_PAGE = 100;
const NO_KEY_REASON = "no OpenAI API key set";
const NUDGE_DATE_KEY = "nudge-date";
const ANSWER_EVENT_PAGE = 100;

const KIND_LABEL: Record<ItemKind, string> = {
  decide: "Decide",
  approve: "Approve",
  do: "To do",
};

export const TOOL_DESCRIPTION =
  "Put a question, approval, or task in the user's inbox. The user reads it in the inbox, away from this thread, so the question and context must make sense to someone who has not read the thread: name the real things, never \"option 1\", \"the fix above\", or \"it\". Give each option as its full text, not a number or a reference. Non-blocking: it returns at once with the item id. The user's answer arrives later in this thread as a message that starts with [Inbox].";

export const INSTRUCTIONS = `Every ask to the user goes through a decision card (\`request_decisions\`) or \`${TOOL_NAME}\`. The user works from an inbox, not from each thread.
- Use \`${TOOL_NAME}\` for approvals (kind "approve"), things the user must do themselves (kind "do"), and decisions that do not fit a card (kind "decide").
- Write the question and \`context\` for someone who has not read the thread. Resolve every reference ("option 1", "the fix above", "it") to what it means. The context says what is asked, what each option does, and what happens on yes.
- Give each option as its full text, not a number or a reference. Give a \`recommendation\` when you have one.
- The call does not block. Do not wait for it; continue with other work or end your turn. The answer arrives in this thread as a message that starts with "[Inbox]".
- Asking the same question again bumps the existing item; it does not add a second one.`;

const pushOutputSchema = z.object({ ok: z.boolean() }).passthrough();

export interface InboxDeps {
  createDetector?: (options: DetectorOptions) => Detector;
  now?: () => number;
}

type ThreadLike = {
  id: string;
  projectId: string | null;
  title: string | null;
  titleFallback?: string | null;
  parentThreadId: string | null;
  archivedAt?: number | null;
};

/** Item → the stable CLI JSON shape (cliItemSchema). */
export function toCliItem(item: Item): CliItem {
  return {
    id: item.id,
    threadId: item.threadId,
    projectId: item.projectId,
    kind: item.kind,
    question: item.question,
    recommendation: item.recommendation,
    source: item.source,
    status: item.status === "snoozed" ? "snoozed" : "open",
    ref: item.ref,
    createdAt: new Date(item.createdAt).toISOString(),
    lastAskedAt: new Date(item.lastAskedAt).toISOString(),
    askCount: item.askCount,
  };
}

/** "45m", "5h", "3d". */
export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // A bare "fetch failed" hides the real reason in `cause`.
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return error.message + cause;
}

function refuse(code: "not_found" | "conflict" | "invalid", message: string): never {
  throw new experimental_PluginRpcRefusal({ code, message });
}

/** The resolution detail of a settled plugin interaction, when it has one. */
function resolutionDetail(interaction: unknown): string | null {
  const resolution = (interaction as InteractionLike).resolution;
  const detail = resolution?.description?.detail;
  return typeof detail === "string" && detail.trim() !== "" ? detail.trim() : null;
}

export function answerMessage(item: Item, answer: string): string {
  const ref = item.ref ? ` (ref: ${item.ref})` : "";
  return `[Inbox] Answer to ${item.id}${ref}: ${item.question}\n\n${answer}`;
}

export function doneMessage(item: Item, note: string | undefined): string {
  return note ? `[Inbox] Done: ${item.question}\n\n${note}` : `[Inbox] Done: ${item.question}`;
}

export function dismissMessage(item: Item): string {
  return `[Inbox] The user dismissed ${item.id}: ${item.question}. Continue with your best judgement.`;
}

export function handMessage(item: Item, note: string | undefined): string {
  const lines = [
    `[Inbox] The user handed ${item.id} to you from @thread:${item.threadId}. Handle it for them.`,
    "",
    `Kind: ${item.kind}`,
    `Question: ${item.question}`,
  ];
  if (item.ref) lines.push(`Ref: ${item.ref}`);
  if (item.options && item.options.length > 0) {
    lines.push("Options:", ...item.options.map((option) => `- ${option}`));
  }
  if (item.recommendation) lines.push(`Recommendation: ${item.recommendation}`);
  if (item.card) {
    lines.push(
      `Card: ${item.card.interactionId} is still pending in that thread. Answer it with \`bb thread interactions respond ${item.card.interactionId} ${item.threadId} --value '{"answers":[...]}'\`.`,
    );
  }
  if (note) lines.push("", `Note from the user: ${note}`);
  if (item.context) lines.push("", "Context:", item.context);
  return lines.join("\n");
}

export function createInboxPlugin(deps: InboxDeps = {}) {
  const createDetector = deps.createDetector ?? defaultCreateDetector;
  const now = deps.now ?? Date.now;

  return async function plugin(bb: BbPluginApi) {
    const settings = bb.settings.define({
      openaiApiKey: {
        type: "string",
        label: "OpenAI API key",
        description:
          "Checks agents' final replies and user messages that may answer open items. Detection is off without it.",
        secret: true,
      },
      detectionModel: {
        type: "string",
        label: "Detection model",
        description: "OpenAI model for ask detection and answer checks.",
        default: DEFAULT_DETECTION_MODEL,
      },
      askThreshold: {
        type: "number",
        label: "Ask threshold",
        description:
          "Pass 2 (extract the ask) runs only when pass 1 scores the reply at or above this (0-1).",
        experimental_schema: z.number().min(0).max(1),
        default: 0.6,
      },
      resolveThreshold: {
        type: "number",
        label: "Resolve threshold",
        description: "An open item closes as resolved when its score is at or above this (0-1).",
        experimental_schema: z.number().min(0).max(1),
        default: 0.8,
      },
      answerThreshold: {
        type: "number",
        label: "Answer threshold",
        description: "An item closes as answered in thread when its score is at or above this (0-1).",
        experimental_schema: z.number().min(0).max(1),
        default: 0.8,
      },
      pings: {
        type: "boolean",
        label: "Pings",
        description: "Push one notification per new item, and one daily nudge while items are open.",
        default: true,
      },
      nudgeHour: {
        type: "number",
        label: "Nudge hour",
        description: "Hour of the daily nudge (0-23, server local time).",
        experimental_schema: z.number().int().min(0).max(23),
        default: 9,
      },
    });

    const store = createStore(bb.storage.database(), now, () => publish());
    const lifetime = new AbortController();
    bb.onDispose(() => lifetime.abort());

    // -----------------------------------------------------------------------
    // Detection state. The detector is built lazily and rebuilt after a
    // settings change. The key is never logged or returned.

    let detectorCache: { detector: Detector | null; status: DetectionStatus } | null = null;
    settings.onChange(() => {
      detectorCache = null;
    });

    async function detection(): Promise<{ detector: Detector | null; status: DetectionStatus }> {
      const values = await settings.get();
      const apiKey = typeof values.openaiApiKey === "string" ? values.openaiApiKey.trim() : "";
      const model = values.detectionModel.trim() || DEFAULT_DETECTION_MODEL;
      if (apiKey === "") {
        return { detector: null, status: { enabled: false, reason: NO_KEY_REASON, model } };
      }
      if (detectorCache) return detectorCache;
      try {
        const detector = createDetector({
          apiKey,
          model,
          askThreshold: values.askThreshold,
          resolveThreshold: values.resolveThreshold,
          answerThreshold: values.answerThreshold,
        });
        detectorCache = { detector, status: { enabled: true, reason: null, model } };
      } catch (error) {
        bb.log.warn(
          `detection: the detector failed to start: ${errorMessage(error).split(apiKey).join("***")}`,
        );
        detectorCache = {
          detector: null,
          status: { enabled: false, reason: "the detector failed to start", model },
        };
      }
      return detectorCache;
    }

    {
      const initial = await settings.get();
      if (typeof initial.openaiApiKey !== "string" || initial.openaiApiKey.trim() === "") {
        bb.log.info(`inbox loaded; detection is off: ${NO_KEY_REASON}`);
      } else {
        bb.log.info("inbox loaded; detection is on");
      }
    }

    // -----------------------------------------------------------------------
    // Shared helpers

    function publish(): void {
      const { openCount, unreadCount } = store.counts();
      const payload: ItemsChanged = { openCount, unreadCount };
      bb.realtime.publish(ITEMS_CHANGED, payload);
    }

    const projectNames = new Map<string, string | null>();
    async function projectName(projectId: string | null): Promise<string | null> {
      if (projectId === null) return null;
      if (projectNames.has(projectId)) return projectNames.get(projectId) ?? null;
      let name: string | null = null;
      try {
        const project = await bb.sdk.projects.get({ projectId });
        name = project.name ?? null;
      } catch {
        name = null;
      }
      projectNames.set(projectId, name);
      return name;
    }

    async function snapshotOf(thread: ThreadLike): Promise<ThreadSnapshot> {
      return {
        threadId: thread.id,
        projectId: thread.projectId,
        threadTitle: thread.title ?? thread.titleFallback ?? null,
        projectName: await projectName(thread.projectId),
        parentThreadId: thread.parentThreadId,
      };
    }

    /** Reads the thread; on failure returns a snapshot with only the id. */
    async function snapshotFor(threadId: string): Promise<ThreadSnapshot> {
      try {
        return await snapshotOf(await bb.sdk.threads.get({ threadId }));
      } catch {
        return {
          threadId,
          projectId: null,
          threadTitle: null,
          projectName: null,
          parentThreadId: null,
        };
      }
    }

    async function ping(title: string, body: string, threadId?: string): Promise<void> {
      const values = await settings.get();
      if (!values.pings) return;
      try {
        await bb.sdk.plugins.callRpc({
          pluginId: PUSH_PLUGIN_ID,
          method: PUSH_METHOD,
          input: threadId ? { title, body, threadId } : { title, body },
          outputSchema: pushOutputSchema,
        });
      } catch (error) {
        bb.log.warn(`ping failed: ${errorMessage(error)}`);
      }
    }

    /** Creates an item, publishes, and pings once. */
    async function createItem(input: NewItem): Promise<Item> {
      const item = store.insert(input);
      publish();
      await ping(`Inbox · ${KIND_LABEL[item.kind]}`, item.question, item.threadId);
      return item;
    }

    async function sendToThread(threadId: string, text: string): Promise<void> {
      // No retry: a lost response after delivery would send the text twice.
      // The item stays open on failure, so the user can try again.
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{ type: "text", text, mentions: [] }],
      });
    }

    function liveItem(id: string): Item {
      const item = store.get(id);
      if (item === null) refuse("not_found", `no inbox item ${id}`);
      if (item.status === "closed") {
        refuse("conflict", `${id} is already closed (${item.closeReason ?? "closed"})`);
      }
      return item;
    }

    function closeItem(id: string, reason: Item["closeReason"] & string, answer: string | null = null): Item {
      const item = store.close(id, reason, answer);
      publish();
      return item;
    }

    // -----------------------------------------------------------------------
    // Asks (tool and CLI)

    async function ask(
      snapshot: ThreadSnapshot,
      input: AskInput,
    ): Promise<{ item: Item; repeated: boolean }> {
      const repeat = store.findRepeat(snapshot.threadId, input.question, ["tool"]);
      if (repeat) {
        const item = store.bump(repeat.id, {
          context: input.context,
          options: input.options,
          recommendation: input.recommendation,
          ref: input.ref,
          snapshot,
        });
        publish();
        return { item, repeated: true };
      }
      const item = await createItem({ ...snapshot, ...input, source: "tool" });
      return { item, repeated: false };
    }

    // -----------------------------------------------------------------------
    // Card mirror

    async function mirrorCard(interaction: InteractionLike, thread?: ThreadLike): Promise<void> {
      if (!isDecisionCard(interaction) || interaction.status !== "pending") return;
      if (store.byInteraction(interaction.id)) return;
      const card = parseCard(interaction);
      if (card === null) {
        bb.log.warn(`card ${interaction.id}: the payload does not parse; not mirrored`);
        return;
      }
      const snapshot = thread ? await snapshotOf(thread) : await snapshotFor(interaction.threadId);
      // A second mirror of the same card may have won the race meanwhile.
      if (store.byInteraction(interaction.id)) return;
      try {
        await createItem({ ...snapshot, kind: "decide", ...cardFields(card), source: "card", card });
      } catch (error) {
        if (store.byInteraction(interaction.id)) return;
        throw error;
      }
    }

    /**
     * Reads a card item's interaction. When it is no longer pending, closes
     * the item with "card-settled" and returns it. Otherwise returns null.
     */
    async function refreshCard(item: Item): Promise<Item | null> {
      if (!item.card) return null;
      let interaction;
      try {
        interaction = await bb.sdk.threads.interactions.get({
          threadId: item.threadId,
          interactionId: item.card.interactionId,
        });
      } catch (error) {
        if (error instanceof experimental_BbHttpError && error.status === 404) {
          return closeItem(item.id, "card-settled");
        }
        bb.log.warn(`card ${item.card.interactionId}: read failed: ${errorMessage(error)}`);
        return null;
      }
      if (interaction.status === "pending" || interaction.status === "resolving") return null;
      return closeItem(item.id, "card-settled", resolutionDetail(interaction));
    }

    async function syncCards(threadId?: string): Promise<void> {
      for (const item of store.liveCards(threadId)) {
        if (lifetime.signal.aborted) return;
        await refreshCard(item);
      }
    }

    /** Finds cards that went pending while the plugin was not loaded. */
    async function discoverCards(signal: AbortSignal): Promise<void> {
      const since = now() - DISCOVERY_WINDOW_MS;
      const threads: ThreadLike[] = [];
      for (let offset = 0; offset < DISCOVERY_MAX_THREADS; offset += DISCOVERY_PAGE) {
        const page = await bb.sdk.threads.list({
          archived: false,
          limit: DISCOVERY_PAGE,
          offset,
          signal,
        });
        threads.push(...page.filter((thread) => thread.updatedAt >= since));
        if (page.length < DISCOVERY_PAGE) break;
      }
      for (const thread of threads.slice(0, DISCOVERY_MAX_THREADS)) {
        if (signal.aborted) return;
        try {
          const interactions = await bb.sdk.threads.interactions.list({
            threadId: thread.id,
            signal,
          });
          for (const interaction of interactions) {
            await mirrorCard(interaction as InteractionLike, thread);
          }
        } catch (error) {
          bb.log.debug(`card discovery: ${thread.id}: ${errorMessage(error)}`);
        }
      }
    }

    // -----------------------------------------------------------------------
    // Detection

    const detectionChains = new Map<string, Promise<void>>();

    /** Runs detection for a thread after any detection already running there. */
    function queueDetection(thread: ThreadLike, reply: string): Promise<void> {
      const previous = detectionChains.get(thread.id) ?? Promise.resolve();
      const next = previous
        .then(() => runDetection(thread, reply))
        .catch((error) => bb.log.warn(`detection: ${thread.id}: ${errorMessage(error)}`));
      detectionChains.set(thread.id, next);
      void next.finally(() => {
        if (detectionChains.get(thread.id) === next) detectionChains.delete(thread.id);
      });
      return next;
    }

    /** Threads the plugin saw archived or deleted (until unarchived). */
    const archivedThreads = new Set<string>();
    const answerChecksStartedAt = now();
    const answerCursors = new Map<string, number>();
    const answerScans = new Map<string, Promise<void>>();

    function scanForAnswers(thread: ThreadLike, sequence: number): Promise<void> {
      const { id } = thread;
      const previous = answerScans.get(id) ?? Promise.resolve();
      const next = previous
        .then(() => readAnswerEvents(thread, sequence))
        .catch((error) => bb.log.warn(`answer check: ${id}: ${errorMessage(error)}`));
      answerScans.set(id, next);
      void next.finally(() => {
        if (answerScans.get(id) === next) answerScans.delete(id);
      });
      return next;
    }

    async function readAnswerEvents(thread: ThreadLike, sequence: number): Promise<void> {
      const { id } = thread;
      if (lifetime.signal.aborted || thread.archivedAt || archivedThreads.has(id)) return;
      const afterSeq = answerCursors.get(id) ?? 0;
      if (sequence <= afterSeq) return;

      const items = store.threadItems(id).filter((item) => item.source !== "card" && item.status === "open");
      if (!items.length) {
        answerCursors.delete(id);
        return;
      }
      const { detector } = await detection();
      if (!detector) {
        answerCursors.set(id, sequence);
        return;
      }
      const oldest = Math.max(answerChecksStartedAt, Math.min(...items.map((item) => item.createdAt)));
      const messages: { text: string; at: number }[] = [];
      let beforeSeq = sequence + 1;
      // The notification can cover several new events. Use its sequence as
      // the upper bound, and stop at the first event older than the items.
      while (!lifetime.signal.aborted) {
        const rows = await bb.sdk.threads.events.list({
          threadId: id,
          afterSeq: String(afterSeq),
          beforeSeq: String(beforeSeq),
          types: ["client/turn/requested"],
          order: "desc",
          limit: String(ANSWER_EVENT_PAGE),
          signal: lifetime.signal,
        });
        for (const row of rows) {
          if (row.createdAt < oldest) break;
          if (row.type !== "client/turn/requested") continue;
          const request = row.data;
          if (request.initiator !== "user" || request.senderThreadId || request.retryOfRequestId ||
              request.originPluginId === PLUGIN_ID) continue;
          const text = request.input
            .filter((part) => part.visibility !== "agent-only")
            .filter((part) => part.type === "text")
            .map((part) => part.text).join("\n").trim();
          if (!text || text.startsWith("[Inbox]") || text.startsWith("[bb message from thread:")) continue;
          messages.push({ text, at: row.createdAt });
        }
        const last = rows.at(-1);
        if (!last || rows.length < ANSWER_EVENT_PAGE || last.createdAt < oldest) break;
        beforeSeq = last.seq;
      }
      if (archivedThreads.has(id)) return;
      answerCursors.set(id, sequence);

      for (const { text, at } of messages.reverse()) {
        if (lifetime.signal.aborted || archivedThreads.has(id)) break;
        const candidates = items.filter((item) => item.createdAt <= at && store.get(item.id)?.status === "open");
        if (candidates.length) await checkAnswer(detector, id, text, candidates);
      }
    }

    async function checkAnswer(detector: Detector, threadId: string, text: string, items: Item[]): Promise<void> {
      const at = now();
      let result: AnswerCheckResult;
      try {
        result = await detector.checkAnswer(text, items.map(({ id, question, options, recommendation }) => ({
          id, question, options, recommendation,
        })), lifetime.signal);
      } catch (error) {
        bb.log.warn(`answer check: ${threadId}: ${errorMessage(error)}`);
        return;
      }
      if (lifetime.signal.aborted || archivedThreads.has(threadId)) return;
      const resolvedIds: string[] = [];
      const answered = new Set(result.answeredItemIds);
      for (const { id } of items) {
        if (!answered.has(id) || busyItems.has(id) || store.get(id)?.status !== "open") continue;
        store.close(id, "answered-in-thread", text);
        resolvedIds.push(id);
      }
      if (!resolvedIds.length) return;
      store.logDetection({
        threadId,
        at,
        outcome: "answered-in-thread",
        scores: { answered: result.scores },
        passTwoRan: false,
        createdIds: [],
        repeatedIds: [],
        resolvedIds,
        durationMs: now() - at,
        error: null,
      });
      publish();
    }

    async function runDetection(thread: ThreadLike, reply: string): Promise<void> {
      const { detector } = await detection();
      if (!detector) return;
      const openItems = store.threadItems(thread.id);
      const started = now();
      const base = { threadId: thread.id, at: started };

      let result: DetectionResult;
      try {
        result = await detector.detect(
          {
            threadId: thread.id,
            reply,
            openItems: openItems.map((item) => ({
              id: item.id,
              kind: item.kind,
              question: item.question,
              recommendation: item.recommendation,
              source: item.source,
              askCount: item.askCount,
            })),
          },
          lifetime.signal,
        );
      } catch (error) {
        const message = errorMessage(error);
        bb.log.warn(`detection: ${thread.id}: ${message}`);
        store.logDetection({
          ...base,
          outcome: "error",
          scores: null,
          passTwoRan: false,
          createdIds: [],
          repeatedIds: [],
          resolvedIds: [],
          durationMs: now() - started,
          error: clip(message, 1000),
        });
        return;
      }

      const createdIds: string[] = [];
      const repeatedIds: string[] = [];
      const resolvedIds: string[] = [];
      if (result.outcome === "error") {
        bb.log.warn(`detection: ${thread.id}: ${result.error ?? "error"}`);
      } else {
        const byId = new Map(openItems.map((item) => [item.id, item]));
        let snapshot: ThreadSnapshot | null = null;
        for (const found of result.asks) {
          const target = found.repeatOfItemId ? byId.get(found.repeatOfItemId) : undefined;
          if (target) {
            store.bump(target.id, {
              // A card keeps its headline; a detected repeat can name the real options now.
              question: target.source === "card" ? undefined : found.question,
              context: found.context ?? undefined,
              options: found.options ?? undefined,
              recommendation: found.recommendation ?? undefined,
              excerpt: found.excerpt,
            });
            repeatedIds.push(target.id);
            continue;
          }
          snapshot ??= await snapshotOf(thread);
          // The thread can be archived while detection runs or waits in the
          // queue. Check with no await between the check and the insert.
          if (archivedThreads.has(thread.id)) break;
          const item = await createItem({
            ...snapshot,
            kind: itemKindSchema.catch("decide").parse(found.kind),
            question: found.question,
            context: found.context,
            options: found.options,
            recommendation: found.recommendation,
            excerpt: found.excerpt,
            source: "detected",
          });
          createdIds.push(item.id);
        }
        for (const id of result.resolvedItemIds) {
          const item = byId.get(id);
          // Card items close only through their card.
          if (!item || item.source === "card" || resolvedIds.includes(id)) continue;
          store.close(id, "resolved");
          resolvedIds.push(id);
        }
        if (repeatedIds.length > 0 || resolvedIds.length > 0) publish();
      }

      store.logDetection({
        ...base,
        outcome: result.outcome,
        scores: result.scores,
        passTwoRan: result.passTwoRan,
        createdIds,
        repeatedIds,
        resolvedIds,
        durationMs: result.durationMs,
        error: result.error ? clip(result.error, 1000) : null,
      });
    }

    // -----------------------------------------------------------------------
    // Actions (shared by RPC and CLI)

    async function answerItemUnlocked(input: {
      id: string;
      answers?: CardAnswer[];
      text?: string;
      acceptRecommendation?: boolean;
    }): Promise<Item> {
      const item = liveItem(input.id);

      if (item.source === "card" && item.card) {
        let response;
        try {
          response = buildCardResponse(item.card, input);
        } catch (error) {
          refuse("invalid", errorMessage(error));
        }
        try {
          await bb.sdk.threads.interactions.respond({
            threadId: item.threadId,
            interactionId: item.card.interactionId,
            value: response,
          });
        } catch (error) {
          // The card may have settled in its thread meanwhile. Say so, so the
          // page does not confirm an answer the card did not take.
          const settled = await refreshCard(item);
          // An HTTP error means bb refused the answer. A network error is
          // ambiguous: the answer may have landed, so report no conflict.
          if (settled && error instanceof experimental_BbHttpError) {
            refuse("conflict", `the card of ${item.id} was already settled in its thread`);
          }
          if (settled) return settled;
          throw error;
        }
        return closeItem(item.id, "answered", describeCardResponse(item.card, response));
      }

      let answer: string | null = null;
      const first = input.answers?.[0];
      if (input.text !== undefined) {
        answer = input.text;
      } else if (input.acceptRecommendation) {
        if (!item.recommendation) refuse("invalid", `${item.id} has no recommendation`);
        answer = item.recommendation;
      } else if (first && "text" in first) {
        answer = first.text;
      } else if (first && "option" in first) {
        answer = item.options?.[first.option] ?? null;
        if (answer === null) refuse("invalid", `${item.id} has no option ${first.option}`);
      }
      if (answer === null) refuse("invalid", "give text, an answer, or acceptRecommendation");
      await sendToThread(item.threadId, answerMessage(item, answer));
      return closeItem(item.id, "answered", answer);
    }

    async function doneItemUnlocked(id: string, note: string | undefined): Promise<Item> {
      const item = liveItem(id);
      if (item.kind !== "do") refuse("invalid", `${id} is not a "do" item`);
      const cleanNote = note?.trim() || undefined;
      await sendToThread(item.threadId, doneMessage(item, cleanNote));
      return closeItem(item.id, "done", cleanNote ?? null);
    }

    async function dismissItemUnlocked(id: string): Promise<Item> {
      const item = liveItem(id);
      if (item.source === "card" && item.card) {
        try {
          await bb.sdk.threads.interactions.cancel({
            threadId: item.threadId,
            interactionId: item.card.interactionId,
          });
        } catch (error) {
          // Close only when the card no longer waits; else keep the item open.
          const settled = await refreshCard(item);
          if (settled) return settled;
          throw error;
        }
      } else if (item.source === "tool") {
        await sendToThread(item.threadId, dismissMessage(item));
      }
      return closeItem(item.id, "dismissed");
    }

    async function handToParentUnlocked(id: string, note: string | undefined): Promise<Item> {
      const item = liveItem(id);
      let parent: string | null = null;
      try {
        parent = (await bb.sdk.threads.get({ threadId: item.threadId })).parentThreadId;
      } catch {
        parent = null;
      }
      parent ??= item.parentThreadId;
      if (!parent) refuse("invalid", `the thread of ${id} has no parent thread`);
      const cleanNote = note?.trim() || undefined;
      await sendToThread(parent, handMessage(item, cleanNote));
      return closeItem(item.id, "handed", cleanNote ?? null);
    }

    // One action at a time per item: two clients that answer at once must
    // not both send a message to the thread.
    const busyItems = new Set<string>();
    async function exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
      if (busyItems.has(id)) refuse("conflict", `${id} is being handled; try again`);
      busyItems.add(id);
      try {
        return await action();
      } finally {
        busyItems.delete(id);
      }
    }
    const answerItem = (input: Parameters<typeof answerItemUnlocked>[0]) => exclusive(input.id, () => answerItemUnlocked(input));
    const doneItem = (id: string, note: string | undefined) => exclusive(id, () => doneItemUnlocked(id, note));
    const dismissItem = (id: string) => exclusive(id, () => dismissItemUnlocked(id));
    const handToParent = (id: string, note: string | undefined) => exclusive(id, () => handToParentUnlocked(id, note));

    function closeById(id: string, reason: string | undefined): Item {
      liveItem(id);
      if (reason) bb.log.info(`closed ${id}: ${clip(reason, 200)}`);
      return closeItem(id, "closed");
    }

    // -----------------------------------------------------------------------
    // Events

    bb.events.on("interaction.pending", async ({ thread, interaction }) => {
      await mirrorCard(interaction as InteractionLike, thread);
    });

    bb.events.on("experimental_thread.events", async ({ thread, sequence }) => {
      await Promise.all([
        store.liveCards(thread.id).length > 0 ? syncCards(thread.id) : undefined,
        thread.deletedAt === null ? scanForAnswers(thread, sequence) : undefined,
      ]);
    });

    bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
      if (store.liveCards(thread.id).length > 0) await syncCards(thread.id);
      const reply = lastAssistantText?.trim() ?? "";
      // A child thread's final reply goes to an agent, not to the user.
      if (reply === "" || thread.parentThreadId !== null) return;
      await queueDetection(thread, reply);
    });

    const closeThreadItems = ({ thread }: { thread: { id: string } }) => {
      archivedThreads.add(thread.id);
      answerCursors.delete(thread.id);
      if (store.closeThread(thread.id, "archived").length > 0) publish();
    };
    bb.events.on("thread.archived", closeThreadItems);
    bb.events.on("thread.deleted", closeThreadItems);
    bb.events.on("thread.unarchived", ({ thread }: { thread: { id: string } }) => {
      archivedThreads.delete(thread.id);
    });

    // -----------------------------------------------------------------------
    // Background work

    bb.background.service("startup", {
      async start(signal) {
        try {
          store.wakeSnoozed();
          await syncCards();
          await discoverCards(signal);
        } catch (error) {
          bb.log.warn(`startup reconcile failed: ${errorMessage(error)}`);
        }
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });

    bb.background.schedule("sweep", "*/5 * * * *", async () => {
      store.wakeSnoozed();
      await syncCards();
    });

    bb.background.schedule("nudge", "0 * * * *", async () => {
      const values = await settings.get();
      if (!values.pings) return;
      const date = new Date(now());
      if (date.getHours() !== values.nudgeHour) return;
      const today = localDate(date);
      if ((await bb.storage.kv.get<string>(NUDGE_DATE_KEY)) === today) return;
      const { openCount } = store.counts();
      if (openCount === 0) return;
      const oldest = store.oldestOpenAt();
      await ping(
        `Inbox: ${openCount} open`,
        oldest === null ? "" : `oldest ${formatAge(now() - oldest)}`,
      );
      await bb.storage.kv.set(NUDGE_DATE_KEY, today);
    });

    // -----------------------------------------------------------------------
    // Agent tool

    bb.agents.registerTool({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      presentation: {
        label: { pending: "Adding to the inbox", completed: "Added to the inbox" },
        icon: { glyph: "Inbox" },
      },
      parameters: askInputSchema,
      async execute(input, { threadId }) {
        const { item, repeated } = await ask(await snapshotFor(threadId), input);
        return repeated
          ? `Already in the user's inbox as ${item.id} (asked ${item.askCount} times); bumped it. Do not wait; the answer arrives in this thread as a message.`
          : `Added to the user's inbox as ${item.id}. Do not wait; the answer arrives in this thread as a message.`;
      },
    });

    bb.agents.contributeInstructions(() => INSTRUCTIONS);

    // -----------------------------------------------------------------------
    // RPC

    bb.rpc.register(rpcContract, {
      async items_list({ includeClosed }) {
        return {
          items: store.list({ includeClosed: includeClosed ?? false }),
          detection: (await detection()).status,
        };
      },
      items_get({ id }) {
        const item = store.get(id);
        if (item === null) refuse("not_found", `no inbox item ${id}`);
        return item;
      },
      items_mark_read({ id }) {
        if (store.get(id) === null) refuse("not_found", `no inbox item ${id}`);
        const item = store.markRead(id);
        publish();
        return item;
      },
      items_answer: (input) => answerItem(input),
      items_done: ({ id, note }) => doneItem(id, note),
      items_snooze({ id, until }) {
        liveItem(id);
        if (until <= now()) refuse("invalid", "until must be in the future");
        const item = store.snooze(id, until);
        publish();
        return item;
      },
      items_unsnooze({ id }) {
        liveItem(id);
        const item = store.unsnooze(id);
        publish();
        return item;
      },
      items_dismiss: ({ id }) => dismissItem(id),
      items_hand_to_parent: ({ id, note }) => handToParent(id, note),
      items_close: ({ id, reason }) => closeById(id, reason),
      async status() {
        return { detection: (await detection()).status, ...store.counts() };
      },
    });

    // -----------------------------------------------------------------------
    // CLI

    const json = { type: "boolean", description: "Print JSON" } as const;

    bb.cli.register(
      defineCli({
        name: "inbox",
        summary: "The user's inbox: list, add, and close items that wait on the user",
        commands: {
          list: cliCommand({
            summary: "List open inbox items (newest ask first)",
            options: {
              json,
              thread: { type: "string", description: "Only items of this thread id" },
              project: { type: "string", description: "Only items of this project id" },
              all: { type: "boolean", description: "Include snoozed items" },
              limit: {
                type: "integer",
                min: 1,
                max: 1000,
                default: 200,
                description: "At most this many items (1-1000, default 200)",
              },
            },
            run({ options }) {
              const items = store
                .list()
                .filter((item) => options.all || item.status === "open")
                .filter((item) => !options.thread || item.threadId === options.thread)
                .filter((item) => !options.project || item.projectId === options.project);
              const shown = items.slice(0, options.limit);
              if (options.json) {
                return { exitCode: 0, stdout: `${JSON.stringify(shown.map(toCliItem), null, 2)}\n` };
              }
              if (shown.length === 0) return { exitCode: 0, stdout: "The inbox is empty.\n" };
              const at = now();
              const lines = shown.map((item) => {
                const status = item.status === "snoozed" ? " snoozed" : "";
                const repeat = item.askCount > 1 ? ` ×${item.askCount}` : "";
                return `${item.id}  ${item.kind.padEnd(7)} ${formatAge(at - item.createdAt).padStart(4)}${status}${repeat}  ${clip(item.question, 100)}  (${item.threadId})`;
              });
              if (items.length > shown.length) {
                lines.push(`… ${items.length - shown.length} more; raise --limit to see them.`);
              }
              return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
            },
          }),
          ask: cliCommand({
            summary: "Add an item to the user's inbox (an ask repeated in the same thread bumps the open item)",
            options: {
              json,
              kind: {
                type: "enum",
                values: ["decide", "approve", "do"],
                required: true,
                description: "decide, approve, or do",
              },
              question: {
                type: "string",
                required: true,
                description: `One line, at most ${LIMITS.question} characters`,
              },
              context: {
                type: "string",
                description: `Markdown context, at most ${LIMITS.context} characters`,
              },
              option: {
                type: "string",
                repeatable: true,
                aliases: ["options"],
                description: `An answer option; repeat for more (at most ${LIMITS.options})`,
              },
              recommendation: {
                type: "string",
                description: `Your recommended answer, at most ${LIMITS.recommendation} characters`,
              },
              ref: { type: "string", description: `Your reference (issue id), at most ${LIMITS.ref} characters` },
              thread: { type: "string", description: "Source thread id (default: the current thread)" },
            },
            async run({ options }, ctx) {
              const threadId = options.thread ?? ctx.threadId;
              if (!threadId) {
                throw new PluginCliError("no thread to attach the item to", {
                  code: "thread_required",
                  hint: "Run it inside a bb thread, or add --thread <thread-id>.",
                });
              }
              const parsed = askInputSchema.safeParse({
                kind: options.kind,
                question: options.question,
                context: options.context,
                options: options.option.length > 0 ? options.option : undefined,
                recommendation: options.recommendation,
                ref: options.ref,
              });
              if (!parsed.success) {
                const issue = parsed.error.issues[0]!;
                throw new PluginCliError(
                  `--${String(issue.path[0] ?? "input")}: ${issue.message}`,
                  { code: "invalid_input" },
                );
              }
              let snapshot: ThreadSnapshot;
              try {
                const thread = await bb.sdk.threads.get({ threadId });
                if (thread.archivedAt) {
                  throw new PluginCliError(`thread ${threadId} is archived`, {
                    code: "thread_archived",
                  });
                }
                snapshot = await snapshotOf(thread);
              } catch (error) {
                if (error instanceof experimental_BbHttpError && error.status === 404) {
                  throw new PluginCliError(`thread ${threadId} not found`, {
                    code: "thread_not_found",
                    hint: "Check the id with `bb thread list`.",
                  });
                }
                throw error;
              }
              const { item, repeated } = await ask(snapshot, parsed.data);
              if (options.json) {
                return {
                  exitCode: 0,
                  stdout: `${JSON.stringify({ repeated, item: toCliItem(item) }, null, 2)}\n`,
                };
              }
              return {
                exitCode: 0,
                stdout: repeated
                  ? `Bumped ${item.id} (asked ${item.askCount} times).\n`
                  : `Added ${item.id} to the inbox.\n`,
              };
            },
          }),
          close: cliCommand({
            summary: "Close an inbox item without a message to its thread",
            positionals: [{ name: "id", description: "Item id (inb_…)", required: true }],
            options: {
              json,
              reason: { type: "string", description: `Why (logged), at most ${LIMITS.note} characters` },
            },
            run({ positionals, options }) {
              const existing = store.get(positionals.id);
              if (existing === null) {
                throw new PluginCliError(`no inbox item ${positionals.id}`, {
                  code: "not_found",
                  hint: "Run `bb inbox list --all` to see the ids.",
                });
              }
              if (existing.status === "closed") {
                throw new PluginCliError(
                  `${existing.id} is already closed (${existing.closeReason ?? "closed"})`,
                  { code: "already_closed" },
                );
              }
              const item = closeById(existing.id, options.reason);
              if (options.json) {
                return {
                  exitCode: 0,
                  stdout: `${JSON.stringify({ id: item.id, status: item.status, closeReason: item.closeReason })}\n`,
                };
              }
              return { exitCode: 0, stdout: `Closed ${item.id}.\n` };
            },
          }),
          status: cliCommand({
            summary: "Show detection on/off and item counts",
            options: { json },
            async run({ options }) {
              const status = { detection: (await detection()).status, ...store.counts() };
              if (options.json) return { exitCode: 0, stdout: `${JSON.stringify(status, null, 2)}\n` };
              const d = status.detection;
              return {
                exitCode: 0,
                stdout: [
                  `Detection: ${d.enabled ? "on" : `off (${d.reason ?? "unknown"})`}, model ${d.model}`,
                  `Open: ${status.openCount} (${status.unreadCount} unread), snoozed: ${status.snoozedCount}`,
                ].join("\n") + "\n",
              };
            },
          }),
          detections: cliCommand({
            summary: "Show the newest detection log rows (for threshold tuning)",
            options: {
              json,
              limit: {
                type: "integer",
                min: 1,
                max: 500,
                default: 20,
                description: "At most this many rows (1-500, default 20)",
              },
            },
            run({ options }) {
              const rows = store
                .listDetections(options.limit)
                .map((row) => ({ ...row, at: new Date(row.at).toISOString() }));
              if (options.json) return { exitCode: 0, stdout: `${JSON.stringify(rows, null, 2)}\n` };
              if (rows.length === 0) return { exitCode: 0, stdout: "No detections logged.\n" };
              const lines = rows.map((row) => {
                const scores = row.scores as { ask?: number | null } | null;
                const askScore = typeof scores?.ask === "number" ? scores.ask.toFixed(2) : "-";
                const ids = [
                  row.createdIds.length ? `created ${row.createdIds.join(",")}` : "",
                  row.repeatedIds.length ? `repeated ${row.repeatedIds.join(",")}` : "",
                  row.resolvedIds.length ? `resolved ${row.resolvedIds.join(",")}` : "",
                  row.error ? `error ${clip(row.error, 120)}` : "",
                ]
                  .filter(Boolean)
                  .join("; ");
                return `${row.at}  ${row.threadId}  ${row.outcome.padEnd(13)} ask=${askScore}${row.passTwoRan ? " pass2" : ""} ${row.durationMs}ms${ids ? `  ${ids}` : ""}`;
              });
              return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
            },
          }),
        },
      }),
    );
  };
}

export default createInboxPlugin();
