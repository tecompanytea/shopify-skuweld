import { useEffect, useState } from "react";
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
import { syncSquareOrders } from "../.server/analytics/square-sync";
import { syncShopifyOrders } from "../.server/analytics/shopify-sync";
import {
  analyticsShopOverride,
  resolveAnalyticsShop,
  resolveRange,
} from "../.server/analytics/request";
import {
  computeWeeklyReport,
  type CellPair,
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
import { SIZE_COLUMNS } from "../lib/analytics-scopes";
import { PRODUCT_REPORT_SCOPES } from "../lib/analytics-scopes";
import type { DayRange } from "../.server/analytics/periods";

const PRESETS = [
  { value: "last-week", label: "Last full week (Mon–Sun)" },
  { value: "mtd", label: "Month to date" },
  { value: "qtd", label: "Quarter to date" },
  { value: "ytd", label: "Year to date" },
  { value: "rolling-12m", label: "Rolling 12 months" },
  { value: "custom", label: "Custom range" },
] as const;

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
    syncStates,
    lineCount,
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
  const intent = form.get("intent");
  const start = String(form.get("start") ?? "");
  const end = String(form.get("end") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return { error: "Enter dates as YYYY-MM-DD." };
  }
  const range: DayRange = { start, end };

  try {
    if (intent === "sync-square") {
      const result = await syncSquareOrders(session.shop, range);
      return { synced: { source: "Square", ...result } };
    }
    if (intent === "sync-shopify") {
      const result = await syncShopifyOrders(session.shop, admin, range);
      return { synced: { source: "Shopify", ...result } };
    }
  } catch (error) {
    return { error: String(error) };
  }
  return { error: "Unknown action" };
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
  });
}

function PairCells({ pair }: { pair: CellPair }) {
  let change: { label: string; tone: "success" | "critical" | "neutral" } | null;
  if (pair.ly === 0) {
    change = pair.ty === 0 ? null : { label: "New", tone: "success" };
  } else {
    const pct = ((pair.ty - pair.ly) / Math.abs(pair.ly)) * 100;
    change = {
      label: `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(1)}%`,
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

function CategoryBlock({ report }: { report: WeeklyReport }) {
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
        {report.categories.map((c) => (
          <s-table-row key={c.row.key}>
            <s-table-cell>{c.row.key}</s-table-cell>
            <PairCells pair={c.total} />
            <s-table-cell>{dollars(c.wv.ty)}</s-table-cell>
            <s-table-cell>{dollars(c.ev.ty)}</s-table-cell>
            <s-table-cell>{dollars(c.ecom.ty)}</s-table-cell>
          </s-table-row>
        ))}
        {(
          [
            ["Total Retail", report.sections.retail],
            ["Total Service", report.sections.service],
            ["Others", report.sections.others],
            ...report.groups.map(
              (g) => [`TTL ${g.group}`, g.total] as [string, CellPair],
            ),
          ] as Array<[string, CellPair]>
        ).map(([label, pair]) => (
          <s-table-row key={label}>
            <s-table-cell>{label}</s-table-cell>
            <PairCells pair={pair} />
            <s-table-cell />
            <s-table-cell />
            <s-table-cell />
          </s-table-row>
        ))}
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
                    {`${(category.tyPenetration * 100).toFixed(1)}%`}
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

export default function Analytics() {
  const {
    type,
    preset,
    range,
    syncStates,
    lineCount,
    override,
    weekly,
    productSelling,
    top10,
    unitsBySize,
  } = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const revalidator = useRevalidator();

  // While a sync runs, re-read the loader so the live progress written to
  // SyncState ("1,396 orders, 3,532 lines so far…") streams into the page.
  useEffect(() => {
    if (!busy) return;
    const interval = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 2500);
    return () => clearInterval(interval);
  }, [busy, revalidator]);
  const synced =
    fetcher.data && "synced" in fetcher.data ? fetcher.data.synced : null;

  const [pickedType, setPickedType] = useState(type);
  const [pickedPreset, setPickedPreset] = useState(preset);
  const [customStart, setCustomStart] = useState(range.start);
  const [customEnd, setCustomEnd] = useState(range.end);
  const [exporting, setExporting] = useState(false);

  const currentParams = () => {
    const params: Record<string, string> = {
      type: pickedType,
      preset: pickedPreset,
    };
    if (pickedPreset === "custom") {
      params.start = customStart;
      params.end = customEnd;
    }
    return params;
  };

  const exportXlsx = async (typeOverride?: string) => {
    setExporting(true);
    try {
      const params = currentParams();
      if (typeOverride) params.type = typeOverride;
      const query = new URLSearchParams(params).toString();
      const response = await fetch(`/app/analytics/export?${query}`);
      if (!response.ok) throw new Error(`Export failed (${response.status})`);
      const blob = await response.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      const disposition = response.headers.get("Content-Disposition") ?? "";
      link.download =
        disposition.match(/filename="(.+)"/)?.[1] ?? "report.xlsx";
      link.click();
      URL.revokeObjectURL(link.href);
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
            <s-select
              label="Period"
              value={pickedPreset}
              onChange={(event) =>
                setPickedPreset((event.target as HTMLSelectElement).value)
              }
            >
              {PRESETS.map((p) => (
                <s-option key={p.value} value={p.value}>
                  {p.label}
                </s-option>
              ))}
            </s-select>
            <s-button
              variant="primary"
              onClick={() => setSearchParams(currentParams())}
            >
              View
            </s-button>
            <s-button
              disabled={exporting || lineCount === 0}
              loading={exporting}
              onClick={() => void exportXlsx()}
            >
              Export .xlsx
            </s-button>
            <s-button
              variant="secondary"
              disabled={exporting || lineCount === 0}
              onClick={() => void exportXlsx("all")}
            >
              Export all reports
            </s-button>
          </s-stack>
          {pickedPreset === "custom" && (
            <s-box maxInlineSize="360px">
              <s-date-picker
                type="range"
                value={`${customStart}--${customEnd}`}
                onChange={(event) => {
                  const picked = (event.currentTarget as { value?: string })
                    .value;
                  const match = picked?.match(
                    /^(\d{4}-\d{2}-\d{2})--(\d{4}-\d{2}-\d{2})$/,
                  );
                  if (match) {
                    setCustomStart(match[1]);
                    setCustomEnd(match[2]);
                  }
                }}
              />
            </s-box>
          )}
          <s-text color="subdued">
            {`Showing ${range.start} → ${range.end}${
              lyRange
                ? ` · compared to ${lyRange.start} → ${lyRange.end}${
                    type === "weekly" ? " (weekday-aligned)" : " (calendar LY)"
                  }`
                : ""
            }`}
          </s-text>
        </s-stack>
      </s-section>

      <s-section
        heading={reportTitle}
        accessibilityLabel="Report"
        padding="none"
      >
        {weekly ? (
          <s-stack direction="block" gap="base">
            <ChannelBlock report={weekly} />
            <CategoryBlock report={weekly} />
          </s-stack>
        ) : productSelling ? (
          <ProductSellingBlock report={productSelling} />
        ) : top10 ? (
          <Top10Block report={top10} />
        ) : unitsBySize ? (
          <UnitsBySizeBlock report={unitsBySize} />
        ) : (
          <s-box padding="base">
            <s-paragraph>
              No data yet — run the syncs below, then reload.
            </s-paragraph>
          </s-box>
        )}
      </s-section>

      <s-section heading="Data sync" accessibilityLabel="Data sync">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            {`${lineCount.toLocaleString("en-US")} sales lines in the local fact table.`}
          </s-paragraph>
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-text-field
              id="sync-start"
              label="From"
              defaultValue="2025-01-01"
              placeholder="YYYY-MM-DD"
            />
            <s-text-field
              id="sync-end"
              label="To"
              defaultValue={range.end}
              placeholder="YYYY-MM-DD"
            />
            <s-button
              disabled={busy}
              loading={busy}
              onClick={() =>
                fetcher.submit(
                  {
                    intent: "sync-square",
                    start: (document.getElementById("sync-start") as HTMLInputElement)?.value,
                    end: (document.getElementById("sync-end") as HTMLInputElement)?.value,
                  },
                  { method: "post" },
                )
              }
            >
              Sync Square
            </s-button>
            <s-button
              disabled={busy}
              loading={busy}
              onClick={() =>
                fetcher.submit(
                  {
                    intent: "sync-shopify",
                    start: (document.getElementById("sync-start") as HTMLInputElement)?.value,
                    end: (document.getElementById("sync-end") as HTMLInputElement)?.value,
                  },
                  { method: "post" },
                )
              }
            >
              Sync Shopify
            </s-button>
          </s-stack>
          {fetcher.data && "error" in fetcher.data && (
            <s-banner tone="critical">{fetcher.data.error}</s-banner>
          )}
          {synced && (
            <s-banner tone="success">
              {`${synced.source}: ${synced.orders.toLocaleString("en-US")} orders → ${synced.lines.toLocaleString("en-US")} lines.`}
            </s-banner>
          )}
          {syncStates.map((state) => (
            <s-stack
              key={state.id}
              direction="inline"
              gap="small-200"
              alignItems="center"
            >
              {state.status === "running" && (
                <s-spinner accessibilityLabel="Sync running" size="base" />
              )}
              <s-text color="subdued">
                {`${state.id.split(":")[1]}: ${state.status}${state.progress ? ` — ${state.progress}` : ""}${state.error ? ` — ${state.error}` : ""}`}
              </s-text>
            </s-stack>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}
