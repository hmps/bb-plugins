// Inline Lucide glyphs (ISC license) for the shapes bb's host icon set does
// not promise to have. Each one draws at the size of its className, in
// currentColor, with Lucide's 2px stroke.
import type { ReactNode } from "react";

function Glyph({
  className,
  strokeWidth = 2,
  children,
  name,
}: {
  className?: string;
  strokeWidth?: number;
  children: ReactNode;
  name: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      data-inbox-icon={name}
    >
      {children}
    </svg>
  );
}

type GlyphProps = { className?: string; strokeWidth?: number };

/** Lucide `inbox`: the tray. Also the rail icon. */
export function TrayGlyph(props: GlyphProps) {
  return (
    <Glyph name="tray" {...props}>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </Glyph>
  );
}

/** Lucide `check`. */
export function CheckGlyph(props: GlyphProps) {
  return (
    <Glyph name="check" {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Glyph>
  );
}

/** Lucide `split`: a choice between ways. */
export function SplitGlyph(props: GlyphProps) {
  return (
    <Glyph name="split" {...props}>
      <path d="M16 3h5v5" />
      <path d="M8 3H3v5" />
      <path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3" />
      <path d="m15 9 6-6" />
    </Glyph>
  );
}

/** Lucide `badge-check`: a yes or no. */
export function ApproveGlyph(props: GlyphProps) {
  return (
    <Glyph name="approve" {...props}>
      <path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" />
      <path d="m9 12 2 2 4-4" />
    </Glyph>
  );
}

/** Lucide `hand`: a task for the user's own hands. */
export function HandGlyph(props: GlyphProps) {
  return (
    <Glyph name="hand" {...props}>
      <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
      <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
      <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </Glyph>
  );
}

/** Lucide `thumbs-up`: the recommended answer. */
export function ThumbGlyph(props: GlyphProps) {
  return (
    <Glyph name="thumb" {...props}>
      <path d="M7 10v12" />
      <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
    </Glyph>
  );
}

/** Lucide `circle-check`: settled. */
export function CircleCheckGlyph(props: GlyphProps) {
  return (
    <Glyph name="circle-check" {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </Glyph>
  );
}
