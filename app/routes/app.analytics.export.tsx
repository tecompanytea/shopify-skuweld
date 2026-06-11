import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { resolveAnalyticsShop, resolveRange } from "../.server/analytics/request";
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

  let buffer: Buffer;
  let filename: string;
  if (type === "weekly") {
    const report = await computeWeeklyReport(shop, range);
    buffer = await buildWeeklyWorkbook(report);
    filename = `Weekly Report ${range.start} - ${range.end}.xlsx`;
  } else if (type.startsWith("product-")) {
    const report = await computeProductSellingReport(
      shop,
      type.slice("product-".length),
      range,
    );
    buffer = await buildProductSellingWorkbook(report);
    filename = `Product Selling ${report.scope.label} ${range.start} - ${range.end}.xlsx`;
  } else if (type === "top10") {
    const report = await computeTop10Report(shop, range);
    buffer = await buildTop10Workbook(report);
    filename = `Category Top10 ${range.start} - ${range.end}.xlsx`;
  } else if (type === "units-by-size") {
    const report = await computeUnitsBySizeReport(shop, range);
    buffer = await buildUnitsBySizeWorkbook(report);
    filename = `Loose Leaf Units by Size ${range.start} - ${range.end}.xlsx`;
  } else if (type === "all") {
    const weekly = await computeWeeklyReport(shop, range);
    const products = [];
    for (const scope of PRODUCT_REPORT_SCOPES) {
      products.push(await computeProductSellingReport(shop, scope.key, range));
    }
    const top10 = await computeTop10Report(shop, range);
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
