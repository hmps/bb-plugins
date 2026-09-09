// bb-plugin-fanout — frontend entry.
//
// One settings section: the list of machines bb knows about, each with a
// thread ceiling and an enabled switch. It replaces hand-edited JSON, and it
// shows every machine — including the ones deliberately kept out of fan-out —
// so "disabled" reads as a decision rather than an omission.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { MachineRow, rpcContract } from "./server";

/** Local edit state: the saved row plus any unsaved change. */
type Draft = {
  capacity: string;
  enabled: boolean;
};

function draftsOf(rows: MachineRow[]): Record<string, Draft> {
  return Object.fromEntries(
    rows.map((row) => [
      row.hostId,
      { capacity: String(row.capacity), enabled: row.enabled },
    ]),
  );
}

function parseCapacity(raw: string): number | null {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1000) return null;
  return value;
}

function MachinesSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<MachineRow[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await rpc.call("listMachines", null);
      setRows(result.machines);
      setDrafts(draftsOf(result.machines));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty =
    rows !== null &&
    rows.some((row) => {
      const draft = drafts[row.hostId];
      if (!draft) return false;
      return (
        draft.enabled !== row.enabled || draft.capacity !== String(row.capacity)
      );
    });

  const invalid = Object.values(drafts).some(
    (draft) => parseCapacity(draft.capacity) === null,
  );

  async function save() {
    if (!rows || invalid) return;
    setSaving(true);
    try {
      const result = await rpc.call("saveMachines", {
        machines: rows.map((row) => {
          const draft = drafts[row.hostId];
          return {
            hostId: row.hostId,
            // `invalid` is already false here, so the fallback never applies;
            // it exists so the type stays a number without a non-null assertion.
            capacity: parseCapacity(draft?.capacity ?? "") ?? row.capacity,
            enabled: draft?.enabled ?? row.enabled,
          };
        }),
      });
      setRows(result.machines);
      setDrafts(draftsOf(result.machines));
      toast.success("Machine settings saved");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  if (error) {
    return (
      <p className="text-sm text-destructive">Could not load machines: {error}</p>
    );
  }

  if (!rows) {
    return <p className="text-sm text-muted-foreground">Loading machines…</p>;
  }

  const enabledCount = rows.filter(
    (row) => drafts[row.hostId]?.enabled ?? row.enabled,
  ).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col divide-y divide-border rounded-md border border-border">
        {rows.map((row) => {
          const draft = drafts[row.hostId] ?? {
            capacity: String(row.capacity),
            enabled: row.enabled,
          };
          const badCapacity = parseCapacity(draft.capacity) === null;

          return (
            <div
              key={row.hostId}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{row.name}</span>
                <span className="text-xs text-muted-foreground">
                  {row.connected ? "Connected" : "Disconnected"} ·{" "}
                  {row.running} running
                </span>
              </div>

              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Max threads
                <input
                  type="number"
                  min={1}
                  max={1000}
                  inputMode="numeric"
                  value={draft.capacity}
                  disabled={!draft.enabled}
                  aria-label={`Max threads on ${row.name}`}
                  onChange={(event) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [row.hostId]: {
                        ...draft,
                        capacity: event.currentTarget.value,
                      },
                    }))
                  }
                  className={`h-7 w-16 rounded border bg-background px-2 text-sm text-foreground disabled:opacity-50 ${
                    badCapacity && draft.enabled
                      ? "border-destructive"
                      : "border-input"
                  }`}
                />
              </label>

              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  aria-label={`Use ${row.name} for fan-out`}
                  onChange={(event) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [row.hostId]: {
                        ...draft,
                        enabled: event.currentTarget.checked,
                      },
                    }))
                  }
                  className="size-3.5 accent-primary"
                />
                <span
                  className={
                    draft.enabled ? "text-foreground" : "text-muted-foreground"
                  }
                >
                  {draft.enabled ? "Enabled" : "Disabled"}
                </span>
              </label>
            </div>
          );
        })}
      </div>

      {enabledCount === 0 ? (
        <p className="text-xs text-muted-foreground">
          No machine is enabled, so no advice is ever given. Enable the machines
          that may run fanned-out work.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          A disabled machine is left out of fan-out entirely: it is never
          offered as a target, and threads running on it are never told to move.
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || invalid || saving}
          className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {invalid ? (
          <span className="text-xs text-destructive">
            Max threads must be a whole number between 1 and 1000.
          </span>
        ) : null}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "machines",
    title: "Machines",
    description:
      "Which machines may run fanned-out work, and how many threads each may run at once.",
    component: MachinesSection,
  });
});
