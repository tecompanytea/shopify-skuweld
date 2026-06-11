import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncSquareOrders } from "../.server/analytics/square-sync";
import { syncShopifyOrders } from "../.server/analytics/shopify-sync";
import {
  computeWeeklyReport,
  type CellPair,
  type WeeklyReport,
} from "../.server/analytics/weekly-report";
import { toReportDay, shiftDay, type DayRange } from "../.server/analytics/periods";

// Last full Mon-Sun week before today (report timezone).
function defaultRange(): DayRange {
  const today = toReportDay(new Date());
  const dayOfWeek = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0=Sun
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const thisMonday = shiftDay(today, -daysSinceMonday);
  return { start: shiftDay(thisMonday, -7), end: shiftDay(thisMonday, -1) };
}

function requestedRange(request: Request): DayRange {
  const url = new URL(request.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (start && /^\d{4}-\d{2}-\d{2}$/.test(start) && end && /^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return { start, end };
  }
  return defaultRange();
}

// Local development can read another shop's already-synced data (the real
// store's fact table in the shared DB) without being installed there:
// set ANALYTICS_SHOP_OVERRIDE in .env. Dev-only, and reads only — sync
// actions are blocked under the override so dev-store orders can never be
// written into the real shop's rows.
function analyticsShopOverride(): string | null {
  return process.env.NODE_ENV === "development"
    ? (process.env.ANALYTICS_SHOP_OVERRIDE ?? null)
    : null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const override = analyticsShopOverride();
  const shop = override ?? session.shop;
  const range = requestedRange(request);

  const [syncStates, lineCount] = await Promise.all([
    prisma.syncState.findMany({ where: { shop } }),
    prisma.salesLine.count({ where: { shop } }),
  ]);

  const report = lineCount > 0 ? await computeWeeklyReport(shop, range) : null;

  return { range, syncStates, lineCount, report, override };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  if (analyticsShopOverride()) {
    return {
      error:
        "ANALYTICS_SHOP_OVERRIDE is active (read-only). Run syncs from the real store or the reconcile script.",
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

function pctToLY(pair: CellPair): string {
  if (pair.ly === 0) return pair.ty === 0 ? "—" : "New";
  return `${(((pair.ty - pair.ly) / Math.abs(pair.ly)) * 100).toFixed(1)}%`;
}

function PairCells({ pair }: { pair: CellPair }) {
  return (
    <>
      <s-table-cell>{dollars(pair.ty)}</s-table-cell>
      <s-table-cell>{dollars(pair.ly)}</s-table-cell>
      <s-table-cell>{pctToLY(pair)}</s-table-cell>
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
        <s-table-row>
          <s-table-cell>Total Retail</s-table-cell>
          <PairCells pair={report.sections.retail} />
          <s-table-cell />
          <s-table-cell />
          <s-table-cell />
        </s-table-row>
        <s-table-row>
          <s-table-cell>Total Service</s-table-cell>
          <PairCells pair={report.sections.service} />
          <s-table-cell />
          <s-table-cell />
          <s-table-cell />
        </s-table-row>
        <s-table-row>
          <s-table-cell>Others</s-table-cell>
          <PairCells pair={report.sections.others} />
          <s-table-cell />
          <s-table-cell />
          <s-table-cell />
        </s-table-row>
        {report.groups.map((g) => (
          <s-table-row key={g.group}>
            <s-table-cell>{`TTL ${g.group}`}</s-table-cell>
            <PairCells pair={g.total} />
            <s-table-cell />
            <s-table-cell />
            <s-table-cell />
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}

export default function Analytics() {
  const { range, syncStates, lineCount, report, override } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const synced =
    fetcher.data && "synced" in fetcher.data ? fetcher.data.synced : null;

  const submitSync = (intent: string) => {
    const start = (document.getElementById("sync-start") as HTMLInputElement)
      ?.value;
    const end = (document.getElementById("sync-end") as HTMLInputElement)?.value;
    fetcher.submit({ intent, start, end }, { method: "post" });
  };

  return (
    <s-page heading="Analytics">
      {override && (
        <s-banner tone="info">
          {`Reading data for ${override} (ANALYTICS_SHOP_OVERRIDE) — syncs disabled.`}
        </s-banner>
      )}
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
              onClick={() => submitSync("sync-square")}
            >
              Sync Square
            </s-button>
            <s-button
              disabled={busy}
              loading={busy}
              onClick={() => submitSync("sync-shopify")}
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
            <s-text key={state.id} color="subdued">
              {`${state.id.split(":")[1]}: ${state.status}${state.progress ? ` — ${state.progress}` : ""}${state.error ? ` — ${state.error}` : ""}`}
            </s-text>
          ))}
        </s-stack>
      </s-section>

      <s-section
        heading={`Weekly report · ${range.start} → ${range.end}`}
        accessibilityLabel="Weekly report"
        padding="none"
      >
        {report ? (
          <s-stack direction="block" gap="base">
            <s-box padding="base">
              <s-text color="subdued">
                {`Compared to ${report.lyRange.start} → ${report.lyRange.end} (weekday-aligned last year). Change the window with ?start=YYYY-MM-DD&end=YYYY-MM-DD.`}
              </s-text>
            </s-box>
            <ChannelBlock report={report} />
            <CategoryBlock report={report} />
          </s-stack>
        ) : (
          <s-box padding="base">
            <s-paragraph>
              No data yet — run the syncs above, then reload.
            </s-paragraph>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}
