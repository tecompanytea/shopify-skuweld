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

// A roll-up's net split across the store channels. `total` is wv+ev+ecom;
// invoiced is never categorized, so it stays out of these splits — which is
// exactly the Distribution table's columns: TOTAL / STRS(=WV+EV) / WV / EV /
// WEB.
export interface ChannelCells {
  total: CellPair;
  wv: CellPair;
  ev: CellPair;
  ecom: CellPair;
}

export interface CategoryReportRow extends ChannelCells {
  row: CategoryRow;
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
    retail: ChannelCells;
    service: ChannelCells;
    others: ChannelCells;
  };
  groups: Array<{ group: string } & ChannelCells>;
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

const ZERO_PAIR: CellPair = { ty: 0, ly: 0 };
const addPair = (a: CellPair, b: CellPair): CellPair => ({
  ty: a.ty + b.ty,
  ly: a.ly + b.ly,
});

// Adds up the per-channel cells of several roll-up rows — the categories
// inside a section or group, or every category for the grand total.
function sumChannelCells(rows: ChannelCells[]): ChannelCells {
  return rows.reduce<ChannelCells>(
    (acc, c) => ({
      total: addPair(acc.total, c.total),
      wv: addPair(acc.wv, c.wv),
      ev: addPair(acc.ev, c.ev),
      ecom: addPair(acc.ecom, c.ecom),
    }),
    { total: ZERO_PAIR, wv: ZERO_PAIR, ev: ZERO_PAIR, ecom: ZERO_PAIR },
  );
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

  // Store channels are the sum of their category rows (the template's =SUM
  // over the category table), so the channel and category blocks always
  // agree. The same per-channel roll-up feeds the Distribution table, where
  // sections and groups need their WV/EV/Web split, not just the total.
  const sectionCells = (section: CategoryRow["section"]): ChannelCells =>
    sumChannelCells(categories.filter((c) => c.row.section === section));

  const groupNames = [...new Set(CATEGORY_ROWS.map((r) => r.group))];
  const groups = groupNames.map((group) => ({
    group,
    ...sumChannelCells(categories.filter((c) => c.row.group === group)),
  }));

  const grand = sumChannelCells(categories);

  return {
    range,
    lyRange,
    channels: {
      wv: grand.wv,
      ev: grand.ev,
      ecom: grand.ecom,
      invoiced: {
        ty: ty.byChannel.get("INVOICED") ?? 0,
        ly: ly.byChannel.get("INVOICED") ?? 0,
      },
    },
    categories,
    sections: {
      retail: sectionCells("retail"),
      service: sectionCells("service"),
      others: sectionCells("others"),
    },
    groups,
  };
}
