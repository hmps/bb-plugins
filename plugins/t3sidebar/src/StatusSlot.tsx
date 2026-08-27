import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { StatusGlyph, hasStatusGlyph } from "./StatusGlyph";
import { relativeTimeLabel } from "./relative-time";

/**
 * The row's trailing slot: one fixed width, right-aligned, on every row.
 *
 * Fixed rather than intrinsic because the age label's width follows its text —
 * "now" is wider than "7m" — and an intrinsic slot drags whatever sits beside
 * it back and forth, so no two rows agree on a column. The width holds the
 * widest label this sidebar can produce ("now", "59m", "52w").
 */
export const STATUS_SLOT_CLASS = "flex w-7 shrink-0 items-center justify-end";

/**
 * The box every trailing glyph sits in, whatever its artwork measures.
 *
 * The status glyph, the provider glyph and a shelf's chevron all end a line at
 * the same inset, but they are drawn at different sizes. A shared box centres
 * each one on the same vertical axis, so right-aligning the boxes lines the
 * icons up instead of leaving them one or two pixels apart.
 */
export const TRAILING_GLYPH_BOX_CLASS =
  "flex size-3.5 shrink-0 items-center justify-center";

/**
 * Status OR age, never both: the glyph already implies the row is current, and
 * the age only earns its place once the thread has nothing to say.
 *
 * A thread with nothing of its own to say borrows its children's state. The
 * flat list hides those children, so this slot is where their work surfaces —
 * otherwise a parent that only waits on a child reads as idle. The thread's
 * own indicator always wins: it is the row the user clicked on.
 */
export function StatusOrTime({
  thread,
  now,
  workingChildren = 0,
  childrenNeedYou = 0,
}: {
  thread: PluginSidebarThread;
  /** Quantized clock, shared by every row in one render. */
  now: number;
  /** Descendants doing live work; zero borrows nothing. */
  workingChildren?: number;
  /** Descendants with a raised hand; outranks their work. */
  childrenNeedYou?: number;
}) {
  if (hasStatusGlyph(thread.indicator)) {
    return (
      <StatusGlyph indicator={thread.indicator} label={thread.indicatorLabel} />
    );
  }
  if (childrenNeedYou > 0) {
    return (
      <StatusGlyph
        indicator="waiting-for-input"
        label="Child thread needs input"
      />
    );
  }
  if (workingChildren > 0) {
    return <StatusGlyph indicator="runtime" label="Child thread working" />;
  }
  return (
    <span className="tabular-nums text-2xs text-muted-foreground">
      {relativeTimeLabel(thread.updatedAt, now)}
    </span>
  );
}
