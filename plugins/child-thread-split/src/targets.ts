// Finds the host-rendered places that get an "Open in split" button. Each
// selector follows the DOM that bb 0.44 renders; see the README for the
// contracts and what breaks them.

/** Marks the span this plugin inserts next to a host element. */
export const HOST_ATTRIBUTE = "data-child-thread-split";

/** The collapsible body of the "child threads" banner above the composer. */
export const COMPOSER_CHILDREN_BODY_ID = "thread-prompt-banner-child-threads-body";

/** The wrapper that ExpandablePanel puts around a timeline row header. */
const TIMELINE_ROW_SELECTOR = '[class~="group/timeline-row"]';

/** A thread mention pill (PromptMentionPill). */
const THREAD_PILL_SELECTOR =
  '[data-prompt-mention="true"][data-prompt-mention-serialized-text^="@thread:"]';

/**
 * The one-line collapsed preview of a generated message (mU in bb 0.44). The
 * expanded body uses `pl-2 text-sm …` without `flex`, so it does not match.
 */
const PREVIEW_LINE_SELECTOR =
  'div[class~="flex"][class~="min-w-0"][class~="items-baseline"][class~="truncate"]';

/** The measured text box inside the preview line. */
const PREVIEW_TEXT_SELECTOR = 'div[class~="min-w-0"][class~="truncate"]';

/** Ancestors from the preview line up to the panel: 5 in bb 0.44, plus slack. */
const MAX_PREVIEW_DEPTH = 6;

const PANE_SELECTOR = "[data-split-pane-id]";

/** Attributes whose changes can add, remove, or change a target. */
export const OBSERVED_ATTRIBUTES = [
  "aria-hidden",
  "href",
  "title",
  "data-prompt-mention-resource",
  "data-prompt-mention-serialized-text",
  "data-split-pane-id",
];

export type SplitTargetKind = "composer" | "message";

export interface SplitTarget {
  kind: SplitTargetKind;
  /**
   * The host element the button belongs to: the row link for a composer row,
   * the `group/timeline-row` wrapper for a message header.
   */
  anchor: HTMLElement;
  threadId: string;
  title: string;
  /** Split pane ids around the target, closest first. */
  paneIds: string[];
  /** The target is inside an aria-hidden region, such as a collapsed banner. */
  hidden: boolean;
}

export function findSplitTargets(root: ParentNode): SplitTarget[] {
  return [...findComposerTargets(root), ...findMessageTargets(root)];
}

/**
 * Composer banner rows:
 * `section#thread-prompt-banner-child-threads-body > div > ul > li > a[href]`.
 * The host lists only active, non-fork children of the thread here.
 */
function findComposerTargets(root: ParentNode): SplitTarget[] {
  const targets: SplitTarget[] = [];
  // Every open pane renders its own banner, so the id is not unique.
  const bodies = root.querySelectorAll(`[id="${COMPOSER_CHILDREN_BODY_ID}"]`);
  for (const body of bodies) {
    for (const anchor of body.querySelectorAll<HTMLAnchorElement>("ul > li > a[href]")) {
      const threadId = threadIdFromHref(anchor.getAttribute("href") ?? "");
      if (threadId === null) {
        continue;
      }
      targets.push({
        kind: "composer",
        anchor,
        threadId,
        title: composerRowTitle(anchor) ?? threadId,
        paneIds: paneIdsAround(anchor),
        hidden: isHidden(anchor),
      });
    }
  }
  return targets;
}

/**
 * Generated messages. Both kinds put the button in the panel's
 * `group/timeline-row` header, outside every host link and toggle:
 *
 * - Agent messages: the pill inside GeneratedAgentSourceTitle,
 *   `<span title="Message from …"><span>Message from</span> <pill/></span>`.
 * - Child reports (BB system messages such as child-completed): the pill that
 *   starts the collapsed preview line under the header.
 *
 * Other pills in message bodies are not matched. Whether the thread is a child
 * is decided later, from thread data.
 */
function findMessageTargets(root: ParentNode): SplitTarget[] {
  const pills = new Map<HTMLElement, HTMLElement>();
  for (const row of root.querySelectorAll<HTMLElement>(TIMELINE_ROW_SELECTOR)) {
    const header = rowHeader(row);
    const pill = header
      ? [...header.querySelectorAll<HTMLElement>(THREAD_PILL_SELECTOR)].find(isSourceTitlePill)
      : undefined;
    if (pill !== undefined) {
      pills.set(row, pill);
    }
  }
  for (const line of root.querySelectorAll<HTMLElement>(PREVIEW_LINE_SELECTOR)) {
    const pill = leadingPreviewPill(line);
    const row = pill ? previewHeaderRow(line) : null;
    if (pill && row && !pills.has(row)) {
      pills.set(row, pill);
    }
  }

  const targets: SplitTarget[] = [];
  for (const [row, pill] of pills) {
    const mention = readThreadMention(pill);
    if (mention === null) {
      continue;
    }
    targets.push({
      kind: "message",
      anchor: row,
      threadId: mention.threadId,
      title: mention.label ?? mention.threadId,
      paneIds: paneIdsAround(row),
      hidden: isHidden(row),
    });
  }
  return targets;
}

/**
 * The thread pill that starts a collapsed preview line:
 * `line > div.min-w-0.truncate > div[data-markdown-preview] > p > pill`, with
 * no text before the pill. The child report text starts with the child
 * mention ("@thread:… completed: …").
 */
function leadingPreviewPill(line: HTMLElement): HTMLElement | null {
  const text = line.firstElementChild;
  if (text === null || !text.matches(PREVIEW_TEXT_SELECTOR)) {
    return null;
  }
  const markdown = text.firstElementChild;
  const paragraph = markdown?.matches("[data-markdown-preview]") ? markdown.firstElementChild : null;
  if (paragraph?.tagName !== "P") {
    return null;
  }
  for (const node of paragraph.childNodes) {
    if (node instanceof HTMLElement) {
      return node.matches(THREAD_PILL_SELECTOR) ? node : null;
    }
    if (node.textContent?.trim()) {
      return null;
    }
  }
  return null;
}

/**
 * The header row of the panel that shows a collapsed preview. ExpandablePanel
 * renders `panel > [group/timeline-row, div > div > previewWrapper > div > line]`,
 * so the panel is the closest ancestor whose first child is the row.
 */
function previewHeaderRow(line: HTMLElement): HTMLElement | null {
  let element = line.parentElement;
  for (let depth = 0; element !== null && depth < MAX_PREVIEW_DEPTH; depth++) {
    const first = element.firstElementChild;
    if (first instanceof HTMLElement && first.matches(TIMELINE_ROW_SELECTOR)) {
      return first.contains(line) ? null : first;
    }
    element = element.parentElement;
  }
  return null;
}

/**
 * The pill sits directly in GeneratedAgentSourceTitle's `span[title]`, after
 * the lead-in span. The pill has its own `title`, so `closest` is not enough.
 */
function isSourceTitlePill(pill: HTMLElement): boolean {
  const sourceTitle = pill.parentElement;
  return (
    sourceTitle !== null &&
    sourceTitle.matches("span[title]") &&
    pill.previousElementSibling?.tagName === "SPAN"
  );
}

/** The header that CollapsibleHeader renders: the row's first host child. */
export function rowHeader(row: HTMLElement): HTMLElement | null {
  for (const child of row.children) {
    if (child instanceof HTMLElement && !child.hasAttribute(HOST_ATTRIBUTE)) {
      return child;
    }
  }
  return null;
}

/** Reads `<id>` from the last `/threads/<id>` segment of a thread route. */
export function threadIdFromHref(href: string): string | null {
  const matches = [...href.matchAll(/\/threads\/([^/?#]+)/g)];
  const last = matches.at(-1)?.[1];
  if (last === undefined) {
    return null;
  }
  try {
    return decodeURIComponent(last);
  } catch {
    return null;
  }
}

function composerRowTitle(anchor: HTMLElement): string | null {
  const titled = anchor.getAttribute("title");
  if (titled) {
    return titled;
  }
  const titleElement = anchor.querySelector(".bb-thread-title");
  const candidates = [
    titleElement?.getAttribute("title"),
    titleElement?.textContent,
    anchor.textContent,
  ];
  for (const candidate of candidates) {
    const text = candidate?.trim();
    if (text) {
      return text;
    }
  }
  return null;
}

function readThreadMention(pill: HTMLElement): { threadId: string; label: string | null } | null {
  let threadId: string | null = null;
  let label: string | null = null;
  const resource = pill.getAttribute("data-prompt-mention-resource");
  if (resource !== null) {
    try {
      const parsed: unknown = JSON.parse(resource);
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        if (record.kind === "thread" && typeof record.threadId === "string") {
          threadId = record.threadId;
        }
        if (typeof record.label === "string" && record.label.trim() !== "") {
          label = record.label.trim();
        }
      }
    } catch {
      // Fall back to the serialized text below.
    }
  }
  if (threadId === null) {
    const serialized = pill.getAttribute("data-prompt-mention-serialized-text") ?? "";
    const id = serialized.slice("@thread:".length).trim();
    threadId = id === "" ? null : id;
  }
  if (threadId === null) {
    return null;
  }
  return { threadId, label: label ?? (pill.textContent?.trim() || null) };
}

function paneIdsAround(element: Element): string[] {
  const ids: string[] = [];
  let pane = element.closest(PANE_SELECTOR);
  while (pane !== null) {
    const id = pane.getAttribute("data-split-pane-id");
    if (id) {
      ids.push(id);
    }
    pane = pane.parentElement?.closest(PANE_SELECTOR) ?? null;
  }
  return ids;
}

function isHidden(element: Element): boolean {
  return element.closest('[aria-hidden="true"]') !== null;
}
