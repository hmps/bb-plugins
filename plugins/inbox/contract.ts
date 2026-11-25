// bb-plugin-inbox — the shared contract.
//
// server.ts, app.tsx, detection.ts, and the tests all build against this
// file. app.tsx imports types only. Change a shape here first, then follow
// the compiler.
//
// The inbox holds only items that wait on the user. An item comes from one
// of three sources:
//   - "card":     a pending interaction of the builtin decisions plugin
//                 (origin pluginId "bb--decisions", rendererId "decisions").
//   - "tool":     an agent called the `inbox_ask` tool (or `bb inbox ask`).
//   - "detected": the detection pass found an ask in an agent's final reply.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants

export const PLUGIN_ID = "inbox";
/** Realtime channel. Every write publishes it; the payload is ItemsChanged. */
export const ITEMS_CHANGED = "items-changed";
export const DECISIONS_PLUGIN_ID = "bb--decisions";
export const DECISIONS_RENDERER_ID = "decisions";
export const PUSH_PLUGIN_ID = "push-notifications";
export const PUSH_METHOD = "notifications.send";
export const TOOL_NAME = "inbox_ask";
export const DEFAULT_DETECTION_MODEL = "gpt-6-luna";

/** Field limits, shared by the tool, the CLI, and the RPC boundary. */
export const LIMITS = {
  question: 300,
  context: 20_000,
  option: 200,
  options: 8,
  recommendation: 500,
  ref: 120,
  answer: 4_000,
  note: 2_000,
} as const;

// ---------------------------------------------------------------------------
// Items

export const itemKindSchema = z.enum(["decide", "approve", "do"]);
export type ItemKind = z.infer<typeof itemKindSchema>;

export const itemSourceSchema = z.enum(["card", "tool", "detected"]);
export type ItemSource = z.infer<typeof itemSourceSchema>;

/** "snoozed" turns back into "open" when snoozedUntil passes. */
export const itemStatusSchema = z.enum(["open", "snoozed", "closed"]);
export type ItemStatus = z.infer<typeof itemStatusSchema>;

export const closeReasonSchema = z.enum([
  "answered", // answered in the inbox (reply, option, or accepted recommendation)
  "answered-in-thread", // detection saw a user answer in the source thread
  "done", // the user clicked Done on a "do" item
  "dismissed", // the user dismissed it
  "handed", // handed to the thread's parent
  "archived", // its thread was archived or deleted
  "card-settled", // the card settled outside the inbox (answer in thread, card dismissed or expired)
  "resolved", // detection saw a later reply that resolves it
  "closed", // `bb inbox close` or the `items_close` RPC
]);
export type CloseReason = z.infer<typeof closeReasonSchema>;

/** One decision of a decisions-plugin card, as its payload carries it. */
export const cardDecisionSchema = z.object({
  question: z.string(),
  context: z.string(),
  options: z.array(z.object({ label: z.string(), does: z.string() })),
  /** Zero-based index of the suggested option, or null. */
  suggested: z.number().int().nonnegative().nullable(),
  links: z.array(z.object({ label: z.string(), href: z.string() })),
});
export type CardDecision = z.infer<typeof cardDecisionSchema>;

export const cardSchema = z.object({
  interactionId: z.string(),
  headline: z.string(),
  decisions: z.array(cardDecisionSchema).min(1),
});
export type Card = z.infer<typeof cardSchema>;

/**
 * The value the decisions plugin accepts through
 * `threads.interactions.respond`: one answer per decision, in order.
 * Proven live on 2026-11-25 (see README, "Card sync").
 */
export const cardAnswerSchema = z.union([
  z.strictObject({ option: z.number().int().nonnegative() }),
  z.strictObject({ text: z.string().trim().min(1).max(LIMITS.answer) }),
]);
export type CardAnswer = z.infer<typeof cardAnswerSchema>;
export const cardResponseSchema = z.strictObject({
  answers: z.array(cardAnswerSchema).min(1),
});
export type CardResponse = z.infer<typeof cardResponseSchema>;

export const itemSchema = z.object({
  id: z.string(), // "inb_" + 10 url-safe chars
  threadId: z.string(),
  projectId: z.string().nullable(),
  /** Snapshots for display, refreshed when the item updates. */
  threadTitle: z.string().nullable(),
  projectName: z.string().nullable(),
  /** The source thread's parent at creation, or null for a top-level thread. */
  parentThreadId: z.string().nullable(),
  kind: itemKindSchema,
  /** One line. For a card with several decisions: the card headline. */
  question: z.string(),
  /** Markdown. */
  context: z.string().nullable(),
  options: z.array(z.string()).nullable(),
  recommendation: z.string().nullable(),
  ref: z.string().nullable(),
  source: itemSourceSchema,
  /** Set only when source is "card". */
  card: cardSchema.nullable(),
  status: itemStatusSchema,
  /** Epoch ms. */
  createdAt: z.number(),
  updatedAt: z.number(),
  lastAskedAt: z.number(),
  askCount: z.number().int().positive(),
  readAt: z.number().nullable(),
  snoozedUntil: z.number().nullable(),
  closedAt: z.number().nullable(),
  closeReason: closeReasonSchema.nullable(),
  /** What the user answered, as text, when the item closed by an answer. */
  answer: z.string().nullable(),
  /** Thread message sequence of the ask, for a deep link, when known. */
  messageSeq: z.number().int().nullable(),
});
export type Item = z.infer<typeof itemSchema>;

// ---------------------------------------------------------------------------
// CLI JSON (`bb inbox list --json`). Starbase pulls this. Keep it stable:
// add fields only, never rename or remove one.

export const cliItemSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  projectId: z.string().nullable(),
  kind: itemKindSchema,
  question: z.string(),
  recommendation: z.string().nullable(),
  source: itemSourceSchema,
  status: z.enum(["open", "snoozed"]),
  ref: z.string().nullable(),
  /** ISO 8601. */
  createdAt: z.string(),
  /** ISO 8601. */
  lastAskedAt: z.string(),
  askCount: z.number().int().positive(),
});
export type CliItem = z.infer<typeof cliItemSchema>;

// ---------------------------------------------------------------------------
// Ask input (the `inbox_ask` tool, `bb inbox ask`)

export const askInputSchema = z.object({
  kind: itemKindSchema,
  question: z.string().trim().min(1).max(LIMITS.question),
  context: z.string().max(LIMITS.context).optional(),
  options: z
    .array(z.string().trim().min(1).max(LIMITS.option))
    .max(LIMITS.options)
    .optional(),
  recommendation: z.string().trim().min(1).max(LIMITS.recommendation).optional(),
  ref: z.string().trim().min(1).max(LIMITS.ref).optional(),
});
export type AskInput = z.infer<typeof askInputSchema>;

// ---------------------------------------------------------------------------
// Detection status (shown in the UI and `bb inbox status`)

export const detectionStatusSchema = z.object({
  enabled: z.boolean(),
  /** Why detection is off, such as "no OpenAI API key set". Null when on. */
  reason: z.string().nullable(),
  model: z.string(),
});
export type DetectionStatus = z.infer<typeof detectionStatusSchema>;

// ---------------------------------------------------------------------------
// RPC contract (app.tsx → server.ts)

const idInput = z.object({ id: z.string().min(1).max(64) });

export const rpcContract = defineRpcContract({
  /** Open and snoozed items, newest ask first; closed ones with includeClosed. */
  items_list: {
    input: z.object({ includeClosed: z.boolean().optional() }),
    output: z.object({
      items: z.array(itemSchema),
      detection: detectionStatusSchema,
    }),
  },
  items_get: { input: idInput, output: itemSchema },
  /** Opening an item marks it read. Never closes it. */
  items_mark_read: { input: idInput, output: itemSchema },
  /**
   * Answer an item; closes it with reason "answered".
   * - card: `answers` (one per decision) or `acceptRecommendation` (every
   *   decision must have a suggested option). Answers the card in its thread.
   * - tool / detected: `text` or `acceptRecommendation`. Sends the answer to
   *   the thread as a message.
   */
  items_answer: {
    input: z.object({
      id: z.string().min(1).max(64),
      answers: z.array(cardAnswerSchema).min(1).optional(),
      text: z.string().trim().min(1).max(LIMITS.answer).optional(),
      acceptRecommendation: z.boolean().optional(),
    }),
    output: itemSchema,
  },
  /** "do" items: closes with "done" and tells the thread. Optional note. */
  items_done: {
    input: idInput.extend({
      note: z.string().trim().max(LIMITS.note).optional(),
    }),
    output: itemSchema,
  },
  /** until: epoch ms, in the future. */
  items_snooze: {
    input: idInput.extend({ until: z.number().int().positive() }),
    output: itemSchema,
  },
  items_unsnooze: { input: idInput, output: itemSchema },
  /** Closes with "dismissed". A card is cancelled in its thread too. */
  items_dismiss: { input: idInput, output: itemSchema },
  /** Sends the item to the source thread's parent and closes with "handed". */
  items_hand_to_parent: {
    input: idInput.extend({
      note: z.string().trim().max(LIMITS.note).optional(),
    }),
    output: itemSchema,
  },
  /** Closes with "closed" (no message to the thread). */
  items_close: {
    input: idInput.extend({
      reason: z.string().trim().max(LIMITS.note).optional(),
    }),
    output: itemSchema,
  },
  status: {
    input: z.null(),
    output: z.object({
      detection: detectionStatusSchema,
      openCount: z.number().int().nonnegative(),
      snoozedCount: z.number().int().nonnegative(),
      unreadCount: z.number().int().nonnegative(),
    }),
  },
});
export type RpcContract = typeof rpcContract;

export type ItemsChanged = { openCount: number; unreadCount: number };

// ---------------------------------------------------------------------------
// Detection interface (detection.ts implements it; server.ts calls it)

/** An open item of the same thread, as the detector sees it. */
export interface DetectionOpenItem {
  id: string;
  kind: ItemKind;
  question: string;
  recommendation: string | null;
  source: ItemSource;
  askCount: number;
}

export interface DetectionInput {
  threadId: string;
  /** The final reply of the turn, to the user. Never empty. */
  reply: string;
  openItems: DetectionOpenItem[];
}

export interface DetectedAsk {
  kind: ItemKind;
  question: string; // one line, at most LIMITS.question chars
  options: string[] | null;
  recommendation: string | null;
  context: string | null; // short Markdown
  /** The id of an open item this ask repeats, or null for a new ask. */
  repeatOfItemId: string | null;
}

export type DetectionOutcome =
  | "no-ask" // pass 1 below threshold, nothing resolved
  | "asks" // pass 2 ran and returned at least one ask
  | "covered" // pass 1 says the ask is already covered by an open item
  | "resolved-only" // no ask, but one or more open items resolved
  | "error";

export type AnswerCheckItem = Pick<Item, "id" | "question" | "options" | "recommendation">;

export interface AnswerCheckResult {
  scores: Record<string, number>;
  answeredItemIds: string[];
}

export interface DetectionScores {
  /** Pass 1: probability that the reply asks the user for something. */
  ask: number | null;
  /** Pass 1 choice: new ask, repeat of an open item, or already covered. */
  novelty: { new: number; repeat: number; covered: number } | null;
  /** Pass 1: per open item id, probability that the reply resolves it. */
  resolved: Record<string, number>;
}

export interface DetectionResult {
  outcome: DetectionOutcome;
  scores: DetectionScores;
  passTwoRan: boolean;
  /** New asks (repeatOfItemId null) and repeats (repeatOfItemId set). */
  asks: DetectedAsk[];
  /** Open items to close with reason "resolved". */
  resolvedItemIds: string[];
  /** Set when outcome is "error". Never contains the API key. */
  error: string | null;
  /** Wall time of both passes. */
  durationMs: number;
}

export interface Detector {
  detect(input: DetectionInput, signal?: AbortSignal): Promise<DetectionResult>;
  checkAnswer(message: string, items: AnswerCheckItem[], signal?: AbortSignal): Promise<AnswerCheckResult>;
}

export interface DetectorOptions {
  apiKey: string;
  model: string; // default DEFAULT_DETECTION_MODEL
  /** Pass 2 runs only when scores.ask >= askThreshold. Default 0.6. */
  askThreshold: number;
  /** An open item resolves when its score >= resolveThreshold. Default 0.8. */
  resolveThreshold: number;
  /** A user message answers an item when its score >= answerThreshold. Default 0.8. */
  answerThreshold: number;
  /** Injected for tests. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Default "https://api.openai.com/v1". */
  baseUrl?: string;
  /** Per request. Default 20_000. */
  timeoutMs?: number;
}
