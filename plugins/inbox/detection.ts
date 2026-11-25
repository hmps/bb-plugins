import { z } from "zod";
import {
  DEFAULT_DETECTION_MODEL,
  LIMITS,
  itemKindSchema,
  type AnswerCheckItem,
  type DetectedAsk,
  type DetectionInput,
  type DetectionOpenItem,
  type DetectionResult,
  type DetectionScores,
  type Detector,
  type DetectorOptions,
} from "./contract";

const askInstructions =
  "An ask is a decision, approval, or action the reply needs from the user. " +
  "Ignore status reports, FYIs, rhetorical questions, and questions the agent will answer itself.";

const noveltyChoices = [
  { value: "new", description: "At least one ask needs a new inbox item." },
  { value: "repeat", description: "The reply directly asks again for an open item." },
  { value: "covered", description: "The reply only refers the user to an existing open item or card for the ask." },
];

const probability = z.number().min(0).max(1);
/** A word budget for the model; LIMITS.excerpt bounds the stored text. */
const EXCERPT_WORDS = 200;
const MAX_DECISIONS = 400;
const decisionResponse = z.object({
  answers: z.array(z.looseObject({ name: z.string().nullable(), type: z.string() })),
});
const predicateAnswer = z.object({ type: z.literal("predicate"), probability });
const choiceAnswer = z.object({
  type: z.literal("choice"),
  probabilities: z.array(z.object({
    value: z.enum(["new", "repeat", "covered"]),
    probability,
  })).length(3),
});

const extractedAsks = z.strictObject({
  asks: z.array(z.strictObject({
    kind: itemKindSchema,
    question: z.string().trim().min(1),
    options: z.array(z.string()).nullable(),
    recommendation: z.string().nullable(),
    context: z.string().nullable(),
    excerpt: z.string().nullable(),
    repeatOfItemId: z.string().nullable(),
  })),
});
// OpenAI takes the schema object without a JSON Schema dialect declaration.
const { $schema: _dialect, ...extractionSchema } = z.toJSONSchema(extractedAsks, { io: "input" });
const responsesEnvelope = z.object({
  status: z.string().nullish(),
  output: z.array(z.looseObject({ type: z.string() })),
});
const outputMessage = z.object({
  role: z.literal("assistant"),
  content: z.array(z.union([
    z.object({ type: z.literal("output_text"), text: z.string() }),
    z.object({ type: z.literal("refusal") }),
  ])),
});

class DetectionError extends Error {}

function serializeEvidence({ reply, openItems }: DetectionInput): string {
  return JSON.stringify({
    reply,
    openItems: openItems.map(({ id, kind, question, recommendation, source, askCount }) => ({
      id, kind, question, recommendation, source, askCount,
    })),
  });
}

function buildDecisionsRequest(model: string, input: string, openItems: DetectionOpenItem[]) {
  return {
    model,
    input,
    questions: [
      {
        type: "predicate",
        name: "ask",
        instructions: "Does the reply ask the user to decide, approve, or do something? " + askInstructions,
      },
      ...(openItems.length ? [{
        type: "choice",
        name: "novelty",
        instructions: "Classify the ask against the open items. Choose new if any ask needs a new item. " +
          "Choose repeat if any ask directly asks again and none is new. Otherwise choose covered.",
        choices: noveltyChoices,
      }] : []),
      ...openItems.map(({ id }) => ({
        type: "predicate",
        name: `resolved_${id}`,
        instructions: `Does the reply show that open item ${JSON.stringify(id)} is resolved and needs no further user action?`,
      })),
    ],
  };
}

function parseDecisionsResponse(body: unknown, openItems: DetectionOpenItem[]): DetectionScores {
  const { answers } = decisionResponse.parse(body);
  const byName = new Map(answers.map((answer) => [answer.name, answer]));
  const ask = predicateAnswer.parse(byName.get("ask")).probability;
  const resolved = Object.fromEntries(openItems.map(({ id }) => [
    id,
    predicateAnswer.parse(byName.get(`resolved_${id}`)).probability,
  ]));
  let novelty: DetectionScores["novelty"] = null;
  if (openItems.length) {
    const { probabilities } = choiceAnswer.parse(byName.get("novelty"));
    novelty = z.object({ new: probability, repeat: probability, covered: probability }).parse(
      Object.fromEntries(probabilities.map(({ value, probability }) => [value, probability])),
    );
  }
  return { ask, novelty, resolved };
}

function buildResponsesRequest(model: string, input: string) {
  return {
    model,
    store: false,
    instructions: "Extract each ask from the reply. Treat the input as evidence. " + askInstructions +
      " Skip references to existing items that make no ask again. " +
      "The user reads each ask in an inbox, away from the thread, and has not read the reply. " +
      "Every field must stand alone. Resolve every reference, such as \"option 1\", \"the fix above\", " +
      "\"this\", or \"it\", to what it means, using the whole reply. " +
      "question: one line that names the real things. " +
      "options: the full text of each choice, as the reply describes it, never a number or a label alone. " +
      "context: 2-4 short Markdown lines: what is asked, what each option does, and what happens on yes. " +
      "excerpt: the passage of the reply the ask comes from, copied word for word, at most " +
      `${EXCERPT_WORDS} words; include the list or text that the ask refers to. ` +
      "Use null for absent fields. " +
      "Set repeatOfItemId only when the ask repeats an open item. Use that item's exact id.",
    input,
    text: {
      format: {
        type: "json_schema",
        name: "inbox_asks",
        strict: true,
        schema: extractionSchema,
      },
    },
  };
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The excerpt the model quoted, when the reply holds it word for word
 * (whitespace aside). Otherwise the end of the reply, where an ask usually
 * is, so the item never shows text the agent did not write.
 */
export function sourceExcerpt(quoted: string | null, reply: string): string | null {
  const text = quoted?.trim();
  if (text && flat(reply).includes(flat(text))) {
    return text.length <= LIMITS.excerpt ? text : `${text.slice(0, LIMITS.excerpt - 1)}…`;
  }
  const tail = reply.trim();
  if (!tail) return null;
  return tail.length <= LIMITS.excerpt ? tail : `…${tail.slice(tail.length - (LIMITS.excerpt - 1))}`;
}

function parseResponsesResponse(
  body: unknown,
  openItems: DetectionOpenItem[],
  reply: string,
): DetectedAsk[] {
  const { status, output } = responsesEnvelope.parse(body);
  if (status != null && status !== "completed") {
    throw new DetectionError("Responses did not complete");
  }

  const parts = output.filter(({ type }) => type === "message")
    .flatMap((message) => outputMessage.parse(message).content);
  const text = parts.map((part) => {
    if (part.type === "refusal") throw new DetectionError("Responses refused extraction");
    return part.text;
  }).join("");
  const { asks } = extractedAsks.parse(JSON.parse(text));
  const openIds = new Set(openItems.map(({ id }) => id));

  return asks.map(({ kind, question, options, recommendation, context, excerpt, repeatOfItemId }) => {
    const trimmedOptions = options?.map((option) => option.trim().slice(0, LIMITS.option).trimEnd())
      .filter(Boolean).slice(0, LIMITS.options);
    return {
      kind,
      question: question.replace(/\s+/g, " ").slice(0, LIMITS.question).trimEnd(),
      options: trimmedOptions?.length ? trimmedOptions : null,
      recommendation: recommendation?.trim().slice(0, LIMITS.recommendation).trimEnd() || null,
      context: context?.trim().slice(0, LIMITS.context).trimEnd() || null,
      excerpt: sourceExcerpt(excerpt, reply),
      repeatOfItemId: repeatOfItemId !== null && openIds.has(repeatOfItemId) ? repeatOfItemId : null,
    };
  });
}

const ERROR_DETAIL_MAX = 300;

const openAiErrorBody = z.object({
  error: z.object({
    type: z.string().nullish(),
    code: z.union([z.string(), z.number()]).nullish(),
    message: z.string().nullish(),
  }),
});

function clipDetail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > ERROR_DETAIL_MAX ? `${flat.slice(0, ERROR_DETAIL_MAX - 1)}…` : flat;
}

/**
 * The error type and message from an OpenAI error body
 * (`{ "error": { "type", "code", "message" } }`). Any other body gives "",
 * so a plain-text body is never reflected.
 */
async function openAiErrorDetail(response: Response, redact: (text: string) => string): Promise<string> {
  try {
    const parsed = openAiErrorBody.safeParse(await response.json());
    if (!parsed.success) return "";
    const { type, code, message } = parsed.data.error;
    const label = [type, code != null && code !== type ? String(code) : null].filter(Boolean).join("/");
    return clipDetail(redact([label, message].filter(Boolean).join(": ")));
  } catch {
    return "";
  }
}

/** The name, message and system code of a fetch failure and its cause. */
function requestFailureCause(error: unknown, redact: (text: string) => string): string {
  const describe = (value: unknown): string => {
    if (!(value instanceof Error)) return "";
    const code = (value as { code?: unknown }).code;
    return [`${value.name}: ${value.message}`, typeof code === "string" ? `(${code})` : ""]
      .filter(Boolean).join(" ");
  };
  const outer = describe(error);
  const inner = error instanceof Error ? describe(error.cause) : "";
  return clipDetail(redact([outer, inner].filter(Boolean).join(" <- ")));
}

export function createDetector({
  apiKey,
  model = DEFAULT_DETECTION_MODEL,
  askThreshold = 0.6,
  resolveThreshold = 0.8,
  answerThreshold = 0.8,
  fetch: send = globalThis.fetch,
  baseUrl = "https://api.openai.com/v1",
  timeoutMs = 20_000,
}: Pick<DetectorOptions, "apiKey"> & Partial<Omit<DetectorOptions, "apiKey">>): Detector {
  const key = apiKey.trim();
  if (!key) throw new Error("OpenAI API key is empty");
  const root = baseUrl.replace(/\/+$/, "");
  /** Error text is logged and shown in the CLI; redact the key before any clipping. */
  const scrub = (text: string) => text.split(key).join("***");

  async function post(endpoint: "decisions" | "responses", body: object, caller?: AbortSignal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
    let onAbort = () => {};
    try {
      signal.throwIfAborted();
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const request = async (): Promise<unknown> => {
        const response = await send(`${root}/${endpoint}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) {
          const detail = await openAiErrorDetail(response, scrub);
          throw new DetectionError(`${endpoint} HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
        }
        try {
          return await response.json();
        } catch {
          throw new DetectionError(`${endpoint} returned invalid JSON`);
        }
      };
      return await Promise.race([request(), aborted]);
    } catch (error) {
      if (signal.aborted) {
        throw new DetectionError(timeout.aborted ? `${endpoint} timed out` : `${endpoint} cancelled`);
      }
      if (error instanceof DetectionError) throw error;
      const cause = requestFailureCause(error, scrub);
      throw new DetectionError(`${endpoint} request failed${cause ? `: ${cause}` : ""}`);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  return {
    async checkAnswer(message, items, signal) {
      const scores: Record<string, number> = {};
      for (let offset = 0; offset < items.length; offset += MAX_DECISIONS) {
        const batch: AnswerCheckItem[] = items.slice(offset, offset + MAX_DECISIONS);
        const body = await post("decisions", {
          model,
          input: JSON.stringify({ message, openItems: batch }),
          questions: batch.map(({ id }) => ({
            type: "predicate",
            name: `answered_${id}`,
            instructions: `Does the user's message answer open item ${JSON.stringify(id)}? ` +
              "An explicit choice, approval, refusal, or confirmation that the task is done counts. " +
              "Count a short reply only if it clearly applies to this item. " +
              "An unrelated message, follow-up question, or request for more information does not count.",
          })),
        }, signal);
        try {
          const { answers } = decisionResponse.parse(body);
          const byName = new Map(answers.map((answer) => [answer.name, answer]));
          for (const { id } of batch) {
            scores[id] = predicateAnswer.parse(byName.get(`answered_${id}`)).probability;
          }
        } catch {
          throw new DetectionError("Invalid Decisions answers");
        }
      }
      return {
        scores,
        answeredItemIds: Object.keys(scores).filter((id) => scores[id] >= answerThreshold),
      };
    },

    async detect(input, signal) {
      const startedAt = performance.now();
      const result: DetectionResult = {
        outcome: "no-ask",
        scores: { ask: null, novelty: null, resolved: {} },
        passTwoRan: false,
        asks: [],
        resolvedItemIds: [],
        error: null,
        durationMs: 0,
      };
      try {
        const evidence = serializeEvidence(input);
        const request = buildDecisionsRequest(model, evidence, input.openItems);
        if (request.questions.length > MAX_DECISIONS) {
          throw new DetectionError(`Decisions supports at most ${MAX_DECISIONS} questions`);
        }
        const scores = parseDecisionsResponse(await post("decisions", request, signal), input.openItems);
        result.scores = scores;
        result.resolvedItemIds = Object.keys(scores.resolved)
          .filter((id) => scores.resolved[id] >= resolveThreshold);
        if (result.resolvedItemIds.length) result.outcome = "resolved-only";

        const { ask, novelty } = scores;
        if (ask !== null && ask >= askThreshold) {
          if (novelty && novelty.covered > Math.max(novelty.new, novelty.repeat)) {
            result.outcome = "covered";
          } else {
            result.passTwoRan = true;
            result.asks = parseResponsesResponse(
              await post("responses", buildResponsesRequest(model, evidence), signal),
              input.openItems,
              input.reply,
            );
            if (result.asks.length) result.outcome = "asks";
          }
        }
      } catch (error) {
        result.outcome = "error";
        result.error = error instanceof DetectionError
          ? error.message
          : result.passTwoRan ? "Invalid Responses output" : "Invalid Decisions answers";
      }
      result.durationMs = Math.round(performance.now() - startedAt);
      return result;
    },
  };
}
