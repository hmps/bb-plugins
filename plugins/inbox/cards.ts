// bb-plugin-inbox card mirror helpers: parse a decisions-plugin card, turn
// it into item fields, and build the value that answers it. Pure functions.
import { z } from "zod";
import {
  DECISIONS_PLUGIN_ID,
  DECISIONS_RENDERER_ID,
  type Card,
  type CardAnswer,
  type CardResponse,
} from "./contract";

/**
 * Lenient: the decisions plugin owns this shape, so missing optional parts
 * get defaults instead of failing the whole card.
 */
const lenientCardDataSchema = z.object({
  headline: z.string().catch(""),
  decisions: z
    .array(
      z.object({
        question: z.string(),
        context: z.string().catch(""),
        options: z
          .array(z.object({ label: z.string(), does: z.string().catch("") }))
          .catch([]),
        suggested: z.number().int().nonnegative().nullable().catch(null),
        links: z
          .array(z.object({ label: z.string(), href: z.string() }))
          .catch([]),
      }),
    )
    .min(1),
});

/** The parts of a pending interaction the mirror reads. */
export interface InteractionLike {
  id: string;
  threadId: string;
  status: string;
  origin: { kind: string; pluginId?: string; rendererId?: string };
  payload: { kind: string; data?: unknown; title?: string };
  resolution?: { description?: { detail?: string; title?: string } } | null;
}

export function isDecisionCard(interaction: InteractionLike): boolean {
  return (
    interaction.origin.kind === "plugin" &&
    interaction.origin.pluginId === DECISIONS_PLUGIN_ID &&
    interaction.origin.rendererId === DECISIONS_RENDERER_ID
  );
}

/** Parses a card, or returns null when the payload does not fit. */
export function parseCard(interaction: InteractionLike): Card | null {
  const parsed = lenientCardDataSchema.safeParse(interaction.payload.data);
  if (!parsed.success) return null;
  const decisions = parsed.data.decisions.map((decision) => ({
    ...decision,
    // A suggestion that points past the options is no suggestion.
    suggested:
      decision.suggested !== null && decision.suggested < decision.options.length
        ? decision.suggested
        : null,
  }));
  const headline =
    parsed.data.headline.trim() ||
    interaction.payload.title?.trim() ||
    decisions[0]!.question;
  return { interactionId: interaction.id, headline, decisions };
}

/** The item fields a card maps to. */
export function cardFields(card: Card): {
  question: string;
  context: string | null;
  options: string[] | null;
  recommendation: string | null;
} {
  const single = card.decisions.length === 1 ? card.decisions[0]! : null;
  const sections = card.decisions.map((decision, index) => {
    const parts: string[] = [];
    if (!single) parts.push(`**${index + 1}. ${decision.question}**`);
    if (decision.context.trim()) parts.push(decision.context.trim());
    if (decision.links.length > 0) {
      parts.push(decision.links.map((link) => `- [${link.label}](${link.href})`).join("\n"));
    }
    return parts.join("\n\n");
  });
  const context = sections.filter((section) => section !== "").join("\n\n");

  let recommendation: string | null = null;
  if (single) {
    recommendation =
      single.suggested === null ? null : (single.options[single.suggested]?.label ?? null);
  } else if (card.decisions.every((decision) => decision.suggested !== null)) {
    recommendation = card.decisions
      .map((decision, index) => `Q${index + 1}: ${decision.options[decision.suggested!]!.label}`)
      .join("; ");
  }

  return {
    question: single ? single.question : card.headline,
    context: context === "" ? null : context,
    options: single ? single.options.map((option) => option.label) : null,
    recommendation,
  };
}

/**
 * Builds the value that answers a card. Throws a readable error when the
 * input does not fit the card.
 */
export function buildCardResponse(
  card: Card,
  input: { answers?: CardAnswer[]; text?: string; acceptRecommendation?: boolean },
): CardResponse {
  if (input.answers) {
    if (input.answers.length !== card.decisions.length) {
      throw new Error(
        `this card has ${card.decisions.length} decision(s); got ${input.answers.length} answer(s)`,
      );
    }
    input.answers.forEach((answer, index) => {
      if ("option" in answer && answer.option >= card.decisions[index]!.options.length) {
        throw new Error(`decision ${index + 1} has no option ${answer.option}`);
      }
    });
    return { answers: input.answers };
  }
  if (input.acceptRecommendation) {
    return {
      answers: card.decisions.map((decision, index) => {
        if (decision.suggested === null) {
          throw new Error(`decision ${index + 1} has no recommendation`);
        }
        return { option: decision.suggested };
      }),
    };
  }
  if (input.text !== undefined) {
    if (card.decisions.length !== 1) {
      throw new Error("a text answer fits only a card with one decision; send answers");
    }
    return { answers: [{ text: input.text }] };
  }
  throw new Error("give answers, text, or acceptRecommendation");
}

/** "Decision 1 — <question>: <label or text>", one line per decision. */
export function describeCardResponse(card: Card, response: CardResponse): string {
  return response.answers
    .map((answer, index) => {
      const decision = card.decisions[index]!;
      const value =
        "option" in answer
          ? (decision.options[answer.option]?.label ?? `option ${answer.option}`)
          : answer.text;
      return `Decision ${index + 1} — ${decision.question}: ${value}`;
    })
    .join("\n");
}
