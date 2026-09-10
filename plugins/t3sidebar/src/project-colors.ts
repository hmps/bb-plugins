/**
 * Project colours: a small fixed palette, one colour per project.
 *
 * A fixed palette rather than a free colour picker, because the badge has to
 * stay legible on both themes. Each entry names the two classes it needs — a
 * tinted track and a text colour that holds contrast in light and dark — so
 * the sidebar never computes a colour at runtime.
 */

export const PROJECT_COLOR_CHANNEL = "project-colors";

export interface ProjectColor {
  id: string;
  label: string;
  /** Badge track and text, applied together. */
  badgeClass: string;
  /** Solid fill for the picker's swatch. */
  swatchClass: string;
}

/** Stored value for a project with no colour of its own. */
export const NEUTRAL_COLOR_ID = "neutral";

export const PROJECT_COLORS: readonly ProjectColor[] = [
  {
    id: NEUTRAL_COLOR_ID,
    label: "None",
    badgeClass: "bg-muted text-muted-foreground",
    swatchClass: "bg-muted-foreground/40",
  },
  {
    id: "blue",
    label: "Blue",
    badgeClass: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
    swatchClass: "bg-blue-500",
  },
  {
    id: "violet",
    label: "Violet",
    badgeClass: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    swatchClass: "bg-violet-500",
  },
  {
    id: "pink",
    label: "Pink",
    badgeClass: "bg-pink-500/15 text-pink-700 dark:text-pink-300",
    swatchClass: "bg-pink-500",
  },
  {
    id: "red",
    label: "Red",
    badgeClass: "bg-red-500/15 text-red-700 dark:text-red-300",
    swatchClass: "bg-red-500",
  },
  {
    id: "amber",
    label: "Amber",
    badgeClass: "bg-amber-500/20 text-amber-700 dark:text-amber-300",
    swatchClass: "bg-amber-500",
  },
  {
    id: "emerald",
    label: "Emerald",
    badgeClass: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    swatchClass: "bg-emerald-500",
  },
  {
    id: "cyan",
    label: "Cyan",
    badgeClass: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
    swatchClass: "bg-cyan-500",
  },
];

const BY_ID = new Map(PROJECT_COLORS.map((color) => [color.id, color]));

/** Every id the store accepts; anything else falls back to neutral. */
export const PROJECT_COLOR_IDS: readonly string[] = PROJECT_COLORS.map(
  (color) => color.id,
);

export function isProjectColorId(value: string): boolean {
  return BY_ID.has(value);
}

/**
 * The colour to draw with. An unknown or missing id reads as neutral, so a
 * palette entry can be retired without leaving a project unpainted.
 */
export function projectColor(colorId: string | null | undefined): ProjectColor {
  if (colorId == null) return BY_ID.get(NEUTRAL_COLOR_ID)!;
  return BY_ID.get(colorId) ?? BY_ID.get(NEUTRAL_COLOR_ID)!;
}

/** Realtime payload: one project's colour changed. */
export interface ProjectColorSignal {
  projectId: string;
  colorId: string | null;
}
