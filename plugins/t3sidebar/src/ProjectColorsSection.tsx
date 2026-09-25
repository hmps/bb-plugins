import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { ProjectColorRow, t3sidebarRpcContract } from "./server";
import { cn } from "./lib/utils";
import {
  MAX_PROJECT_LABEL_LENGTH,
  PROJECT_COLORS,
  projectColor,
} from "./project-colors";

/**
 * The badge editor: every project bb knows about, each with a label field
 * and one row of colour swatches.
 *
 * A click on a swatch saves at once, and a label saves when the field loses
 * focus or on Enter — nothing to confirm — so the section has no Save button.
 */
export function ProjectColorsSection() {
  const rpc = useRpc<typeof t3sidebarRpcContract>();
  const [rows, setRows] = useState<ProjectColorRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await rpc.call("listProjectColors", {});
      setRows(result.projects);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  async function choose(projectId: string, colorId: string) {
    const previous = rows;
    // Paint first: the sidebar updates over realtime the moment the write
    // lands, and a swatch that waits for the round trip feels broken.
    setRows(
      (current) =>
        current?.map((row) =>
          row.projectId === projectId ? { ...row, colorId } : row,
        ) ?? current,
    );
    try {
      await rpc.call("setProjectColor", { projectId, colorId });
    } catch (cause) {
      setRows(previous);
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function rename(projectId: string, input: string) {
    const label = input.trim();
    const previous = rows;
    const current = previous?.find((row) => row.projectId === projectId);
    if (!current || (current.label ?? "") === label) return;
    setRows(
      (list) =>
        list?.map((row) =>
          row.projectId === projectId
            ? { ...row, label: label === "" ? null : label }
            : row,
        ) ?? list,
    );
    try {
      await rpc.call("setProjectLabel", { projectId, label });
    } catch (cause) {
      setRows(previous);
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (error) {
    return (
      <p className="text-sm text-destructive">Could not load projects: {error}</p>
    );
  }

  if (!rows) {
    return <p className="text-sm text-muted-foreground">Loading projects…</p>;
  }

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No projects yet.</p>;
  }

  return (
    <div className="flex flex-col divide-y divide-border rounded-md border border-border">
      {rows.map((row) => (
        <div
          key={row.projectId}
          className="flex items-center gap-3 px-3 py-2"
        >
          {/* The bb name in a fixed column, so every field lines up and a
              renamed project still says which project it is. */}
          <span className="w-36 shrink-0 truncate text-sm" title={row.name}>
            {row.name}
          </span>
          <input
            // Keyed by the stored label, so a saved or reverted value resets
            // the field instead of leaving a stale draft.
            key={row.label ?? ""}
            type="text"
            aria-label={`Label for ${row.name}`}
            defaultValue={row.label ?? ""}
            placeholder={row.name}
            maxLength={MAX_PROJECT_LABEL_LENGTH}
            onBlur={(event) => void rename(row.projectId, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="h-7 w-32 min-w-0 rounded-md border border-border bg-transparent px-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <span
            className={cn(
              "min-w-0 max-w-[12rem] shrink-0 truncate rounded px-1 text-2xs font-medium",
              projectColor(row.colorId).badgeClass,
            )}
          >
            {row.label ?? row.name}
          </span>
          <span className="flex flex-1 flex-wrap items-center justify-end gap-1">
            {PROJECT_COLORS.map((color) => (
              <button
                key={color.id}
                type="button"
                aria-label={`${color.label} for ${row.name}`}
                aria-pressed={row.colorId === color.id}
                title={color.label}
                onClick={() => void choose(row.projectId, color.id)}
                className={cn(
                  "size-5 rounded-full border-2 transition-colors",
                  color.swatchClass,
                  row.colorId === color.id
                    ? "border-foreground"
                    : "border-transparent hover:border-muted-foreground/50",
                )}
              />
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}
