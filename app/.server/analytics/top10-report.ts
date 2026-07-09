import prisma from "../../db.server";
import { CATEGORY_ROWS } from "./categories";
import {
  comparisonRange,
  type ComparisonMode,
  type DayRange,
} from "../../lib/periods";
import { loadShopifyBridge, resolveProductIdentity } from "./product-identity";

// Category Top10 weekly report: per channel (stores, web, total), net sales
// by category TY vs weekday-aligned LY with penetration %, plus the top
// products per category ranked by TY net. Mirrors the manual workbook:
// invoiced excluded, gift cards tracked outside categories.
//
// Ranking is by product, not by the order line's item+variation. Those names
// are order-time snapshots, so a renamed POS button ("Mushroom Biscuit" ->
// "Daikon Biscuit") used to rank as two products, every tea size ranked
// separately, and the ALL-channels list ranked each product once per channel
// — "Pineapple Linzer Cookie" was the top seller and appeared nowhere,
// scattered across "Pineapple Linzer Box|1 Box", "|2 Boxes" and
// "Pineapple Linzer|Regular". Product identity fixes all three, and makes
// this report agree with Product Selling.

export interface Top10Item {
  name: string;
  net: number; // cents
  units: number;
}

export interface CategoryTotal {
  category: string;
  ty: number;
  ly: number;
  tyPenetration: number; // share of channel TY total
}

export interface ChannelTop10 {
  channel: string; // WV | EV | ECOM | ALL
  totalTy: number;
  totalLy: number;
  categories: CategoryTotal[];
  topOverall: Top10Item[];
  topByCategory: Record<string, Top10Item[]>;
}

export interface Top10Report {
  range: DayRange;
  lyRange: DayRange;
  compare: ComparisonMode;
  channels: ChannelTop10[];
}

// Map a fact-table line to the report's category vocabulary: Square lines
// already carry Square category names; Shopify lines carry product types
// that translate via the weekly report's category bridge.
const SHOPIFY_TYPE_TO_CATEGORY = new Map(
  CATEGORY_ROWS.filter((row) => row.squareCategory).flatMap((row) =>
    row.shopifyProductTypes.map(
      (type) => [type, row.squareCategory as string] as [string, string],
    ),
  ),
);

function lineCategory(source: string, category: string | null): string {
  if (source === "shopify") {
    return (
      (category && SHOPIFY_TYPE_TO_CATEGORY.get(category)) ??
      (category ? `Web: ${category}` : "Uncategorized")
    );
  }
  return category ?? "Uncategorized";
}

const TOP_N = 10;

export async function computeTop10Report(
  shop: string,
  range: DayRange,
  compare: ComparisonMode,
): Promise<Top10Report> {
  const lyRange = comparisonRange(compare, range);

  // No category filter in SQL: `NOT category = X` would silently drop
  // NULL-category rows (untyped/deleted products). Square gift cards are
  // excluded in JS below.
  const fetch = (window: DayRange) =>
    prisma.salesLine.findMany({
      where: {
        shop,
        day: { gte: window.start, lte: window.end },
        channel: { in: ["WV", "EV", "ECOM"] },
      },
      select: {
        source: true,
        channel: true,
        category: true,
        itemName: true,
        variationName: true,
        productKey: true,
        productTitle: true,
        sku: true,
        netCents: true,
        quantity: true,
        kind: true,
      },
    });
  const [tyLines, lyLines, bridge] = await Promise.all([
    fetch(range),
    fetch(lyRange),
    loadShopifyBridge(shop),
  ]);
  // TY lines only: the item lists rank this year, and one identity across the
  // whole set keeps a product's key stable between channels.
  const identity = resolveProductIdentity(tyLines, bridge);

  interface ItemAcc {
    key: string;
    net: number;
    units: number;
  }
  interface ChannelAcc {
    totalTy: number;
    totalLy: number;
    categoryTy: Map<string, number>;
    categoryLy: Map<string, number>;
    items: Map<string, ItemAcc>; // TY only
    itemsByCategory: Map<string, Map<string, ItemAcc>>;
  }
  const channels = new Map<string, ChannelAcc>();
  const channelAcc = (channel: string): ChannelAcc => {
    let acc = channels.get(channel);
    if (!acc) {
      acc = {
        totalTy: 0,
        totalLy: 0,
        categoryTy: new Map(),
        categoryLy: new Map(),
        items: new Map(),
        itemsByCategory: new Map(),
      };
      channels.set(channel, acc);
    }
    return acc;
  };

  const addItem = (
    map: Map<string, ItemAcc>,
    key: string,
    net: number,
    units: number,
  ) => {
    const item = map.get(key) ?? { key, net: 0, units: 0 };
    item.net += net;
    item.units += units;
    map.set(key, item);
  };

  for (const [year, lines] of [
    ["ty", tyLines],
    ["ly", lyLines],
  ] as const) {
    for (const line of lines) {
      // Square gift cards are liabilities, excluded everywhere; Shopify gift
      // cards stay (Shopify Analytics includes them, and the manual reports
      // followed that).
      if (line.source === "square" && line.category === "Gift Card") continue;
      const category = lineCategory(line.source, line.category);
      // Item "Units" are gross units sold (the workbook's Units Sold
      // column); returns net the dollars but not the unit count.
      const units = line.kind === "sale" ? line.quantity : 0;
      for (const channel of [line.channel, "ALL"]) {
        const acc = channelAcc(channel);
        if (year === "ty") {
          acc.totalTy += line.netCents;
          acc.categoryTy.set(
            category,
            (acc.categoryTy.get(category) ?? 0) + line.netCents,
          );
          const key = identity.keyOf(line);
          addItem(acc.items, key, line.netCents, units);
          let byCategory = acc.itemsByCategory.get(category);
          if (!byCategory) {
            byCategory = new Map();
            acc.itemsByCategory.set(category, byCategory);
          }
          addItem(byCategory, key, line.netCents, units);
        } else {
          acc.totalLy += line.netCents;
          acc.categoryLy.set(
            category,
            (acc.categoryLy.get(category) ?? 0) + line.netCents,
          );
        }
      }
    }
  }

  const top = (map: Map<string, ItemAcc>): Top10Item[] =>
    [...map.values()]
      .sort((a, b) => b.net - a.net)
      .slice(0, TOP_N)
      .map((item) => ({
        name: identity.titleOf(item.key),
        net: item.net,
        units: item.units,
      }));

  const order = ["WV", "EV", "ECOM", "ALL"];
  return {
    range,
    lyRange,
    compare,
    channels: order
      .filter((channel) => channels.has(channel))
      .map((channel) => {
        const acc = channels.get(channel)!;
        const categoryNames = [
          ...new Set([...acc.categoryTy.keys(), ...acc.categoryLy.keys()]),
        ];
        return {
          channel,
          totalTy: acc.totalTy,
          totalLy: acc.totalLy,
          categories: categoryNames
            .map((category) => ({
              category,
              ty: acc.categoryTy.get(category) ?? 0,
              ly: acc.categoryLy.get(category) ?? 0,
              tyPenetration:
                acc.totalTy === 0
                  ? 0
                  : (acc.categoryTy.get(category) ?? 0) / acc.totalTy,
            }))
            .sort((a, b) => b.ty - a.ty),
          topOverall: top(acc.items),
          topByCategory: Object.fromEntries(
            [...acc.itemsByCategory.entries()].map(([category, items]) => [
              category,
              top(items),
            ]),
          ),
        };
      }),
  };
}
