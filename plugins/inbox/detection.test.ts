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
  // A word of every test reply that asks, so the excerpt check keeps it.
  excerpt: "region",
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
  it("drops a SITREP reminder even when the referenced cards are in another thread", async () => {
    const reminder = "the Growth Stripe price fix (inbox) and the card for Swedish letters (å, ä, ö) in LinkedIn URLs.";
    const { detect, fetch, input } = setup(`**Blocked on you:** ${reminder}`);
    fetch
      .mockResolvedValueOnce(Response.json({ answers: [predicate("ask", 0.9)] }))
      .mockResolvedValueOnce(extraction([{
        ...ask,
        kind: "do",
        question: "Can you handle the card about Swedish letters (å, ä, ö) in LinkedIn URLs?",
        context: "The reply says this card is blocked on you.",
        options: null,
        recommendation: null,
        excerpt: "the card for Swedish letters (å, ä, ö) in LinkedIn URLs.",
      }]));

    expect(await detect(input)).toMatchObject({ outcome: "no-ask", asks: [] });
  });

  it("keeps a new decision next to an existing-card reminder", async () => {
    const reminder = "Blocked on you: the rollout decision card.";
    const decision = "Which region should we use for the new search index?";
    const { detect, fetch, input } = setup(reminder + "\n\n" + decision);
    fetch
      .mockResolvedValueOnce(Response.json({ answers: [predicate("ask", 0.9)] }))
      .mockResolvedValueOnce(extraction([
        { ...ask, question: "Can you handle the rollout card?", excerpt: "the rollout decision card." },
        { ...ask, question: decision, excerpt: decision },
      ]));

    expect((await detect(input)).asks.map(({ question }) => question)).toEqual([decision]);
  });

  it.each(["## Blocked on you", "**Blocked on you**"])("skips reminder bullets under %s", async (heading) => {
    const reminder = "The card for Swedish letters (å, ä, ö) in LinkedIn URLs.";
    const decision = "Which region should we use for the new search index?";
    const action = "Review the card layout for the inbox redesign.";
    const { detect, fetch, input } = setup([
      "Done.",
      heading,
      ["- The Growth Stripe price fix (inbox).", "- " + reminder, "- " + decision, "- " + action].join("\n"),
      "## Changed\n\n- Fixed X.",
    ].join("\n\n"));
    fetch
      .mockResolvedValueOnce(Response.json({ answers: [predicate("ask", 0.9)] }))
      .mockResolvedValueOnce(extraction([
        { ...ask, kind: "do", question: "Can you handle the Swedish letters card?", excerpt: reminder },
        { ...ask, question: decision, excerpt: decision },
        { ...ask, kind: "do", question: action, context: "Check the new inbox card layout.", excerpt: action },
      ]));

    expect((await detect(input)).asks.map(({ question }) => question)).toEqual([decision, action]);
  });

  it.each(["numbered", "bulleted"])("keeps a %s iPhone test checklist in one item", async (format) => {
    const steps = [
      "Connect your iPhone to Silicon Knight with a cable, or use the same Wi-Fi.",
      "In Xcode, pick your **iPhone** as the run destination at the top of the window, not a simulator.",
      "Press Run (⌘R). If Xcode asks, select your team for the app and for the 4 extensions.",
      "On the iPhone, open **Settings → General → VPN & Device Management** and trust your developer profile, if iOS asks.",
      "Make sure the App ID has **Sign in with Apple** and **Push Notifications**.",
    ].map((step, index) => `${format === "numbered" ? `${index + 1}.` : "-"} ${step}`);
    const intro = "To finish the inbox task:";
    const report = "When Teed opens on the phone, tell me. If Xcode shows a signing or entitlement error, paste the text here.";
    const checklist = `${intro}\n\n${steps.join(format === "numbered" ? "\n" : "\n\n")}\n\n${report}`;
    const { detect, fetch, input } = setup(
      "Yes, Teed runs, and the welcome screen looks right. But this is the **Simulator** " +
      '(the Mac window with "iOS 27.0" at the top), not your iPhone. The simulator needs no signing, ' +
      "so it does not create the profiles that I need to install on your phone.\n\n" + checklist,
    );
    fetch
      .mockResolvedValueOnce(Response.json({ answers: [predicate("ask", 0.9)] }))
      .mockResolvedValueOnce(extraction([...steps, report].map((step) => ({
        ...ask,
        kind: "do",
        question: step,
        context: null,
        options: null,
        recommendation: null,
        excerpt: step,
      }))));

    const result = await detect(input);
    expect(result.outcome).toBe("asks");
    expect(result.asks).toHaveLength(1);
    expect(result.asks[0].context).toBe(checklist);
  });

  const doAsk = (excerpt: string): DetectedAsk => ({
    ...ask,
    kind: "do",
    question: excerpt,
    options: null,
    recommendation: null,
    context: "A task for the user.",
    excerpt,
  });

  it.each([
    ["A Crew investigates the missing Fia email now.", "While you wait, check your spam folder for a Fia email."],
    ["I restarted the worker.", "If you want, you can clear the browser cache too."],
    ["The fix is on main.", "You may want to reload the page to see it."],
    ["The deploy runs.", "In the meantime, you could read the release notes."],
    ["The build is installed on Ethereal-Titan.", "Try opening the inbox and pressing j to move down."],
    ["A Crew investigates the missing Fia email.", "While you wait, open mail.example.com and check your spam folder."],
    ["No approval is required.", "Try opening the inbox."],
  ])("makes no item for an optional tip: %s %s", async (status, tip) => {
    const { detect, fetch, input } = setup(`${status} ${tip}`);
    fetch
      .mockResolvedValueOnce(Response.json({ answers: [predicate("ask", 0.9)] }))
      .mockResolvedValueOnce(extraction([doAsk(tip.replace(/^.*?, /, ""))]));

    expect(await detect(input)).toMatchObject({ outcome: "no-ask", asks: [] });
  });

  it.each([
    ["The Stripe key expired.", "I need you to paste the new key in the plugin settings."],
    ["The banner says “Try refreshing the page.”", "Which region should we use for the backup, EU or US?"],
    ["The PR is ready.", "If you want it live today, approve the deploy of inbox 0.1.9."],
    ["I am waiting for your test result before I can ship.", "Please try signing in on your iPhone."],
    ["The import is paused.", "Meanwhile, you will need to renew your session before I can finish it."],
  ])("keeps a real ask: %s %s", async (status, request) => {
    const { detect, fetch, input } = setup(`${status} ${request}`);
    fetch
      .mockResolvedValueOnce(Response.json({ answers: [predicate("ask", 0.9)] }))
      .mockResolvedValueOnce(extraction([doAsk(request)]));

    expect((await detect(input)).asks.map(({ question }) => question)).toEqual([request]);
  });

  it.each([
    ["makes no item for", "", 0],
    ["keeps one item for", "\n\nWhen you have tried them, tell me what you see.", 1],
    ["keeps one item for", "\n\nPlease tell me what appears.", 1],
  ])("%s a Try these: list after an install", async (_, report, count) => {
    const steps = ["- Open the inbox.", "- Press j to move down.", "- Press Enter to open an item."];
    const { detect, fetch, input } = setup(`Inbox 0.1.9 is installed. Try these:\n\n${steps.join("\n")}${report}`);
    fetch
      .mockResolvedValueOnce(Response.json({ answers: [predicate("ask", 0.9)] }))
      .mockResolvedValueOnce(extraction(steps.map((step) => doAsk(step.slice(2)))));

    const { asks } = await detect(input);
    expect(asks).toHaveLength(count);
    if (report) expect(asks[0].context).toContain(report.trim());
  });

  it("drops a new ask when extraction cannot supply context", async () => {
    const { detect, fetch, input } = setup("Can you handle this?");
    fetch
      .mockResolvedValueOnce(Response.json({ answers: [predicate("ask", 0.9)] }))
      .mockResolvedValueOnce(extraction([{
        ...ask,
        question: input.reply,
        context: null,
        excerpt: input.reply,
      }]));

    expect(await detect(input)).toMatchObject({ outcome: "no-ask", asks: [] });
  });

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
                  required: ["kind", "question", "options", "recommendation", "context", "excerpt", "repeatOfItemId"],
                },
              },
            },
          },
        },
      },
    });
    expect(JSON.parse(body.input)).toEqual({ reply: input.reply, openItems: [] });
  });

  it("asks for asks that stand alone, without references to the thread", async () => {
    const { detect, fetch, input } = setup("Which region should we use?");
    fetch
      .mockResolvedValueOnce(Response.json({ answers: [predicate("ask", 0.9)] }))
      .mockResolvedValueOnce(extraction([ask]));

    await detect(input);
    const { instructions } = JSON.parse(String(fetch.mock.calls[1][1]?.body));
    expect(instructions).toContain("has not read the reply");
    expect(instructions).toContain("Resolve every reference");
    expect(instructions).toContain("\"option 1\"");
    expect(instructions).toContain("the full text of each choice");
    expect(instructions).toContain("what each option does");
    expect(instructions).toContain("copied word for word");
    expect(instructions).not.toContain("keep context short");
  });

  it("stores the quoted passage, bounded, and falls back to the end of the reply", async () => {
    const options = [
      "Option 1: rebuild the search index with Redis.",
      "Option 2: keep Postgres full-text search and add a trigram index.",
    ];
    const reply = "x".repeat(3000) + "\n\n1. " + options[0] + "\n2. " + options[1] +
      "\n\nShould I build option 1 or option 2?";
    const { detect, fetch, input } = setup(reply);
    const standalone: DetectedAsk = {
      kind: "decide",
      question: "Rebuild search with Redis, or keep Postgres full-text search with a trigram index?",
      options: ["Rebuild the search index with Redis", "Keep Postgres full-text search and add a trigram index"],
      recommendation: null,
      context: "- Redis: a new service.\n- Postgres: no new service.\n- On yes, the agent builds it.",
      // The model reflows whitespace; the check ignores it.
      excerpt: "1. " + options[0] + "  2. " + options[1] + "\nShould I build option 1 or option 2?",
      repeatOfItemId: null,
    };
    fetch
      .mockResolvedValueOnce(Response.json({ answers: [predicate("ask", 0.9)] }))
      .mockResolvedValueOnce(extraction([
        standalone,
        { ...standalone, question: "Invented?", excerpt: "Text the agent never wrote." },
        { ...standalone, question: "Long?", excerpt: "x".repeat(LIMITS.excerpt + 500) },
      ]));

    const { asks } = await detect(input);
    // Cut from the reply itself, with the agent's own line breaks.
    expect(asks[0]).toEqual({
      ...standalone,
      excerpt: "1. " + options[0] + "\n2. " + options[1] + "\n\nShould I build option 1 or option 2?",
    });
    expect(asks[1].excerpt).toHaveLength(LIMITS.excerpt);
    expect(asks[1].excerpt?.startsWith("…")).toBe(true);
    expect(asks[1].excerpt?.endsWith("Should I build option 1 or option 2?")).toBe(true);
    // A long match keeps its end, where the ask is.
    expect(asks[2].excerpt).toHaveLength(LIMITS.excerpt);
    expect(asks[2].excerpt?.startsWith("…x")).toBe(true);
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

  it("redacts the key before it clips a long OpenAI error message", async () => {
    const { detect, fetch, input } = setup("Which region should we use?");
    fetch.mockResolvedValueOnce(Response.json({
      error: { type: "invalid_request_error", message: `${"x".repeat(270)} ${apiKey}` },
    }, { status: 401 }));

    const result = await detect(input);
    expect(result.error).not.toContain("test-sec");
    expect(result.error).toContain("***");
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
