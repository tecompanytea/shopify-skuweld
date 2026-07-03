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
import { productName, skuFamily } from "../../lib/sku-scheme";

// Product-selling report: every product in one category, net sales + units,
// TY vs calendar-aligned LY, per channel and combined. Mirrors the manual
// "Product Selling" workbooks' methodology notes:
// - Net = Gross − Discounts, pre-tax.
// - Square channels (WV/EV) exclude invoiced orders (channel != INVOICED
//   is structural) and do NOT net refunds into product dollars (order-level
//   Square refunds can't be attributed to items; documented in the manuals).
// - Shopify (ECOM) figures come from the agreements ledger, which already
//   nets returns the way Shopify Analytics does.
// - Cross-channel identity: SKU family first (first 4 digits of the 6-digit
//   scheme = category+family, sizes/variants combined), name as fallback.

export interface ProductCell {
  net: number; // cents
  units: number;
}

export interface ProductRow {
  name: string;
  familyKey: string;
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

interface Accumulator {
  name: string;
  familyKey: string;
  cells: Map<string, ProductCell>; // `${channel}:${year}` -> cell
}

async function accumulate(
  shop: string,
  scope: ProductReportScope,
  range: DayRange,
  year: "ty" | "ly",
  products: Map<string, Accumulator>,
): Promise<void> {
  const lines = await prisma.salesLine.findMany({
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
                // Square product dollars exclude refunds (see header note).
                kind: "sale",
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
      channel: true,
      itemName: true,
      variationName: true,
      sku: true,
      quantity: true,
      netCents: true,
    },
  });

  for (const line of lines) {
    const name = productName(line.itemName, line.variationName);
    const family = skuFamily(line.sku);
    const key = family ?? `name:${name.toLowerCase()}`;
    let acc = products.get(key);
    if (!acc) {
      acc = { name, familyKey: key, cells: new Map() };
      products.set(key, acc);
    }
    const cellKey = `${line.channel}:${year}`;
    const cell = acc.cells.get(cellKey) ?? { net: 0, units: 0 };
    cell.net += line.netCents;
    cell.units += line.quantity;
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
  const products = new Map<string, Accumulator>();
  await accumulate(shop, scope, range, "ty", products);
  await accumulate(shop, scope, lyRange, "ly", products);

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
      name: acc.name,
      familyKey: acc.familyKey,
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
