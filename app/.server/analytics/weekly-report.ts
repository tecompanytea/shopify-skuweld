import prisma from "../../db.server";
import { CATEGORY_ROWS, type CategoryRow } from "./categories";
import { weekdayAlignedLastYear, type DayRange } from "../../lib/periods";

// Computes the Weekly Meeting Report: net sales by channel and by category,
// this-year vs weekday-aligned last-year. Reproduces the manual template:
// store channels come from Square (invoiced excluded), e-commerce from
// Shopify by product type, invoiced from Square invoices.

export interface CellPair {
  ty: number; // cents
  ly: number; // cents
}

export interface CategoryReportRow {
  row: CategoryRow;
  total: CellPair;
  wv: CellPair;
  ev: CellPair;
  ecom: CellPair;
}

export interface WeeklyReport {
  range: DayRange;
  lyRange: DayRange;
  channels: {
    wv: CellPair;
    ev: CellPair;
    ecom: CellPair;
    invoiced: CellPair;
  };
  categories: CategoryReportRow[];
  sections: {
    retail: CellPair;
    service: CellPair;
    others: CellPair;
  };
  groups: Array<{ group: string; total: CellPair }>;
}

interface Sums {
  // channel -> category -> net cents
  byChannelCategory: Map<string, Map<string, number>>;
  byChannel: Map<string, number>;
}

async function sumRange(shop: string, range: DayRange): Promise<Sums> {
  const grouped = await prisma.salesLine.groupBy({
    by: ["channel", "category"],
    where: { shop, day: { gte: range.start, lte: range.end } },
    _sum: { netCents: true },
  });
  const byChannelCategory = new Map<string, Map<string, number>>();
  const byChannel = new Map<string, number>();
  for (const row of grouped) {
    const net = row._sum.netCents ?? 0;
    let categories = byChannelCategory.get(row.channel);
    if (!categories) {
      categories = new Map();
      byChannelCategory.set(row.channel, categories);
    }
    const key = row.category ?? "";
    categories.set(key, (categories.get(key) ?? 0) + net);
    byChannel.set(row.channel, (byChannel.get(row.channel) ?? 0) + net);
  }
  return { byChannelCategory, byChannel };
}

function categoryNet(
  sums: Sums,
  channel: string,
  category: string | null,
): number {
  if (category === null) return 0;
  return sums.byChannelCategory.get(channel)?.get(category) ?? 0;
}

export async function computeWeeklyReport(
  shop: string,
  range: DayRange,
): Promise<WeeklyReport> {
  const lyRange = weekdayAlignedLastYear(range);
  const [ty, ly] = await Promise.all([
    sumRange(shop, range),
    sumRange(shop, lyRange),
  ]);

  const categories: CategoryReportRow[] = CATEGORY_ROWS.map((row) => {
    const wv: CellPair = {
      ty: categoryNet(ty, "WV", row.squareCategory),
      ly: categoryNet(ly, "WV", row.squareCategory),
    };
    const ev: CellPair = {
      ty: categoryNet(ty, "EV", row.squareCategory),
      ly: categoryNet(ly, "EV", row.squareCategory),
    };
    const ecom: CellPair = {
      ty: categoryNet(ty, "ECOM", row.shopifyProductType),
      ly: categoryNet(ly, "ECOM", row.shopifyProductType),
    };
    return {
      row,
      wv,
      ev,
      ecom,
      total: { ty: wv.ty + ev.ty + ecom.ty, ly: wv.ly + ev.ly + ecom.ly },
    };
  });

  const sectionSum = (section: CategoryRow["section"]): CellPair =>
    categories
      .filter((c) => c.row.section === section)
      .reduce(
        (acc, c) => ({ ty: acc.ty + c.total.ty, ly: acc.ly + c.total.ly }),
        { ty: 0, ly: 0 },
      );

  const groupNames = [...new Set(CATEGORY_ROWS.map((r) => r.group))];
  const groups = groupNames.map((group) => ({
    group,
    total: categories
      .filter((c) => c.row.group === group)
      .reduce(
        (acc, c) => ({ ty: acc.ty + c.total.ty, ly: acc.ly + c.total.ly }),
        { ty: 0, ly: 0 },
      ),
  }));

  // Channel block: store channels are the sum of their category rows (the
  // template's =SUM over the category table), so both blocks always agree.
  const channelSum = (
    pick: (c: CategoryReportRow) => CellPair,
  ): CellPair =>
    categories.reduce(
      (acc, c) => ({ ty: acc.ty + pick(c).ty, ly: acc.ly + pick(c).ly }),
      { ty: 0, ly: 0 },
    );

  return {
    range,
    lyRange,
    channels: {
      wv: channelSum((c) => c.wv),
      ev: channelSum((c) => c.ev),
      ecom: channelSum((c) => c.ecom),
      invoiced: {
        ty: ty.byChannel.get("INVOICED") ?? 0,
        ly: ly.byChannel.get("INVOICED") ?? 0,
      },
    },
    categories,
    sections: {
      retail: sectionSum("retail"),
      service: sectionSum("service"),
      others: sectionSum("others"),
    },
    groups,
  };
}
