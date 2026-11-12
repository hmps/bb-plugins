import { fields, type Totals } from "./contract";
import { DAY, hourStart, type UsageStore } from "./storage";

export const HELP = `Usage: bb thread-usage <command>
  thread <id> [--json]                         Tracked totals since tracking began
  threads [--since <ISO|YYYY-MM-DD>] [--project <id>] [--limit <n>] [--json]
  days [--days <n>] [--json]                    Local days, split by project and model
  hours [--since <ISO|YYYY-MM-DD>] [--json]      Retained UTC hours, split by model
  --help                                      Show this help
Periods use whole event hours. Date-only --since uses server-local midnight.
Thread and hour rankings include only retained hourly data.
`;
function positive(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`Expected an integer from 1 to ${max}.`);
  return n;
}
export function parseSince(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) throw new Error("--since needs an ISO date or YYYY-MM-DD.");
  const n = Date.parse(value.length === 10 ? `${value}T00:00:00` : value);
  if (!Number.isFinite(n)) throw new Error("--since needs a valid date.");
  return n;
}
function table(rows: { model: string; totals: Totals; [key: string]: unknown }[], keys: string[]): string {
  const headings = [...keys, "model", ...fields];
  return [headings.join("\t"), ...rows.map((r) => [...keys.map((k) => String(r[k] ?? "")), r.model, ...fields.map((f) => r.totals[f])].join("\t"))].join("\n") + "\n";
}
export function runCli(store: UsageStore, argv: string[], retentionDays: number) {
  try {
    const [command, ...args] = argv;
    if (!command || command === "help" || argv.includes("--help")) return { exitCode: 0, stdout: HELP };
    const allowed: Record<string, string[]> = {
      thread: [], threads: ["--since", "--project", "--limit"], days: ["--days"], hours: ["--since"],
    };
    if (!(command in allowed)) throw new Error(`Unknown command: ${command}`);
    const flags = new Map<string, string>();
    let json = false;
    let id: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--json") { json = true; continue; }
      if (allowed[command].includes(arg)) {
        const value = args[++i];
        if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
        flags.set(arg, value);
      } else if (command === "thread" && !id && !arg.startsWith("--")) id = arg;
      else throw new Error(`Unexpected argument: ${arg}`);
    }
    const since = parseSince(flags.get("--since"), hourStart(store.now() - retentionDays * DAY));
    let result: unknown;
    let plain: string;
    if (command === "thread") {
      if (!id) throw new Error("thread needs an id.");
      const row = store.getThreadUsage(id);
      result = row;
      plain = row ? table([row], ["threadId", "projectId", "firstSeenAt", "baseline"]) : "No tracked usage for this thread.\n";
    } else if (command === "days") {
      const data = store.getDailyUsage(positive(flags.get("--days"), 7, 3660));
      result = data;
      plain = table(data.rows, ["day", "projectId"]);
    } else {
      const data = command === "threads"
        ? store.getThreads(since, retentionDays, flags.get("--project"), positive(flags.get("--limit"), 20, 1000))
        : store.getHours(since, retentionDays);
      result = data;
      plain = (data.truncated ? "Period exceeds retention; only retained hourly usage is shown.\n" : "")
        + table(data.rows, command === "threads" ? ["threadId", "projectId"] : ["hourStartUtc"]);
    }
    return { exitCode: 0, stdout: json ? JSON.stringify(result) + "\n" : plain };
  } catch (error) {
    return { exitCode: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n${HELP}` };
  }
}
