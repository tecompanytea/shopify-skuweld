import { useEffect, useState, type ReactNode } from "react";
import {
  Cell,
  CartesianGrid,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  useRouteError,
  useSearchParams,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncSquareOrdersIncremental } from "../.server/analytics/square-sync";
import { syncShopifyOrdersIncremental } from "../.server/analytics/shopify-sync";
import { runInBackground } from "../.server/analytics/background";
import {
  analyticsShopOverride,
  resolveAnalyticsShop,
  resolveComparison,
  resolveRange,
} from "../.server/analytics/request";
import { evaluateFreshness } from "../.server/analytics/freshness";
import {
  computeAnalyticsChartSummary,
  type AnalyticsChartSummary,
  type ChartPoint,
  type ProductChartRow,
} from "../.server/analytics/chart-summary";
import {
  computeWeeklyReport,
  type CellPair,
  type ChannelCells,
  type WeeklyReport,
} from "../.server/analytics/weekly-report";
import {
  computeProductSellingReport,
  type ProductSellingReport,
} from "../.server/analytics/product-selling-report";
import {
  computeTop10Report,
  type Top10Report,
} from "../.server/analytics/top10-report";
import {
  computeUnitsBySizeReport,
  type UnitsBySizeReport,
} from "../.server/analytics/units-by-size-report";
import { SIZE_COLUMNS, PRODUCT_REPORT_SCOPES } from "../lib/analytics-scopes";
import { formatDay, toReportDay } from "../lib/periods";
import { PeriodPicker } from "../components/period-picker";
import { ComparisonPicker } from "../components/comparison-picker";
import styles from "../components/analytics-charts.module.css";

// Human "last refreshed" label for the freshness line under the report.
function refreshedLabel(at: Date, now: number): string {
  const min = Math.floor((now - at.getTime()) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const days = Math.floor(hr / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return `on ${toReportDay(at)}`;
}

// Give this route's serverless function room to finish the background pulls
// (started via waitUntil) past the HTTP response. 300s is the Pro-plan max; on
// Hobby lower this to 60. Either way the spinner is poll-driven and can't hang.
export const config = { maxDuration: 300 };

const SYNC_SOURCE_LABELS: Record<string, string> = {
  "square-orders": "Square",
  "shopify-orders": "Shopify",
};
const CHART_CURRENT_COLOR = "rgb(19, 172, 240)";
const CHART_COMPARISON_COLOR = "rgba(10, 151, 213, 0.5)";
// A pull that hasn't written progress for this long is treated as stalled —
// i.e. the background function was killed (e.g. hit maxDuration). It surfaces
// as a message instead of an endless spinner.
const SYNC_STALE_MS = 120_000;

type SyncStateRow = {
  id: string;
  status: string;
  progress: string | null;
  error: string | null;
  updatedAt: Date;
};

// Server-side view of the two order pulls, recomputed on every poll. The
// page's "Refreshing" state comes from here (not the fetcher), so it tracks
// the work itself rather than the request that kicked it off.
function summarizeSync(shop: string, states: SyncStateRow[], now: number) {
  const rows = states
    .map((s) => ({
      ...s,
      source: s.id.startsWith(`${shop}:`) ? s.id.slice(shop.length + 1) : "",
    }))
    .filter((s) => s.source in SYNC_SOURCE_LABELS);
  const label = (source: string) => SYNC_SOURCE_LABELS[source] ?? source;
  const age = (s: SyncStateRow) => now - s.updatedAt.getTime();
  const runningFresh = rows.filter(
    (s) => s.status === "running" && age(s) < SYNC_STALE_MS,
  );
  const runningStale = rows.filter(
    (s) => s.status === "running" && age(s) >= SYNC_STALE_MS,
  );
  return {
    running: runningFresh.length > 0,
    stalled: runningFresh.length === 0 && runningStale.length > 0,
    progress: runningFresh
      .map((s) => `${label(s.source)}: ${s.progress ?? "…"}`)
      .join(" · "),
    results: rows
      .filter((s) => s.status === "done" || s.status === "error")
      .map((s) => ({
        source: label(s.source),
        ok: s.status === "done",
        message:
          s.status === "error" ? (s.error ?? "failed") : (s.progress ?? "done"),
      })),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const override = analyticsShopOverride();
  const shop = resolveAnalyticsShop(session.shop);
  const url = new URL(request.url);
  const type = url.searchParams.get("type") ?? "weekly";
  const preset = url.searchParams.get("preset") ?? "last-week";
  const range = resolveRange(url.searchParams);
  const compare = resolveComparison(url.searchParams, type);

  const [syncStates, lineCount] = await Promise.all([
    prisma.syncState.findMany({ where: { shop } }),
    prisma.salesLine.count({ where: { shop } }),
  ]);

  const now = Date.now();
  const { stale, historical, lastSyncedAt } = evaluateFreshness(
    shop,
    syncStates,
    range,
    now,
  );
  const lastSyncedLabel = lastSyncedAt
    ? refreshedLabel(lastSyncedAt, now)
    : null;
  const sync = summarizeSync(shop, syncStates, now);

  let charts: AnalyticsChartSummary | null = null;
  let weekly: WeeklyReport | null = null;
  let productSelling: ProductSellingReport | null = null;
  let top10: Top10Report | null = null;
  let unitsBySize: UnitsBySizeReport | null = null;
  if (lineCount > 0) {
    if (type === "weekly") {
      [charts, weekly] = await Promise.all([
        computeAnalyticsChartSummary(shop, range, compare),
        computeWeeklyReport(shop, range, compare),
      ]);
    } else if (type.startsWith("product-")) {
      [charts, productSelling] = await Promise.all([
        computeAnalyticsChartSummary(shop, range, compare),
        computeProductSellingReport(
          shop,
          type.slice("product-".length),
          range,
          compare,
        ),
      ]);
    } else if (type === "top10") {
      [charts, top10] = await Promise.all([
        computeAnalyticsChartSummary(shop, range, compare),
        computeTop10Report(shop, range, compare),
      ]);
    } else if (type === "units-by-size") {
      [charts, unitsBySize] = await Promise.all([
        computeAnalyticsChartSummary(shop, range, compare),
        computeUnitsBySizeReport(shop, range),
      ]);
    }
  }

  return {
    type,
    preset,
    range,
    compare,
    sync,
    lineCount,
    stale,
    historical,
    lastSyncedLabel,
    override,
    charts,
    weekly,
    productSelling,
    top10,
    unitsBySize,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  if (analyticsShopOverride()) {
    return {
      error:
        "ANALYTICS_SHOP_OVERRIDE is active (read-only). Run syncs from the real store or the backfill script.",
    };
  }
  const form = await request.formData();
  if (form.get("intent") !== "refresh") {
    return { error: "Unknown action" };
  }
  const shop = session.shop;

  // Mark both sources running up front so the page shows the sync immediately,
  // then pull in the background — past the HTTP response — only what changed
  // since the last sync (high-watermark incremental). The pulls run
  // independently (one failing still lets the other through) and write their
  // own progress/results to SyncState, which the page polls.
  await Promise.all(
    (["square-orders", "shopify-orders"] as const).map((source) => {
      const id = `${shop}:${source}`;
      return prisma.syncState.upsert({
        where: { id },
        create: { id, shop, status: "running", progress: "Queued…" },
        update: { status: "running", progress: "Queued…", error: null },
      });
    }),
  );
  runInBackground(() =>
    Promise.allSettled([
      syncSquareOrdersIncremental(shop),
      syncShopifyOrdersIncremental(shop, admin),
    ]),
  );
  return { started: true };
};

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

function dollars(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function preciseDollars(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function compactDollars(cents: number): string {
  const amount = cents / 100;
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1000) {
    return `${sign}$${Math.round(abs / 1000)}K`;
  }
  return `${sign}$${Math.round(abs)}`;
}

function moneyAxisLabel(cents: number): string {
  const amount = cents / 100;
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1000) {
    const thousands = abs / 1000;
    const label = Number.isInteger(thousands)
      ? thousands.toFixed(0)
      : thousands.toFixed(1).replace(/\.0$/, "");
    return `${sign}$${label}k`;
  }
  return `${sign}$${Math.round(abs)}`;
}

const MONEY_AXIS_STEPS = [
  25, 50, 100, 250, 500, 1000, 2000, 2500, 5000, 10000, 25000, 50000,
];

function moneyAxisScale(points: ChartPoint[]): {
  ticks: number[];
  domainMax: number;
} {
  const maxValue = Math.max(
    0,
    ...points.flatMap((point) => [
      Math.max(point.ty, 0),
      Math.max(point.ly, 0),
    ]),
  );
  const maxDollars = maxValue / 100;
  const stepDollars =
    MONEY_AXIS_STEPS.find((step) => step * 3 >= maxDollars * 0.95) ??
    Math.ceil(maxDollars / 3);
  const ticks = [0, stepDollars, stepDollars * 2, stepDollars * 3].map(
    (dollars) => dollars * 100,
  );

  return {
    ticks,
    domainMax: Math.max(maxValue, ticks[ticks.length - 1]),
  };
}

function xAxisTicks(points: ChartPoint[]): string[] | undefined {
  if (points.length < 28) return undefined;
  const step = points.length <= 35 ? 3 : Math.ceil(points.length / 10);
  return points
    .filter((_, index) => index % step === 0)
    .map((point) => point.label);
}

function rangeLabel(range: { start: string; end: string }): string {
  if (range.start === range.end) return formatDay(range.start);
  const start = new Date(`${range.start}T12:00:00Z`);
  const end = new Date(`${range.end}T12:00:00Z`);
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  const sameMonth = sameYear && start.getUTCMonth() === end.getUTCMonth();
  const startMonth = start.toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const endMonth = end.toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  if (sameMonth) {
    return `${startMonth} ${start.getUTCDate()}-${end.getUTCDate()}, ${end.getUTCFullYear()}`;
  }
  if (sameYear) {
    return `${startMonth} ${start.getUTCDate()}-${endMonth} ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
  }
  return `${formatDay(range.start)} - ${formatDay(range.end)}`;
}

const CHART_DEFINITIONS: Record<
  string,
  { description: string; formula?: string }
> = {
  "Total sales over time": {
    description:
      "Amount spent (subtotal, taxes, shipping, returns, discounts, fees, etc.).",
    formula:
      "Total sales = net sales + additional fees + duties + shipping charges + taxes",
  },
  "Total sales by sales channel": {
    description: "Total sales grouped by sales channel.",
  },
  "Total sales by product": {
    description: "Total sales grouped by product.",
  },
};

function chartTitleId(title: string): string {
  return `analytics-${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")}-definition`;
}

function ChartTitle({ title }: { title: string }) {
  const definition = CHART_DEFINITIONS[title];
  if (!definition) {
    return (
      <div className={styles.chartHeader}>
        <h2 className={styles.chartTitle}>{title}</h2>
      </div>
    );
  }

  const tooltipId = chartTitleId(title);
  return (
    <div className={styles.chartHeader}>
      <s-clickable
        interestFor={tooltipId}
        accessibilityLabel={`Open definition for ${title}`}
      >
        <span
          role="heading"
          aria-level={2}
          className={`${styles.chartTitle} ${styles.chartTitleTrigger}`}
        >
          {title}
        </span>
      </s-clickable>
      <s-tooltip id={tooltipId}>
        <s-paragraph>{definition.description}</s-paragraph>
        {definition.formula ? (
          <s-paragraph>{definition.formula}</s-paragraph>
        ) : null}
      </s-tooltip>
    </div>
  );
}

function ChangeLabel({
  metric,
}: {
  metric: { ty: number; ly: number; changePct: number | null };
}) {
  if (metric.changePct === null) {
    return metric.ty === 0 ? null : (
      <span className={styles.changeValue}>New</span>
    );
  }
  const positive = metric.changePct >= 0;
  const percent = Math.round(Math.abs(metric.changePct * 100) * 10) / 10;
  const percentLabel =
    percent < 10 && !Number.isInteger(percent)
      ? percent.toFixed(1)
      : percent.toFixed(0);
  const title = `${positive ? "Increase" : "Decrease"} of ${percentLabel}%`;
  return (
    <span
      className={`${styles.changeValue}${positive ? "" : ` ${styles.changeNegative}`}`}
      title={title}
    >
      <svg
        viewBox="0 0 6 6"
        width="6"
        height="6"
        aria-hidden="true"
        className={styles.trendIcon}
      >
        <path
          fill="currentColor"
          fillRule="evenodd"
          clipRule="evenodd"
          d={
            positive
              ? "M1 .25a.75.75 0 1 0 0 1.5h2.19L.594 4.345a.75.75 0 0 0 1.06 1.06L4.25 2.811V5a.75.75 0 0 0 1.5 0V1A.748.748 0 0 0 5 .25H1Z"
              : "M5.75 1a.75.75 0 0 0-1.5 0v2.19L1.655.594a.75.75 0 1 0-1.06 1.06L3.189 4.25H1a.75.75 0 0 0 0 1.5h4a.748.748 0 0 0 .529-.218l.001-.002.002-.001A.748.748 0 0 0 5.75 5V1Z"
          }
        />
      </svg>
      <span>{percentLabel}%</span>
    </span>
  );
}

function ChartLegend({
  current,
  comparison,
}: {
  current: string;
  comparison: string;
}) {
  return (
    <div className={styles.legend}>
      <span className={styles.legendItem}>
        <span className={styles.legendIcon}>
          <span className={styles.legendDot} />
        </span>
        <span className={styles.legendText}>{current}</span>
      </span>
      <span className={styles.legendItem}>
        <span className={styles.legendIcon}>
          <span className={`${styles.legendDot} ${styles.comparisonDot}`} />
        </span>
        <span className={styles.legendText}>{comparison}</span>
      </span>
    </div>
  );
}

function MoneyTooltip({
  active,
  payload,
  label,
  formatValue,
}: TooltipContentProps & {
  formatValue: (cents: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const rows = payload.flatMap((entry) =>
    typeof entry.value === "number"
      ? [
          {
            name: String(entry.name ?? ""),
            value: entry.value,
            color: entry.color ?? CHART_CURRENT_COLOR,
          },
        ]
      : [],
  );
  if (rows.length === 0) return null;
  return (
    <div className={styles.tooltip}>
      <div className={styles.tooltipLabel}>{label}</div>
      {rows.map((row) => (
        <div className={styles.tooltipRow} key={row.name}>
          <span className={styles.tooltipName}>
            <span
              className={styles.tooltipSwatch}
              style={{ background: row.color }}
            />
            {row.name}
          </span>
          <span className={styles.tooltipAmount}>{formatValue(row.value)}</span>
        </div>
      ))}
    </div>
  );
}

function PieTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const row = payload.find((entry) => typeof entry.value === "number");
  if (!row || typeof row.value !== "number") return null;
  return (
    <div className={`${styles.tooltip} ${styles.pieTooltip}`}>
      <div className={styles.pieTooltipRow}>
        <span className={styles.tooltipName}>
          <span
            className={styles.tooltipSwatch}
            style={{
              background:
                typeof row.color === "string" ? row.color : CHART_CURRENT_COLOR,
            }}
          />
          <span className={styles.pieTooltipName}>
            {String(row.name ?? "")}
          </span>
        </span>
        <span className={styles.tooltipAmount}>{dollars(row.value)}</span>
      </div>
    </div>
  );
}

function LineMetricCard({
  title,
  metric,
  points,
  currentLabel,
  comparisonLabel,
  ready,
  wide = false,
  compact = false,
  formatValue,
}: {
  title: string;
  metric: { ty: number; ly: number; changePct: number | null };
  points: ChartPoint[];
  currentLabel: string;
  comparisonLabel: string;
  ready: boolean;
  wide?: boolean;
  compact?: boolean;
  formatValue: (cents: number) => string;
}) {
  const yAxis = moneyAxisScale(points);
  const xTicks = xAxisTicks(points);

  return (
    <section
      className={`${styles.chartCard}${wide ? ` ${styles.wideChartCard}` : ""}`}
      aria-label={title}
    >
      <ChartTitle title={title} />
      <div className={styles.metricRow}>
        <span
          className={`${styles.metricValue}${compact ? ` ${styles.smallMetricValue}` : ""}`}
        >
          {formatValue(metric.ty)}
        </span>
        <ChangeLabel metric={metric} />
      </div>
      <div className={wide ? styles.chartFrame : styles.miniChartFrame}>
        {ready ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={points}
              margin={{ top: 10, right: 18, bottom: 10, left: 0 }}
            >
              <CartesianGrid stroke="#ebedf0" vertical={false} />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{ fill: "#6d7175", fontSize: 12 }}
                tickMargin={14}
                ticks={xTicks}
                interval={xTicks ? 0 : "preserveEnd"}
                minTickGap={24}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fill: "#6d7175", fontSize: 12 }}
                tickFormatter={moneyAxisLabel}
                ticks={yAxis.ticks}
                domain={[0, yAxis.domainMax]}
                width={54}
              />
              <Tooltip
                cursor={{ stroke: CHART_COMPARISON_COLOR, strokeWidth: 1 }}
                content={(props) => (
                  <MoneyTooltip {...props} formatValue={formatValue} />
                )}
              />
              <Line
                type="monotone"
                name={currentLabel}
                dataKey="ty"
                stroke={CHART_CURRENT_COLOR}
                strokeWidth={2}
                dot={false}
                activeDot={{
                  r: 3.5,
                  strokeWidth: 0,
                  fill: CHART_CURRENT_COLOR,
                }}
              />
              <Line
                type="monotone"
                name={comparisonLabel}
                dataKey="ly"
                stroke={CHART_COMPARISON_COLOR}
                strokeDasharray="4 7"
                strokeWidth={2}
                dot={false}
                activeDot={{
                  r: 3.5,
                  strokeWidth: 0,
                  fill: CHART_COMPARISON_COLOR,
                }}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className={styles.chartPlaceholder} />
        )}
      </div>
      <ChartLegend current={currentLabel} comparison={comparisonLabel} />
    </section>
  );
}

const CHANNEL_COLORS: Record<string, string> = {
  ECOM: CHART_CURRENT_COLOR,
  WV: "#77b7d7",
  EV: "#b8c8f2",
  INVOICED: "#efb6dc",
};

function SalesChannelCard({
  charts,
  ready,
}: {
  charts: AnalyticsChartSummary;
  ready: boolean;
}) {
  const positiveRows = charts.salesByChannel.filter((row) => row.ty > 0);
  const topChannel = charts.salesByChannel[0];
  const pieRows = positiveRows.map((row, index) => ({
    name: row.label,
    value: row.ty,
    color:
      CHANNEL_COLORS[row.channel] ??
      [CHART_CURRENT_COLOR, "#77b7d7", "#b8c8f2", "#efb6dc"][index % 4],
  }));

  return (
    <section
      className={styles.chartCard}
      aria-label="Total sales by sales channel"
    >
      <ChartTitle title="Total sales by sales channel" />
      <div className={styles.donutLayout}>
        <div className={styles.donutFrame}>
          {ready && pieRows.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Tooltip
                  allowEscapeViewBox={{ x: true, y: true }}
                  position={{ x: 118, y: 48 }}
                  wrapperStyle={{ pointerEvents: "none", zIndex: 4 }}
                  content={(props) => <PieTooltip {...props} />}
                />
                <Pie
                  data={pieRows}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="72%"
                  outerRadius="96%"
                  paddingAngle={1}
                  startAngle={90}
                  endAngle={-270}
                  stroke="#ffffff"
                  strokeWidth={3}
                >
                  {pieRows.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className={styles.chartPlaceholder} />
          )}
          {topChannel && (
            <div className={styles.donutCenter}>
              <div className={styles.donutCenterLabel}>{topChannel.label}</div>
              <div className={styles.donutCenterValue}>
                {compactDollars(topChannel.ty)}
              </div>
              <ChangeLabel metric={topChannel} />
            </div>
          )}
        </div>
        <div className={styles.channelList}>
          {charts.salesByChannel.map((row) => (
            <div className={styles.channelRow} key={row.channel}>
              <span className={styles.channelName}>
                <span
                  className={styles.channelSwatch}
                  style={{
                    background:
                      CHANNEL_COLORS[row.channel] ?? CHART_COMPARISON_COLOR,
                  }}
                />
                <span className={styles.channelText}>{row.label}</span>
              </span>
              <span className={styles.channelAmount}>{dollars(row.ty)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ProductBars({ rows }: { rows: ProductChartRow[] }) {
  const max = Math.max(
    1,
    ...rows.flatMap((row) => [Math.max(row.ty, 0), Math.max(row.ly, 0)]),
  );
  return (
    <div className={styles.productBars}>
      {rows.map((row) => {
        const tyWidth = `${Math.max(0, (row.ty / max) * 100)}%`;
        const lyWidth = `${Math.max(0, (row.ly / max) * 100)}%`;
        return (
          <div key={`${row.name}|${row.category ?? ""}`}>
            <div className={styles.productName}>
              {row.category ? `${row.name} · ${row.category}` : row.name}
            </div>
            <div className={styles.productBarRow}>
              <div className={styles.productBarStack}>
                <div className={styles.barTrack}>
                  <div className={styles.barFill} style={{ width: tyWidth }} />
                </div>
                <div
                  className={`${styles.barTrack} ${styles.comparisonBarTrack}`}
                >
                  <div
                    className={`${styles.barFill} ${styles.comparisonBarFill}`}
                    style={{ width: lyWidth }}
                  />
                </div>
              </div>
              <span className={styles.barAmount}>{dollars(row.ty)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TopProductsCard({ rows }: { rows: ProductChartRow[] }) {
  return (
    <section className={styles.chartCard} aria-label="Total sales by product">
      <ChartTitle title="Total sales by product" />
      <ProductBars rows={rows} />
    </section>
  );
}

function AnalyticsCharts({ charts }: { charts: AnalyticsChartSummary }) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  const currentLabel = rangeLabel(charts.range);
  const comparisonLabel = rangeLabel(charts.comparisonRange);

  return (
    <div className={styles.chartGrid}>
      <LineMetricCard
        title="Total sales over time"
        metric={charts.totalSales}
        points={charts.salesOverTime}
        currentLabel={currentLabel}
        comparisonLabel={comparisonLabel}
        ready={ready}
        wide
        formatValue={preciseDollars}
      />
      <SalesChannelCard charts={charts} ready={ready} />
      <TopProductsCard rows={charts.topProducts} />
    </div>
  );
}

function PairCells({ pair }: { pair: CellPair }) {
  let change: {
    label: string;
    tone: "success" | "critical" | "neutral";
  } | null;
  if (pair.ly === 0) {
    change = pair.ty === 0 ? null : { label: "New", tone: "success" };
  } else {
    const pct = ((pair.ty - pair.ly) / Math.abs(pair.ly)) * 100;
    change = {
      label: `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(0)}%`,
      tone: pct > 0 ? "success" : pct < 0 ? "critical" : "neutral",
    };
  }
  return (
    <>
      <s-table-cell>{dollars(pair.ty)}</s-table-cell>
      <s-table-cell>{dollars(pair.ly)}</s-table-cell>
      <s-table-cell>
        {change ? <s-badge tone={change.tone}>{change.label}</s-badge> : "—"}
      </s-table-cell>
    </>
  );
}

function ChannelBlock({ report }: { report: WeeklyReport }) {
  const { grand, invoiced, totals } = report;
  const rows: Array<[string, CellPair]> = [
    ["West Village", grand.wv],
    ["East Village", grand.ev],
    ["E-Commerce", grand.ecom],
    ["Invoiced", invoiced],
    ["TOTAL w/o Invoiced", grand.total],
    ["TOTAL w/o E-Comm", totals.woEcom],
    ["TOTAL", totals.all],
  ];
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Channel</s-table-header>
        <s-table-header listSlot="labeled">TY</s-table-header>
        <s-table-header listSlot="labeled">LY</s-table-header>
        <s-table-header listSlot="secondary">% to LY</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {rows.map(([label, pair]) => (
          <s-table-row key={label}>
            <s-table-cell>{label}</s-table-cell>
            <PairCells pair={pair} />
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}

// A blank row gaps the three blocks (categories / section subtotals / group
// roll-ups). s-table has no row-group primitive, so an empty row is how we
// space them while staying one aligned table — like the manual's blank lines.
function SpacerRow({ columns }: { columns: number }) {
  return (
    <s-table-row>
      {Array.from({ length: columns }, (_, i) => (
        <s-table-cell key={i} />
      ))}
    </s-table-row>
  );
}

function CategoryBlock({ report }: { report: WeeklyReport }) {
  const row = (label: string, cells: ChannelCells, key: string = label) => (
    <s-table-row key={key}>
      <s-table-cell>{label}</s-table-cell>
      <PairCells pair={cells.total} />
      <s-table-cell>{dollars(cells.wv.ty)}</s-table-cell>
      <s-table-cell>{dollars(cells.ev.ty)}</s-table-cell>
      <s-table-cell>{dollars(cells.ecom.ty)}</s-table-cell>
    </s-table-row>
  );
  // Categories, section subtotals, and group roll-ups each partition every
  // category, so all three blocks foot to the same grand total (invoiced
  // excluded — it isn't categorized).
  const { grand } = report;
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Category</s-table-header>
        <s-table-header listSlot="labeled">TY</s-table-header>
        <s-table-header listSlot="labeled">LY</s-table-header>
        <s-table-header listSlot="secondary">% to LY</s-table-header>
        <s-table-header listSlot="labeled">WV TY</s-table-header>
        <s-table-header listSlot="labeled">EV TY</s-table-header>
        <s-table-header listSlot="labeled">Web TY</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {report.categories.map((c) => row(c.row.key, c))}
        {row("TOTAL", grand, "total-categories")}
        <SpacerRow key="gap-subtotals" columns={7} />
        {row("Total Retail", report.sections.retail)}
        {row("Total Service", report.sections.service)}
        {row("Others", report.sections.others)}
        {row("TOTAL", grand, "total-sections")}
        <SpacerRow key="gap-rollups" columns={7} />
        {report.groups.map((g) => row(`TTL ${g.group}`, g))}
        {row("TOTAL", grand, "total-groups")}
      </s-table-body>
    </s-table>
  );
}

// Mix view of the weekly report: each row's share of its column's TY net.
// Columns are TOTAL (WV+EV+Web), STRS (WV+EV), WV, EV, WEB — invoiced is
// uncategorized so it never appears here. Whole-percent to match the manual
// template; the category, section, and group blocks each sum to ~100% down a
// column.
function distPct(value: number, denom: number): string {
  if (denom === 0) return "0%";
  return `${Math.round((value / denom) * 100)}%`;
}

function DistributionBlock({ report }: { report: WeeklyReport }) {
  const { grand } = report;
  const denom = {
    total: grand.total.ty,
    strs: grand.wv.ty + grand.ev.ty,
    wv: grand.wv.ty,
    ev: grand.ev.ty,
    web: grand.ecom.ty,
  };
  const row = (label: string, c: ChannelCells, key: string = label) => (
    <s-table-row key={key}>
      <s-table-cell>{label}</s-table-cell>
      <s-table-cell>{distPct(c.total.ty, denom.total)}</s-table-cell>
      <s-table-cell>{distPct(c.wv.ty + c.ev.ty, denom.strs)}</s-table-cell>
      <s-table-cell>{distPct(c.wv.ty, denom.wv)}</s-table-cell>
      <s-table-cell>{distPct(c.ev.ty, denom.ev)}</s-table-cell>
      <s-table-cell>{distPct(c.ecom.ty, denom.web)}</s-table-cell>
    </s-table-row>
  );
  // The section and group blocks each partition every category, so each foots
  // to 100% per column — a TOTAL row confirms the mix adds up.
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Category</s-table-header>
        <s-table-header listSlot="labeled">TOTAL</s-table-header>
        <s-table-header listSlot="labeled">STRS</s-table-header>
        <s-table-header listSlot="labeled">WV</s-table-header>
        <s-table-header listSlot="labeled">EV</s-table-header>
        <s-table-header listSlot="labeled">WEB</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {report.categories.map((c) => row(c.row.key, c))}
        <SpacerRow key="gap-subtotals" columns={6} />
        {row("Total Retail", report.sections.retail)}
        {row("Total Service", report.sections.service)}
        {row("Others", report.sections.others)}
        {row("TOTAL", grand, "total-sections")}
        <SpacerRow key="gap-rollups" columns={6} />
        {report.groups.map((g) => row(`TTL ${g.group}`, g))}
        {row("TOTAL", grand, "total-groups")}
      </s-table-body>
    </s-table>
  );
}

function Top10Block({ report }: { report: Top10Report }) {
  const channelLabel: Record<string, string> = {
    WV: "West Village",
    EV: "East Village",
    ECOM: "E-commerce",
    ALL: "All channels",
  };
  return (
    <s-stack direction="block" gap="large">
      {report.channels.map((channel) => (
        <s-stack key={channel.channel} direction="block" gap="base">
          <s-box padding="base">
            <s-heading>
              {channelLabel[channel.channel] ?? channel.channel}
            </s-heading>
          </s-box>
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Category</s-table-header>
              <s-table-header listSlot="labeled">TY</s-table-header>
              <s-table-header listSlot="labeled">LY</s-table-header>
              <s-table-header listSlot="secondary">% to LY</s-table-header>
              <s-table-header listSlot="labeled">TY % pen</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {channel.categories.map((category) => (
                <s-table-row key={category.category}>
                  <s-table-cell>{category.category}</s-table-cell>
                  <PairCells pair={{ ty: category.ty, ly: category.ly }} />
                  <s-table-cell>
                    {`${(category.tyPenetration * 100).toFixed(0)}%`}
                  </s-table-cell>
                </s-table-row>
              ))}
              <s-table-row>
                <s-table-cell>TOTAL</s-table-cell>
                <PairCells
                  pair={{ ty: channel.totalTy, ly: channel.totalLy }}
                />
                <s-table-cell>100%</s-table-cell>
              </s-table-row>
            </s-table-body>
          </s-table>
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="kicker">#</s-table-header>
              <s-table-header listSlot="primary">Top 10 items</s-table-header>
              <s-table-header listSlot="secondary">Variation</s-table-header>
              <s-table-header listSlot="labeled">Net $</s-table-header>
              <s-table-header listSlot="labeled">Units</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {channel.topOverall.map((item, index) => (
                <s-table-row key={`${item.name}|${item.variation}`}>
                  <s-table-cell>{index + 1}</s-table-cell>
                  <s-table-cell>{item.name}</s-table-cell>
                  <s-table-cell>{item.variation ?? "—"}</s-table-cell>
                  <s-table-cell>{dollars(item.net)}</s-table-cell>
                  <s-table-cell>{item.units}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-stack>
      ))}
    </s-stack>
  );
}

function UnitsBySizeBlock({ report }: { report: UnitsBySizeReport }) {
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="kicker">Style #</s-table-header>
        <s-table-header listSlot="primary">Tea</s-table-header>
        {SIZE_COLUMNS.map((size) => (
          <s-table-header key={size} listSlot="labeled">
            {size}
          </s-table-header>
        ))}
        <s-table-header listSlot="secondary">Total</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {report.rows
          .filter((row) => row.totalUnits !== 0)
          .map((row) => (
            <s-table-row key={`${row.styleNumber ?? ""}|${row.name}`}>
              <s-table-cell>{row.styleNumber ?? "—"}</s-table-cell>
              <s-table-cell>{row.name}</s-table-cell>
              {SIZE_COLUMNS.map((size) => (
                <s-table-cell key={size}>{row.total[size] || ""}</s-table-cell>
              ))}
              <s-table-cell>{row.totalUnits}</s-table-cell>
            </s-table-row>
          ))}
      </s-table-body>
    </s-table>
  );
}

function ProductSellingBlock({ report }: { report: ProductSellingReport }) {
  const hasEcom = report.scope.shopifyProductTypes.length > 0;
  return (
    <s-stack direction="block" gap="base">
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">Channel</s-table-header>
          <s-table-header listSlot="labeled">TY Net</s-table-header>
          <s-table-header listSlot="labeled">LY Net</s-table-header>
          <s-table-header listSlot="secondary">% Change</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {(
            [
              ["West Village", report.channelTotals.WV],
              ["East Village", report.channelTotals.EV],
              ...(hasEcom
                ? ([["E-commerce", report.channelTotals.ECOM]] as const)
                : []),
              ["ALL CHANNELS", report.channelTotals.ALL],
            ] as Array<[string, { ty: { net: number }; ly: { net: number } }]>
          ).map(([label, totals]) => (
            <s-table-row key={label}>
              <s-table-cell>{label}</s-table-cell>
              <PairCells pair={{ ty: totals.ty.net, ly: totals.ly.net }} />
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>

      <s-table paginate={false}>
        <s-table-header-row>
          <s-table-header listSlot="kicker">#</s-table-header>
          <s-table-header listSlot="primary">Product</s-table-header>
          <s-table-header listSlot="labeled">TY Net</s-table-header>
          <s-table-header listSlot="labeled">LY Net</s-table-header>
          <s-table-header listSlot="secondary">% Change</s-table-header>
          <s-table-header listSlot="labeled">TY Units</s-table-header>
          <s-table-header listSlot="labeled">LY Units</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {report.rows.map((row, index) => (
            <s-table-row key={row.familyKey}>
              <s-table-cell>{index + 1}</s-table-cell>
              <s-table-cell>{row.name}</s-table-cell>
              <PairCells pair={{ ty: row.ty.net, ly: row.ly.net }} />
              <s-table-cell>{row.ty.units}</s-table-cell>
              <s-table-cell>{row.ly.units}</s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </s-stack>
  );
}

// A card for a full-bleed table. The section drops its padding so the table
// spans edge-to-edge; the heading gets its spacing back through an s-box.
// This is Shopify's recommended workaround — `padding="none"` otherwise glues
// the heading to the corner, and any spacing we add would land *inside* the
// table rather than between the heading and the table.
function TableCard({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <s-section accessibilityLabel={heading} padding="none">
      <s-box padding="base">
        <s-heading>{heading}</s-heading>
      </s-box>
      {children}
    </s-section>
  );
}

export default function Analytics() {
  const {
    type,
    preset,
    range,
    compare,
    sync,
    lineCount,
    stale,
    historical,
    lastSyncedLabel,
    override,
    charts,
    weekly,
    productSelling,
    top10,
    unitsBySize,
  } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();

  // "Refreshing" is driven by the polled SyncState (sync.running), not the
  // fetcher: the action returns immediately and the pulls finish in the
  // background. `starting` bridges the brief gap between submitting and the
  // first poll that sees the sync running.
  const starting = fetcher.state !== "idle";
  const busy = starting || sync.running;

  // Don't let a stale page export un-synced numbers: pause Export until a
  // Refresh clears the stale state, so a downloaded file can never contain
  // numbers the screen is already warning are out of date. Historical ranges
  // aren't stale, and dev override can't sync, so neither is ever blocked.
  const staleBlocksExport = stale && !override;

  // SyncState's done/error rows persist across page loads, so only show this
  // run's result/stall banners after the user actually hit Refresh.
  const [refreshRequested, setRefreshRequested] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  useEffect(() => {
    setRefreshRequested(false);
    setExportError(null);
  }, [range.start, range.end, type]);

  // While a sync runs, re-read the loader so live progress streams in and we
  // notice completion (or a stall).
  useEffect(() => {
    if (!busy) return;
    const interval = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 2500);
    return () => clearInterval(interval);
  }, [busy, revalidator]);
  const actionError =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  const [exporting, setExporting] = useState(false);
  const [weeklyTab, setWeeklyTab] = useState<
    "channel" | "category" | "distribution"
  >("channel");

  const currentParams = () => {
    const params: Record<string, string> = { type, preset };
    if (preset === "custom") {
      params.start = range.start;
      params.end = range.end;
    }
    // Only pin ?compare= once the user explicitly picked one; otherwise each
    // report type keeps its own default comparison.
    const compareParam = searchParams.get("compare");
    if (compareParam) params.compare = compareParam;
    return params;
  };

  const exportXlsx = async (typeOverride?: string) => {
    setExporting(true);
    setExportError(null);
    try {
      const params = currentParams();
      if (typeOverride) params.type = typeOverride;
      const query = new URLSearchParams(params).toString();
      const response = await fetch(`/app/analytics/export?${query}`);
      if (!response.ok) {
        const message =
          response.status === 409
            ? await response.text()
            : `Export failed (${response.status})`;
        setExportError(message);
        return;
      }
      const blob = await response.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      const disposition = response.headers.get("Content-Disposition") ?? "";
      link.download =
        disposition.match(/filename="(.+)"/)?.[1] ?? "report.xlsx";
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  };

  const reportTitle =
    type === "weekly"
      ? "Weekly meeting report"
      : type === "top10"
        ? "Category Top 10"
        : type === "units-by-size"
          ? "Loose Leaf — Units by size"
          : productSelling
            ? `Product selling — ${productSelling.scope.label}`
            : "Report";
  const freshnessText =
    lastSyncedLabel === null
      ? lineCount === 0
        ? override
          ? "No data."
          : "No data yet — click Refresh to pull recent sales (full history needs a backfill)."
        : override
          ? "Sync time unknown."
          : "Click Refresh to update to the latest sales."
      : historical
        ? "Historical period — these numbers are final."
        : stale
          ? override
            ? `Last synced ${lastSyncedLabel}.`
            : `New sales may have come in — last synced ${lastSyncedLabel}. Click Refresh.`
          : `Up to date — last synced ${lastSyncedLabel}.`;

  const refresh = () => {
    setRefreshRequested(true);
    fetcher.submit({ intent: "refresh" }, { method: "post" });
  };

  return (
    <s-page
      heading="Analytics"
      // subheading renders as title metadata ("Last synced …") but is missing
      // from polaris-types' React props (present in the runtime and base types).
      {...(lastSyncedLabel
        ? { subheading: `Last synced ${lastSyncedLabel}` }
        : {})}
    >
      {/* Title-bar actions are re-rendered by the admin host from a small
          {label, icon, disabled} payload — labeled buttons render natively,
          icon-only ones don't. */}
      <s-button
        slot="primary-action"
        disabled={exporting || lineCount === 0 || staleBlocksExport}
        loading={exporting}
        onClick={() => void exportXlsx()}
      >
        Export .xlsx
      </s-button>
      <s-button slot="secondary-actions" commandFor="analytics-more-actions">
        More actions
      </s-button>
      <s-menu id="analytics-more-actions" accessibilityLabel="More actions">
        <s-button
          disabled={exporting || lineCount === 0 || staleBlocksExport}
          onClick={() => void exportXlsx("all")}
        >
          Export all reports
        </s-button>
      </s-menu>
      {override && (
        <s-banner tone="info">
          {`Reading data for ${override} (ANALYTICS_SHOP_OVERRIDE) — syncs disabled.`}
        </s-banner>
      )}

      {/* Native-analytics-style data controls: date range + comparison float
          bare under the title bar (like native analytics); the report picker
          and freshness/sync status live in the card below. Everything applies
          immediately (navigates) — there is no staged View. */}
      <s-box paddingBlockEnd="base">
        <s-stack direction="inline" gap="small" alignItems="end">
          <PeriodPicker
            preset={preset}
            range={range}
            onApply={(nextPreset, nextRange) => {
              const params = currentParams();
              params.preset = nextPreset;
              delete params.start;
              delete params.end;
              if (nextPreset === "custom") {
                params.start = nextRange.start;
                params.end = nextRange.end;
              }
              setSearchParams(params);
            }}
          />
          {type !== "units-by-size" && (
            <ComparisonPicker
              compare={compare}
              range={range}
              onSelect={(mode) =>
                setSearchParams({ ...currentParams(), compare: mode })
              }
            />
          )}
          <s-button
            icon="refresh"
            disabled={Boolean(override) || busy || !stale}
            loading={busy}
            onClick={refresh}
          >
            Refresh
          </s-button>
        </s-stack>
      </s-box>

      <s-section accessibilityLabel="Report controls">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-select
              label="Report type"
              labelAccessibilityVisibility="exclusive"
              value={type}
              onChange={(event) =>
                setSearchParams({
                  ...currentParams(),
                  type: (event.target as HTMLSelectElement).value,
                })
              }
            >
              <s-option value="weekly">Weekly meeting report</s-option>
              {PRODUCT_REPORT_SCOPES.map((scope) => (
                <s-option key={scope.key} value={`product-${scope.key}`}>
                  {`Product selling — ${scope.label}`}
                </s-option>
              ))}
              <s-option value="top10">Category Top 10</s-option>
              <s-option value="units-by-size">
                Loose Leaf — Units by size
              </s-option>
            </s-select>
          </s-stack>
          {stale ? (
            <s-text tone="critical">{freshnessText}</s-text>
          ) : (
            <s-text color="subdued">{freshnessText}</s-text>
          )}
          {staleBlocksExport && (
            <s-text color="subdued">
              Export is paused until you refresh, so a downloaded file cannot
              contain stale numbers.
            </s-text>
          )}
          {busy && (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-spinner accessibilityLabel="Refreshing" size="base" />
              <s-text color="subdued">{sync.progress || "Refreshing…"}</s-text>
            </s-stack>
          )}
          {actionError && <s-banner tone="critical">{actionError}</s-banner>}
          {exportError && <s-banner tone="warning">{exportError}</s-banner>}
          {refreshRequested && sync.stalled && (
            <s-banner tone="warning">
              The sync stopped before finishing — it likely hit the time limit
              for a single request. Try a smaller date range, or click Refresh
              to resume (already-pulled data is kept).
            </s-banner>
          )}
          {refreshRequested &&
            !busy &&
            !sync.stalled &&
            sync.results.length > 0 && (
              <s-banner
                tone={
                  sync.results.every((result) => result.ok)
                    ? "success"
                    : "critical"
                }
              >
                {sync.results
                  .map((result) => `${result.source}: ${result.message}`)
                  .join(" · ")}
              </s-banner>
            )}
        </s-stack>
      </s-section>

      {weekly ? (
        // One card, three tabs. The tables have different column counts
        // (channel / category / distribution); a segmented tab bar keeps each
        // in its own view so the width never jumps between stacked tables.
        <s-section accessibilityLabel="Weekly report" padding="none">
          <s-box padding="small">
            <s-stack direction="inline" gap="small-200">
              {(
                [
                  ["channel", "Channel"],
                  ["category", "Category"],
                  ["distribution", "Distribution"],
                ] as const
              ).map(([key, label]) => {
                // No tabs primitive in Polaris web components. Match the admin
                // Polaris-Tabs look: every tab is the same tertiary button; the
                // selected one only differs by the hover-grey pill behind it
                // (subdued background) — the text styling is identical.
                const active = weeklyTab === key;
                return (
                  <s-box
                    key={key}
                    background={active ? "strong" : undefined}
                    borderRadius="base"
                  >
                    <s-button
                      variant="tertiary"
                      onClick={() => setWeeklyTab(key)}
                    >
                      {label}
                    </s-button>
                  </s-box>
                );
              })}
            </s-stack>
          </s-box>
          {weeklyTab === "channel" ? (
            <ChannelBlock report={weekly} />
          ) : weeklyTab === "category" ? (
            <CategoryBlock report={weekly} />
          ) : (
            <DistributionBlock report={weekly} />
          )}
        </s-section>
      ) : (
        <TableCard heading={reportTitle}>
          {productSelling ? (
            <ProductSellingBlock report={productSelling} />
          ) : top10 ? (
            <Top10Block report={top10} />
          ) : unitsBySize ? (
            <UnitsBySizeBlock report={unitsBySize} />
          ) : (
            <s-box padding="base">
              <s-paragraph>No sales recorded for this selection.</s-paragraph>
            </s-box>
          )}
        </TableCard>
      )}

      {charts && <AnalyticsCharts charts={charts} />}
    </s-page>
  );
}
