import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  analyticsShopOverride,
  resolveAnalyticsShop,
  resolveComparison,
  resolveRange,
} from "../.server/analytics/request";
import { evaluateFreshness } from "../.server/analytics/freshness";
import { computeWeeklyReport } from "../.server/analytics/weekly-report";
import { computeProductSellingReport } from "../.server/analytics/product-selling-report";
import { computeTop10Report } from "../.server/analytics/top10-report";
import { computeUnitsBySizeReport } from "../.server/analytics/units-by-size-report";
import {
  buildWeeklyWorkbook,
  buildProductSellingWorkbook,
  buildTop10Workbook,
  buildUnitsBySizeWorkbook,
  buildAllReportsWorkbook,
} from "../.server/analytics/export-xlsx";
import { PRODUCT_REPORT_SCOPES } from "../lib/analytics-scopes";

// Resource route: GET /app/analytics/export?type=...&start=...&end=...
// Returns the report as an .xlsx download. Called via App Bridge fetch
// (which injects the session token), then blob-downloaded client-side.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = resolveAnalyticsShop(session.shop);
  const url = new URL(request.url);
  const type = url.searchParams.get("type") ?? "weekly";
  const range = resolveRange(url.searchParams);
  const override = analyticsShopOverride();
  const syncStates = await prisma.syncState.findMany({ where: { shop } });
  const { stale } = evaluateFreshness(shop, syncStates, range, Date.now());
  if (stale && !override) {
    throw new Response(
      "Report data is stale. Click Refresh before exporting.",
      {
        status: 409,
      },
    );
  }

  let buffer: Buffer;
  let filename: string;
  if (type === "weekly") {
    const compare = resolveComparison(url.searchParams, type);
    const report = await computeWeeklyReport(shop, range, compare);
    buffer = await buildWeeklyWorkbook(report);
    filename = `Weekly Report ${range.start} - ${range.end}.xlsx`;
  } else if (type.startsWith("product-")) {
    const compare = resolveComparison(url.searchParams, type);
    const report = await computeProductSellingReport(
      shop,
      type.slice("product-".length),
      range,
      compare,
    );
    buffer = await buildProductSellingWorkbook(report);
    filename = `Product Selling ${report.scope.label} ${range.start} - ${range.end}.xlsx`;
  } else if (type === "top10") {
    const compare = resolveComparison(url.searchParams, type);
    const report = await computeTop10Report(shop, range, compare);
    buffer = await buildTop10Workbook(report);
    filename = `Category Top10 ${range.start} - ${range.end}.xlsx`;
  } else if (type === "units-by-size") {
    const report = await computeUnitsBySizeReport(shop, range);
    buffer = await buildUnitsBySizeWorkbook(report);
    filename = `Loose Leaf Units by Size ${range.start} - ${range.end}.xlsx`;
  } else if (type === "all") {
    // Per-report comparison: an explicit ?compare= applies everywhere, else
    // each report keeps its own default.
    const weekly = await computeWeeklyReport(
      shop,
      range,
      resolveComparison(url.searchParams, "weekly"),
    );
    const products = [];
    for (const scope of PRODUCT_REPORT_SCOPES) {
      products.push(
        await computeProductSellingReport(
          shop,
          scope.key,
          range,
          resolveComparison(url.searchParams, `product-${scope.key}`),
        ),
      );
    }
    const top10 = await computeTop10Report(
      shop,
      range,
      resolveComparison(url.searchParams, "top10"),
    );
    const units = await computeUnitsBySizeReport(shop, range);
    buffer = await buildAllReportsWorkbook(weekly, products, top10, units);
    filename = `Te Company Reports ${range.start} - ${range.end}.xlsx`;
  } else {
    throw new Response(`Unknown report type: ${type}`, { status: 400 });
  }

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
};
