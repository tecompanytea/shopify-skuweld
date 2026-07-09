import prisma from "../../db.server";
import {
  PRODUCT_REPORT_SCOPES,
  type ProductReportScope,
} from "../../lib/analytics-scopes";
import {
  comparisonRange,
  type ComparisonMode,
  type DayRange,
} from "../../lib/periods";
import {
  loadShopifyBridge,
  resolveProductIdentity,
  type IdentityLine,
  type ProductIdentity,
} from "./product-identity";

// Product-selling report: every product in one category, net sales + units,
// TY vs calendar-aligned LY, per channel and combined. Mirrors the manual
// "Product Selling" workbooks' methodology notes:
// - Net = Gross − Discounts, pre-tax, after returns. Square returns arrive as
//   itemized `return_line_items` carrying their own SKU, category and
//   channel, so they net into the product they were returned from — the same
//   rule the Top10, weekly and chart reports already follow.
// - Units are gross units sold (the workbooks' "Units Sold"): a return nets
//   the dollars but not the unit count.
// - Square channels (WV/EV) exclude invoiced orders (channel != INVOICED is
//   structural).
// - Shopify (ECOM) figures come from the agreements ledger, which already
//   nets returns the way Shopify Analytics does.
// - Cross-channel identity: the catalog's own product key, bridged across
//   channels by shared SKU (see ./product-identity).

export interface ProductCell {
  net: number; // cents
  units: number;
}

export interface ProductRow {
  name: string;
  productKey: string;
  ty: ProductCell;
  ly: ProductCell;
  channels: Record<"WV" | "EV" | "ECOM", { ty: ProductCell; ly: ProductCell }>;
}

export interface ProductSellingReport {
  scope: ProductReportScope;
  range: DayRange;
  lyRange: DayRange;
  compare: ComparisonMode;
  rows: ProductRow[];
  channelTotals: Record<
    "WV" | "EV" | "ECOM" | "ALL",
    { ty: ProductCell; ly: ProductCell }
  >;
}

const CHANNELS = ["WV", "EV", "ECOM"] as const;

type ReportLine = IdentityLine & {
  channel: string;
  kind: string;
  quantity: number;
};

interface Accumulator {
  productKey: string;
  cells: Map<string, ProductCell>; // `${channel}:${year}` -> cell
}

async function fetchLines(
  shop: string,
  scope: ProductReportScope,
  range: DayRange,
): Promise<ReportLine[]> {
  return prisma.salesLine.findMany({
    where: {
      shop,
      day: { gte: range.start, lte: range.end },
      OR: [
        ...(scope.squareCategory
          ? [
              {
                source: "square",
                channel: { in: ["WV", "EV"] },
                category: scope.squareCategory,
              },
            ]
          : []),
        ...(scope.shopifyProductTypes.length > 0
          ? [
              {
                source: "shopify",
                category: { in: scope.shopifyProductTypes },
              },
            ]
          : []),
      ],
    },
    select: {
      source: true,
      channel: true,
      kind: true,
      itemName: true,
      variationName: true,
      productKey: true,
      productTitle: true,
      sku: true,
      quantity: true,
      netCents: true,
    },
  });
}

function accumulate(
  lines: ReportLine[],
  year: "ty" | "ly",
  identity: ProductIdentity,
  products: Map<string, Accumulator>,
): void {
  for (const line of lines) {
    const key = identity.keyOf(line);
    let acc = products.get(key);
    if (!acc) {
      acc = { productKey: key, cells: new Map() };
      products.set(key, acc);
    }
    const cellKey = `${line.channel}:${year}`;
    const cell = acc.cells.get(cellKey) ?? { net: 0, units: 0 };
    cell.net += line.netCents;
    if (line.kind === "sale") cell.units += line.quantity;
    acc.cells.set(cellKey, cell);
  }
}

export function productReportScope(key: string): ProductReportScope {
  const scope = PRODUCT_REPORT_SCOPES.find((s) => s.key === key);
  if (!scope) throw new Error(`Unknown product report scope: ${key}`);
  return scope;
}

export async function computeProductSellingReport(
  shop: string,
  scopeKey: string,
  range: DayRange,
  compare: ComparisonMode,
): Promise<ProductSellingReport> {
  const scope = productReportScope(scopeKey);
  const lyRange = comparisonRange(compare, range);
  const [tyLines, lyLines, bridge] = await Promise.all([
    fetchLines(shop, scope, range),
    fetchLines(shop, scope, lyRange),
    loadShopifyBridge(shop),
  ]);

  // One identity over both windows, so a product keeps the same row (and the
  // same label) whether it sold this year, last year, or both.
  const identity = resolveProductIdentity([...tyLines, ...lyLines], bridge);
  const products = new Map<string, Accumulator>();
  accumulate(tyLines, "ty", identity, products);
  accumulate(lyLines, "ly", identity, products);

  const empty = (): ProductCell => ({ net: 0, units: 0 });
  const rows: ProductRow[] = [...products.values()].map((acc) => {
    const get = (channel: string, year: string): ProductCell =>
      acc.cells.get(`${channel}:${year}`) ?? empty();
    const sum = (year: "ty" | "ly"): ProductCell =>
      CHANNELS.reduce(
        (total, channel) => {
          const cell = get(channel, year);
          return { net: total.net + cell.net, units: total.units + cell.units };
        },
        empty(),
      );
    return {
      name: identity.titleOf(acc.productKey),
      productKey: acc.productKey,
      ty: sum("ty"),
      ly: sum("ly"),
      channels: {
        WV: { ty: get("WV", "ty"), ly: get("WV", "ly") },
        EV: { ty: get("EV", "ty"), ly: get("EV", "ly") },
        ECOM: { ty: get("ECOM", "ty"), ly: get("ECOM", "ly") },
      },
    };
  });
  rows.sort((a, b) => b.ty.net - a.ty.net);

  const channelTotals = {
    WV: { ty: empty(), ly: empty() },
    EV: { ty: empty(), ly: empty() },
    ECOM: { ty: empty(), ly: empty() },
    ALL: { ty: empty(), ly: empty() },
  };
  for (const row of rows) {
    for (const channel of CHANNELS) {
      for (const year of ["ty", "ly"] as const) {
        channelTotals[channel][year].net += row.channels[channel][year].net;
        channelTotals[channel][year].units += row.channels[channel][year].units;
        channelTotals.ALL[year].net += row.channels[channel][year].net;
        channelTotals.ALL[year].units += row.channels[channel][year].units;
      }
    }
  }

  return { scope, range, lyRange, compare, rows, channelTotals };
}
