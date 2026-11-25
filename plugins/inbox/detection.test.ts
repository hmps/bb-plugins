import { describe, expect, it, vi } from "vitest";
import { LIMITS, type DetectedAsk, type DetectionInput, type DetectionOpenItem } from "./contract";
import { createDetector } from "./detection";

const apiKey = "test-secret";
const baseUrl = "https://example.test/v1";
const openItem: DetectionOpenItem = {
  id: "inb_existing",
  kind: "decide",
  question: "Which region should we use?",
  recommendation: "EU",
  source: "tool",
  askCount: 1,
};
const ask: DetectedAsk = {
  kind: "decide",
  question: openItem.question,
  options: ["EU", "US"],
  recommendation: "EU",
  context: "The region controls data residency.",
  repeatOfItemId: null,
};

function predicate(name: string, probability: number) {
  return { type: "predicate", name, probability };
}

function novelty(choice: "new" | "repeat" | "covered") {
  return {
    type: "choice",
    name: "novelty",
    choice,
    confidence: 0.85,
    probabilities: ["new", "repeat", "covered"].map((value) => ({
      value,
      probability: value === choice ? 0.9 : 0.05,
    })),
  };
}

function extraction(asks: DetectedAsk[]) {
  return Response.json({
    status: "completed",
    output: [
      { type: "reasoning", summary: [] },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify({ asks }), annotations: [] }],
      },
    ],
  });
}

function setup(reply: string, openItems: DetectionOpenItem[] = [], timeoutMs?: number) {
  const input: DetectionInput = { threadId: "thr_1", reply, openItems };
  const fetch = vi.fn<typeof globalThis.fetch>();
  const { detect } = createDetector({ apiKey, baseUrl: baseUrl + "/", fetch, timeoutMs });
  return { input, fetch, detect };
}

describe("inbox detection", () => {
  it("skips extraction below the ask threshold", async () => {
    const { detect, fetch, input } = setup("The build passed.");
    fetch.mockResolvedValueOnce(Response.json({ answers: [predicate("ask", 0.59)] }));

    expect(await detect(input)).toMatchObject({
      outcome: "no-ask",
      scores: { ask: 0.59, novelty: null, resolved: {} },
      passTwoRan: false,
      asks: [],
      resolvedItemIds: [],
      error: null,
      durationMs: expect.any(Number),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [[url, request]] = fetch.mock.calls;
    expect(url).toBe(baseUrl + "/decisions");
    expect(request).toMatchObject({
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: expect.any(AbortSignal),
    });
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({
      model: "gpt-6-luna",
      questions: [{ type: "predicate", name: "ask", instructions: expect.stringContaining("approve") }],
    });
    expect(JSON.parse(body.input)).toEqual({ reply: input.reply, openItems: [] });
  });

  it("extracts a new ask at the threshold and limits its fields", async () => {
    const { detect, fetch, input } = setup("Which region should we use?");
    fetch
      .mockResolvedValueOnce(Response.json({ answers: [predicate("ask", 0.6)] }))
      .mockResolvedValueOnce(extraction([{
        ...ask,
        question: "  Which\nregion? " + "q".repeat(LIMITS.question),
        options: [" ", ...Array<string>(LIMITS.options + 1).fill("o".repeat(LIMITS.option + 1))],
        recommendation: "r".repeat(LIMITS.recommendation + 1),
        context: "c".repeat(LIMITS.context + 1),
      }]));

    const result = await detect(input);
    expect(result).toMatchObject({ outcome: "asks", passTwoRan: true, error: null });
    expect(result.asks).toEqual([{
      ...ask,
      question: ("Which region? " + "q".repeat(LIMITS.question)).slice(0, LIMITS.question),
      options: Array<string>(LIMITS.options).fill("o".repeat(LIMITS.option)),
      recommendation: "r".repeat(LIMITS.recommendation),
      context: "c".repeat(LIMITS.context),
    }]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, request] = fetch.mock.calls[1];
    expect(url).toBe(baseUrl + "/responses");
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({
      model: "gpt-6-luna",
      text: {
        format: {
          type: "json_schema",
          strict: true,
          schema: {
            additionalProperties: false,
            required: ["asks"],
            properties: {
              asks: {
                type: "array",
                items: {
                  additionalProperties: false,
                  required: ["kind", "question", "options", "recommendation", "context", "repeatOfItemId"],
                },
              },
            },
          },
        },
      },
    });
    expect(JSON.parse(body.input)).toEqual({ reply: input.reply, openItems: [] });
  });

  it.each([
    [openItem.id, openItem.id],
    ["inb_unknown", null],
  ])("validates the repeat id %s against the open items", async (repeatOfItemId, expectedId) => {
    const itemWithExtraFields = { ...openItem, context: "Private item context" };
    const { detect, fetch, input } = setup("Please pick a region.", [itemWithExtraFields]);
    fetch
      .mockResolvedValueOnce(Response.json({
        answers: [predicate(`resolved_${openItem.id}`, 0.05), predicate("ask", 0.9), novelty("repeat")],
      }))
      .mockResolvedValueOnce(extraction([{ ...ask, repeatOfItemId }]));

    expect(await detect(input)).toMatchObject({
      outcome: "asks",
      asks: [{ ...ask, repeatOfItemId: expectedId }],
      scores: { novelty: { new: 0.05, repeat: 0.9, covered: 0.05 } },
    });
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body.questions).toMatchObject([
      { type: "predicate", name: "ask" },
      { type: "choice", name: "novelty", choices: [{ value: "new" }, { value: "repeat" }, { value: "covered" }] },
      { type: "predicate", name: `resolved_${openItem.id}`, instructions: expect.stringContaining(openItem.id) },
    ]);
    expect(JSON.parse(body.input)).toEqual({ reply: input.reply, openItems: [openItem] });
    const responsesBody = JSON.parse(String(fetch.mock.calls[1][1]?.body));
    expect(responsesBody.input).toBe(body.input);
  });

  it("returns only items at or above the resolve threshold", async () => {
    const otherItem = { ...openItem, id: "inb_other" };
    const { detect, fetch, input } = setup("We chose EU.", [openItem, otherItem]);
    fetch.mockResolvedValueOnce(Response.json({
      answers: [
        predicate("ask", 0.05),
        novelty("new"),
        predicate(`resolved_${openItem.id}`, 0.8),
        predicate(`resolved_${otherItem.id}`, 0.79),
      ],
    }));

    expect(await detect(input)).toMatchObject({
      outcome: "resolved-only",
      resolvedItemIds: [openItem.id],
      scores: { resolved: { [openItem.id]: 0.8, [otherItem.id]: 0.79 } },
      passTwoRan: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("skips extraction when covered has the highest probability", async () => {
    const { detect, fetch, input } = setup("Please use the open decision card.", [openItem]);
    fetch.mockResolvedValueOnce(Response.json({
      answers: [predicate("ask", 0.9), novelty("covered"), predicate(`resolved_${openItem.id}`, 0.05)],
    }));

    expect(await detect(input)).toMatchObject({ outcome: "covered", passTwoRan: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports HTTP errors without reflecting the response body", async () => {
    const { detect, fetch, input } = setup("Which region should we use?");
    fetch.mockResolvedValueOnce(new Response(apiKey, { status: 401 }));

    const result = await detect(input);
    expect(result).toMatchObject({ outcome: "error", error: "decisions HTTP 401", passTwoRan: false });
    expect(result.error).not.toContain(apiKey);
  });

  it("reports the OpenAI error type and message of a failed decisions request", async () => {
    const { detect, fetch, input } = setup("Which region should we use?");
    fetch.mockResolvedValueOnce(Response.json({
      error: {
        type: "invalid_request_error",
        code: "model_not_found",
        message: `The model does not exist. Key ${apiKey} was used.`,
      },
    }, { status: 404 }));

    const result = await detect(input);
    expect(result).toMatchObject({
      outcome: "error",
      error: "decisions HTTP 404: invalid_request_error/model_not_found: The model does not exist. Key *** was used.",
    });
    expect(result.error).not.toContain(apiKey);
    expect(result.error).not.toContain("questions");
  });

  it("reports the cause of a decisions request that fails before a response", async () => {
    const { detect, fetch, input } = setup("Which region should we use?");
    const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    fetch.mockRejectedValueOnce(new TypeError("fetch failed", { cause }));

    const result = await detect(input);
    expect(result).toMatchObject({
      outcome: "error",
      error: "decisions request failed: TypeError: fetch failed <- Error: read ECONNRESET (ECONNRESET)",
    });
  });

  it("returns a timeout even when fetch ignores the abort signal", async () => {
    const { detect, fetch, input } = setup("Please choose.", [], 10);
    fetch.mockImplementation(() => new Promise(() => {}));

    const result = await detect(input);
    expect(result).toMatchObject({ outcome: "error", error: "decisions timed out" });
    expect(result.error).not.toContain(apiKey);
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("combines the caller signal with the timeout and hides the abort reason", async () => {
    const { detect, fetch, input } = setup("Which region should we use?");
    fetch.mockImplementation(() => new Promise(() => {}));
    const caller = new AbortController();
    const pending = detect(input, caller.signal);
    caller.abort(apiKey);

    expect(await pending).toMatchObject({ outcome: "error", error: "decisions cancelled" });
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("reports malformed extraction JSON and marks pass two as run", async () => {
    const { detect, fetch, input } = setup("Which region should we use?");
    fetch
      .mockResolvedValueOnce(Response.json({ answers: [predicate("ask", 0.9)] }))
      .mockResolvedValueOnce(new Response(apiKey));

    expect(await detect(input)).toMatchObject({
      outcome: "error",
      error: "responses returned invalid JSON",
      passTwoRan: true,
      scores: { ask: 0.9 },
    });
  });

  it("rejects extracted asks that do not match the schema", async () => {
    const { detect, fetch, input } = setup("Which region should we use?");
    fetch
      .mockResolvedValueOnce(Response.json({ answers: [predicate("ask", 0.9)] }))
      .mockResolvedValueOnce(extraction([{ ...ask, question: " " }]));

    expect(await detect(input)).toMatchObject({
      outcome: "error",
      error: "Invalid Responses output",
      passTwoRan: true,
      asks: [],
    });
  });

  it("rejects a blank key before detection", () => {
    expect(() => createDetector({ apiKey: " " })).toThrow("OpenAI API key is empty");
  });
});
