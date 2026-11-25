import { z } from "zod";
import {
  DEFAULT_DETECTION_MODEL,
  LIMITS,
  itemKindSchema,
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
      "Write each question on one line and keep context short. Use null for absent fields. " +
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

function parseResponsesResponse(body: unknown, openItems: DetectionOpenItem[]): DetectedAsk[] {
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

  return asks.map(({ kind, question, options, recommendation, context, repeatOfItemId }) => {
    const trimmedOptions = options?.map((option) => option.trim().slice(0, LIMITS.option).trimEnd())
      .filter(Boolean).slice(0, LIMITS.options);
    return {
      kind,
      question: question.replace(/\s+/g, " ").slice(0, LIMITS.question).trimEnd(),
      options: trimmedOptions?.length ? trimmedOptions : null,
      recommendation: recommendation?.trim().slice(0, LIMITS.recommendation).trimEnd() || null,
      context: context?.trim().slice(0, LIMITS.context).trimEnd() || null,
      repeatOfItemId: repeatOfItemId !== null && openIds.has(repeatOfItemId) ? repeatOfItemId : null,
    };
  });
}

export function createDetector({
  apiKey,
  model = DEFAULT_DETECTION_MODEL,
  askThreshold = 0.6,
  resolveThreshold = 0.8,
  fetch: send = globalThis.fetch,
  baseUrl = "https://api.openai.com/v1",
  timeoutMs = 20_000,
}: Pick<DetectorOptions, "apiKey"> & Partial<Omit<DetectorOptions, "apiKey">>): Detector {
  const key = apiKey.trim();
  if (!key) throw new Error("OpenAI API key is empty");
  const root = baseUrl.replace(/\/+$/, "");

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
        if (!response.ok) throw new DetectionError(`${endpoint} HTTP ${response.status}`);
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
      throw new DetectionError(`${endpoint} request failed`);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  return {
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
        if (request.questions.length > 400) {
          throw new DetectionError("Decisions supports at most 400 questions");
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
