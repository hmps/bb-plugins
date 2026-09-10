import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { ProjectColorRow, t3sidebarRpcContract } from "./server";
import { cn } from "./lib/utils";
import { PROJECT_COLORS, projectColor } from "./project-colors";

/**
 * The colour picker for project badges: every project bb knows about, each
 * with one row of swatches.
 *
 * A click saves at once — one project, one colour, nothing to confirm — so
 * the section has no Save button and no draft state to keep in step.
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
          <span
            className={cn(
              "min-w-0 max-w-[12rem] shrink-0 truncate rounded px-1 text-2xs font-medium",
              projectColor(row.colorId).badgeClass,
            )}
          >
            {row.name}
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
