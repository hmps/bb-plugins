// bb-plugin-thread-usage — the frontend bundle.
//
// Two read-only views of the plugin's own database:
//   - a "Tokens" row in each thread's Info tab;
//   - a "Thread usage" nav panel with the last 14 days by model and the top
//     threads of the last 24 hours.
// Both read through RPC. The server invalidates their tags when stored usage
// changes, so open views refresh without polling. Nothing here writes.
import { useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import {
  definePluginApp,
  experimental_DetailRow as DetailRow,
  experimental_Icon as Icon,
  experimental_useRpcQuery as useRpcQuery,
  useBbNavigate,
  type ExperimentalThreadInfoProps,
} from "@get-bb/plugin-sdk/app";
import { usageRpcContract, type ThreadUsage } from "./contract";
import { dailySeries, topThreads, type DailySeries, type TopThread } from "./lib/aggregate";
import {
  dayKey, exactTitle, formatDay, formatExact, formatMoment, formatTimestamp, formatTokens,
} from "./lib/format";

const ICON = "ChartColumn";
const PANEL_PATH = "usage";
const DAYS = 14;
const TOP_THREADS = 10;
/** The RPC ranks thread/model pairs; ask for enough to merge 10 threads. */
const THREAD_ROWS = 100;
const HOUR = 3_600_000;
/** Series fills by legend position. Opacity steps of one host token keep custom palettes intact. */
const SERIES_FILLS = ["bg-foreground/80", "bg-foreground/55", "bg-foreground/35", "bg-foreground/20"];

const BREAKDOWN = [
  ["Input", "inputTokens"],
  ["Cache read", "cacheReadInputTokens"],
  ["Cache write", "cacheWriteInputTokens"],
  ["Output", "outputTokens"],
] as const;

const isEmpty = (usage: ThreadUsage): boolean => Object.values(usage.totals).every((n) => n === 0);

function ThreadUsageRow({ threadId }: ExperimentalThreadInfoProps) {
  const query = useRpcQuery({ contract: usageRpcContract, method: "getThreadUsage", input: { threadId } });
  const [open, setOpen] = useState(false);
  const usage = query.data;

  if (usage === undefined) {
    return (
      <DetailRow label="Tokens" icon={ICON}>
        <span className="text-muted-foreground" title={query.error?.message}>
          {query.error ? "Unavailable" : "Loading…"}
        </span>
      </DetailRow>
    );
  }
  if (usage === null || isEmpty(usage)) {
    return (
      <DetailRow label="Tokens" icon={ICON}>
        <span className="text-muted-foreground">No usage tracked yet</span>
      </DetailRow>
    );
  }
  const { totals, model, firstSeenAt, baseline } = usage;
  const since = formatMoment(firstSeenAt, Date.now());
  return (
    <DetailRow label="Tokens" icon={ICON} align="start">
      <div className="flex min-w-0 flex-col gap-0.5">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${exactTitle(totals.totalTokens)}, ${model}. ${open ? "Hide" : "Show"} breakdown`}
          onClick={() => setOpen((v) => !v)}
          className="-mx-1 flex min-w-0 items-center gap-1.5 rounded-sm px-1 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="shrink-0 font-medium tabular-nums text-foreground" title={exactTitle(totals.totalTokens)}>
            {formatTokens(totals.totalTokens)}
          </span>
          <span className="min-w-0 truncate text-muted-foreground" title={model}>{model}</span>
          <Icon
            name="ChevronDown"
            aria-hidden
            className={`size-3.5 shrink-0 text-muted-foreground transition-[rotate] duration-150 ${open ? "rotate-180" : ""}`}
          />
        </button>
        <span className="text-xs text-muted-foreground" title={formatTimestamp(firstSeenAt)}>
          {baseline ? `Tracking started ${since}` : `Since ${since}`}
        </span>
        {open ? (
          <dl className="mt-1 grid grid-cols-[auto_auto] justify-start gap-x-3 gap-y-0.5 text-xs">
            {BREAKDOWN.map(([label, field]) => (
              <div key={field} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right tabular-nums text-foreground">{formatExact(totals[field])}</dd>
              </div>
            ))}
            <dt className="text-muted-foreground">Total</dt>
            <dd className="text-right font-medium tabular-nums text-foreground">{formatExact(totals.totalTokens)}</dd>
          </dl>
        ) : null}
      </div>
    </DetailRow>
  );
}

function UsagePage() {
  // Fixed per mount so the read key stays stable; whole hours match the server's buckets.
  const [since] = useState(() => Math.floor((Date.now() - 24 * HOUR) / HOUR) * HOUR);
  const daily = useRpcQuery({ contract: usageRpcContract, method: "getDailyUsage", input: { days: DAYS } });
  const threads = useRpcQuery({
    contract: usageRpcContract, method: "getThreads", input: { since, limit: THREAD_ROWS },
  });
  const today = dayKey(Date.now());
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-6">
        <p className="text-sm text-muted-foreground">
          Counts start when Thread Usage was installed. Earlier usage is not included.
        </p>
        <section aria-labelledby="thread-usage-days" className="flex flex-col gap-3">
          {daily.data ? (
            <DailyChart series={dailySeries(daily.data.rows, DAYS, today)} today={today} />
          ) : (
            <>
              <SectionHeading id="thread-usage-days">Last {DAYS} days</SectionHeading>
              <QueryStatus error={daily.error?.message} />
            </>
          )}
        </section>
        <section aria-labelledby="thread-usage-threads" className="flex flex-col gap-3">
          <SectionHeading id="thread-usage-threads">Top threads, last 24 hours</SectionHeading>
          {threads.data ? (
            <ThreadList threads={topThreads(threads.data.rows, TOP_THREADS)} />
          ) : (
            <QueryStatus error={threads.error?.message} />
          )}
        </section>
      </div>
    </div>
  );
}

function SectionHeading({ id, children, trailing }: { id: string; children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 id={id} className="text-sm font-medium text-foreground">{children}</h2>
      {trailing}
    </div>
  );
}

function QueryStatus({ error }: { error?: string }) {
  return error
    ? <p role="alert" className="text-sm text-destructive">Could not load usage: {error}</p>
    : <p className="text-sm text-muted-foreground">Loading…</p>;
}

function DailyChart({ series, today }: { series: DailySeries; today: string }) {
  const fill = (model: string) => SERIES_FILLS[Math.max(0, series.models.findIndex((m) => m.model === model))] ?? SERIES_FILLS.at(-1);
  const todayTotal = series.days.find((d) => d.day === today)?.total ?? 0;
  return (
    <>
      <SectionHeading
        id="thread-usage-days"
        trailing={series.total > 0 ? (
          <span className="text-xs text-muted-foreground">
            Today <span className="tabular-nums text-foreground" title={exactTitle(todayTotal)}>{formatTokens(todayTotal)}</span>
            {" · "}
            {DAYS} days <span className="tabular-nums text-foreground" title={exactTitle(series.total)}>{formatTokens(series.total)}</span>
          </span>
        ) : null}
      >
        Last {DAYS} days
      </SectionHeading>
      {series.total === 0 ? (
        <p className="text-sm text-muted-foreground">No usage tracked in the last {DAYS} days.</p>
      ) : (
        <>
          <ul aria-label="Models" className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {series.models.map((m) => (
              <li key={m.model} className="flex min-w-0 items-center gap-1.5">
                <span aria-hidden className={`size-2 shrink-0 rounded-full ${fill(m.model)}`} />
                <span className="truncate text-foreground">{m.model}</span>
                <span className="tabular-nums text-muted-foreground" title={exactTitle(m.total)}>{formatTokens(m.total)}</span>
              </li>
            ))}
          </ul>
          <ol className="flex flex-col gap-1">
            {series.days.slice().reverse().map((d) => (
              <li
                key={d.day}
                className="grid grid-cols-[6rem_1fr_3.5rem] items-center gap-3 text-xs"
                aria-label={`${formatDay(d.day)}: ${exactTitle(d.total)}${d.models.map((m) => `, ${m.model} ${formatExact(m.total)}`).join("")}`}
              >
                <span className={d.day === today ? "text-foreground" : "text-muted-foreground"}>{formatDay(d.day)}</span>
                <div aria-hidden className="flex h-2 gap-px overflow-hidden rounded-full bg-muted">
                  {d.models.map((m) => (
                    <div
                      key={m.model}
                      className={fill(m.model)}
                      style={{ width: `${(m.total / series.max) * 100}%` }}
                      title={`${m.model}: ${exactTitle(m.total)}`}
                    />
                  ))}
                </div>
                <span
                  className={`text-right tabular-nums ${d.total > 0 ? "text-foreground" : "text-muted-foreground"}`}
                  title={exactTitle(d.total)}
                >
                  {d.total > 0 ? formatTokens(d.total) : "–"}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </>
  );
}

function ThreadList({ threads }: { threads: TopThread[] }) {
  const navigate = useBbNavigate();
  if (threads.length === 0) {
    return <p className="text-sm text-muted-foreground">No thread used tokens in the last 24 hours.</p>;
  }
  const open = (event: MouseEvent, threadId: string) =>
    navigate.toThread(threadId, { split: event.metaKey || event.ctrlKey });
  return (
    <ol className="-mx-2 flex flex-col">
      {threads.map((t) => (
        <li key={t.threadId}>
          <button
            type="button"
            onClick={(event) => open(event, t.threadId)}
            className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={`truncate text-sm text-foreground ${t.title ? "" : "font-mono"}`}>{t.title || t.threadId}</span>
              <span className="truncate text-xs text-muted-foreground">
                {t.models.map((m) => (t.models.length > 1 ? `${m.model} ${formatTokens(m.total)}` : m.model)).join(" · ")}
              </span>
            </span>
            <span className="shrink-0 text-sm tabular-nums text-foreground" title={exactTitle(t.total)}>
              {formatTokens(t.total)}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadInfoRow({
    id: "tokens",
    // After bb's own groups (1_thread … 5_lifecycle).
    group: "6_usage",
    component: ThreadUsageRow,
  });
  app.slots.navPanel({
    id: "usage",
    title: "Thread usage",
    icon: ICON,
    path: PANEL_PATH,
    component: UsagePage,
  });
});
