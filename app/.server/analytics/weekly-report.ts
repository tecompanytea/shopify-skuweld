import prisma from "../../db.server";
import { CATEGORY_ROWS, type CategoryRow } from "./categories";
import {
  comparisonRange,
  shiftDay,
  type ComparisonMode,
  type DayRange,
} from "../../lib/periods";

// Computes the Weekly Meeting Report: net sales by channel and by category,
// this-year vs weekday-aligned last-year. Reproduces the manual template:
// store channels come from Square (invoiced excluded), e-commerce from
// Shopify by product type, invoiced from Square invoices. Each roll-up also
// carries a per-channel weekly average over the trailing six weeks, for the
// export's AVG 6 WK columns.

export interface CellPair {
  ty: number; // cents
  ly: number; // cents
}

// Average weekly net per store channel over the six weeks ending with the
// report range (the report week and the five before it). Cents.
// `total` is wv+ev+ecom, mirroring ChannelCells.total.
export interface ChannelAvg {
  total: number;
  wv: number;
  ev: number;
  ecom: number;
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
  avg6: ChannelAvg;
}

export interface CategoryReportRow extends ChannelCells {
  row: CategoryRow;
}

export interface WeeklyReport {
  range: DayRange;
  lyRange: DayRange;
  compare: ComparisonMode;
  // The categorized channels (WV/EV/Ecom) with their combined total — every
  // "TOTAL w/o Invoiced" in the UI and the workbook is `grand.total`, and the
  // category/section/group blocks all foot to it.
  grand: ChannelCells;
  // Square invoices are never categorized, so they live outside `grand`.
  invoiced: CellPair;
  // Weekly average of invoiced net over the same trailing six weeks, so the
  // By Channel table can foot AVG 6 WK on its invoiced-inclusive TOTAL rows.
  invoicedAvg6: number;
  totals: {
    woEcom: CellPair; // WV + EV + Invoiced
    all: CellPair; // WV + EV + Ecom + Invoiced
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
const ZERO_AVG: ChannelAvg = { total: 0, wv: 0, ev: 0, ecom: 0 };
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
      avg6: {
        total: acc.avg6.total + c.avg6.total,
        wv: acc.avg6.wv + c.avg6.wv,
        ev: acc.avg6.ev + c.avg6.ev,
        ecom: acc.avg6.ecom + c.avg6.ecom,
      },
    }),
    {
      total: ZERO_PAIR,
      wv: ZERO_PAIR,
      ev: ZERO_PAIR,
      ecom: ZERO_PAIR,
      avg6: ZERO_AVG,
    },
  );
}

export async function computeWeeklyReport(
  shop: string,
  range: DayRange,
  compare: ComparisonMode,
): Promise<WeeklyReport> {
  const lyRange = comparisonRange(compare, range);
  // Six-week window (42 days) ending with the report range, for AVG 6 WK.
  const avgRange: DayRange = {
    start: shiftDay(range.end, -41),
    end: range.end,
  };
  const [ty, ly, avg] = await Promise.all([
    sumRange(shop, range),
    sumRange(shop, lyRange),
    sumRange(shop, avgRange),
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
      ty: row.shopifyProductTypes.reduce(
        (sum, type) => sum + categoryNet(ty, "ECOM", type),
        0,
      ),
      ly: row.shopifyProductTypes.reduce(
        (sum, type) => sum + categoryNet(ly, "ECOM", type),
        0,
      ),
    };
    const avgWv = categoryNet(avg, "WV", row.squareCategory) / 6;
    const avgEv = categoryNet(avg, "EV", row.squareCategory) / 6;
    const avgEcom =
      row.shopifyProductTypes.reduce(
        (sum, type) => sum + categoryNet(avg, "ECOM", type),
        0,
      ) / 6;
    const avg6: ChannelAvg = {
      total: avgWv + avgEv + avgEcom,
      wv: avgWv,
      ev: avgEv,
      ecom: avgEcom,
    };
    return {
      row,
      wv,
      ev,
      ecom,
      avg6,
      total: { ty: wv.ty + ev.ty + ecom.ty, ly: wv.ly + ev.ly + ecom.ly },
    };
  });

  // Channels are the sum of their category rows (the template's =SUM over
  // the category table), so the channel and category blocks always agree.
  // The same per-channel roll-up feeds the Distribution table, where
  // sections and groups need their WV/EV/Web split, not just the total.
  const sectionCells = (section: CategoryRow["section"]): ChannelCells =>
    sumChannelCells(categories.filter((c) => c.row.section === section));

  const groupNames = [...new Set(CATEGORY_ROWS.map((r) => r.group))];
  const groups = groupNames.map((group) => ({
    group,
    ...sumChannelCells(categories.filter((c) => c.row.group === group)),
  }));

  const grand = sumChannelCells(categories);
  const invoiced: CellPair = {
    ty: ty.byChannel.get("INVOICED") ?? 0,
    ly: ly.byChannel.get("INVOICED") ?? 0,
  };
  const invoicedAvg6 = (avg.byChannel.get("INVOICED") ?? 0) / 6;

  return {
    range,
    lyRange,
    compare,
    grand,
    invoiced,
    invoicedAvg6,
    totals: {
      woEcom: addPair(addPair(grand.wv, grand.ev), invoiced),
      all: addPair(grand.total, invoiced),
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
