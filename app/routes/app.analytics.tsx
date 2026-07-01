import { useEffect, useState, type ReactNode } from "react";
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
  resolveRange,
} from "../.server/analytics/request";
import { evaluateFreshness } from "../.server/analytics/freshness";
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
import { toReportDay } from "../lib/periods";
import { PeriodPicker } from "../components/period-picker";

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
  const lastSyncedLabel = lastSyncedAt ? refreshedLabel(lastSyncedAt, now) : null;
  const sync = summarizeSync(shop, syncStates, now);

  let weekly: WeeklyReport | null = null;
  let productSelling: ProductSellingReport | null = null;
  let top10: Top10Report | null = null;
  let unitsBySize: UnitsBySizeReport | null = null;
  if (lineCount > 0) {
    if (type === "weekly") {
      weekly = await computeWeeklyReport(shop, range);
    } else if (type.startsWith("product-")) {
      productSelling = await computeProductSellingReport(
        shop,
        type.slice("product-".length),
        range,
      );
    } else if (type === "top10") {
      top10 = await computeTop10Report(shop, range);
    } else if (type === "units-by-size") {
      unitsBySize = await computeUnitsBySizeReport(shop, range);
    }
  }

  return {
    type,
    preset,
    range,
    sync,
    lineCount,
    stale,
    historical,
    lastSyncedLabel,
    override,
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

function PairCells({ pair }: { pair: CellPair }) {
  let change: { label: string; tone: "success" | "critical" | "neutral" } | null;
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
        {change ? (
          <s-badge tone={change.tone}>{change.label}</s-badge>
        ) : (
          "—"
        )}
      </s-table-cell>
    </>
  );
}

function ChannelBlock({ report }: { report: WeeklyReport }) {
  const { channels } = report;
  const totals = {
    woInv: {
      ty: channels.wv.ty + channels.ev.ty + channels.ecom.ty,
      ly: channels.wv.ly + channels.ev.ly + channels.ecom.ly,
    },
    woEcom: {
      ty: channels.wv.ty + channels.ev.ty + channels.invoiced.ty,
      ly: channels.wv.ly + channels.ev.ly + channels.invoiced.ly,
    },
    all: {
      ty: channels.wv.ty + channels.ev.ty + channels.ecom.ty + channels.invoiced.ty,
      ly: channels.wv.ly + channels.ev.ly + channels.ecom.ly + channels.invoiced.ly,
    },
  };
  const rows: Array<[string, CellPair]> = [
    ["West Village", channels.wv],
    ["East Village", channels.ev],
    ["E-Commerce", channels.ecom],
    ["Invoiced", channels.invoiced],
    ["TOTAL w/o Invoiced", totals.woInv],
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
  const grand: ChannelCells = {
    total: {
      ty: report.channels.wv.ty + report.channels.ev.ty + report.channels.ecom.ty,
      ly: report.channels.wv.ly + report.channels.ev.ly + report.channels.ecom.ly,
    },
    wv: report.channels.wv,
    ev: report.channels.ev,
    ecom: report.channels.ecom,
  };
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
  const { channels } = report;
  const denom = {
    total: channels.wv.ty + channels.ev.ty + channels.ecom.ty,
    strs: channels.wv.ty + channels.ev.ty,
    wv: channels.wv.ty,
    ev: channels.ev.ty,
    web: channels.ecom.ty,
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
  const grand: ChannelCells = {
    total: {
      ty: channels.wv.ty + channels.ev.ty + channels.ecom.ty,
      ly: channels.wv.ly + channels.ev.ly + channels.ecom.ly,
    },
    wv: channels.wv,
    ev: channels.ev,
    ecom: channels.ecom,
  };
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
            <s-heading>{channelLabel[channel.channel] ?? channel.channel}</s-heading>
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
                <PairCells pair={{ ty: channel.totalTy, ly: channel.totalLy }} />
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
            ] as Array<
              [string, { ty: { net: number }; ly: { net: number } }]
            >
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
    sync,
    lineCount,
    stale,
    historical,
    lastSyncedLabel,
    override,
    weekly,
    productSelling,
    top10,
    unitsBySize,
  } = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
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

  const [pickedType, setPickedType] = useState(type);
  const [exporting, setExporting] = useState(false);
  const [weeklyTab, setWeeklyTab] = useState<
    "channel" | "category" | "distribution"
  >("channel");

  const currentParams = () => {
    const params: Record<string, string> = { type: pickedType, preset };
    if (preset === "custom") {
      params.start = range.start;
      params.end = range.end;
    }
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
          : (productSelling
              ? `Product selling — ${productSelling.scope.label}`
              : "Report");
  const lyRange = weekly?.lyRange ?? productSelling?.lyRange ?? top10?.lyRange ?? null;

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
    <s-page heading="Analytics">
      {override && (
        <s-banner tone="info">
          {`Reading data for ${override} (ANALYTICS_SHOP_OVERRIDE) — syncs disabled.`}
        </s-banner>
      )}

      <s-section heading="Report" accessibilityLabel="Report picker">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-select
              label="Report type"
              value={pickedType}
              onChange={(event) =>
                setPickedType((event.target as HTMLSelectElement).value)
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
            <PeriodPicker
              preset={preset}
              range={range}
              onApply={(nextPreset, nextRange) => {
                const params: Record<string, string> = {
                  type: pickedType,
                  preset: nextPreset,
                };
                if (nextPreset === "custom") {
                  params.start = nextRange.start;
                  params.end = nextRange.end;
                }
                setSearchParams(params);
              }}
            />
            <s-button
              variant="primary"
              onClick={() => setSearchParams(currentParams())}
            >
              View
            </s-button>
            <s-button
              disabled={exporting || lineCount === 0 || staleBlocksExport}
              loading={exporting}
              onClick={() => void exportXlsx()}
            >
              Export .xlsx
            </s-button>
            <s-button
              variant="secondary"
              disabled={exporting || lineCount === 0 || staleBlocksExport}
              onClick={() => void exportXlsx("all")}
            >
              Export all reports
            </s-button>
            <s-button
              icon="refresh"
              variant={stale ? "primary" : "secondary"}
              disabled={Boolean(override) || busy || !stale}
              loading={busy}
              onClick={refresh}
            >
              Refresh
            </s-button>
          </s-stack>
          <s-text color="subdued">
            {`Showing ${range.start} → ${range.end}${
              lyRange
                ? ` · compared to ${lyRange.start} → ${lyRange.end}${
                    type === "weekly" ? " (weekday-aligned)" : " (calendar LY)"
                  }`
                : ""
            }`}
          </s-text>
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
          {refreshRequested && !busy && !sync.stalled && sync.results.length > 0 && (
            <s-banner
              tone={sync.results.every((result) => result.ok) ? "success" : "critical"}
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
              <s-paragraph>
                No sales recorded for this selection.
              </s-paragraph>
            </s-box>
          )}
        </TableCard>
      )}
    </s-page>
  );
}
