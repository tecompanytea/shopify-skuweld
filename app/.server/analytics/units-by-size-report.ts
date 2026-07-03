import prisma from "../../db.server";
import { SIZE_COLUMNS, type SizeColumn } from "../../lib/analytics-scopes";
import type { DayRange } from "../../lib/periods";
import { productName, skuFamily } from "../../lib/sku-scheme";

export { SIZE_COLUMNS, type SizeColumn };

// Units-by-size report: loose leaf tea, NET units (after returns), one row
// per product family, one column per size. Mirrors the manual
// "UnitSales - by size" workbook: sizes are the SKU variant codes
// (01/02/04/08 = 1/2/4/8 oz, plus 10g), everything else is "Other"
// (packaged/by-the-box, default variants). Cross-channel identity by SKU
// family; the 3-digit family doubles as the "Style #" column.

export interface UnitsRow {
  name: string;
  styleNumber: string | null; // 3-digit family from the SKU scheme
  byChannel: Record<string, Record<SizeColumn, number>>;
  total: Record<SizeColumn, number>;
  totalUnits: number;
}

export interface UnitsBySizeReport {
  range: DayRange;
  channels: string[];
  rows: UnitsRow[];
}

function sizeOf(variationName: string | null, sku: string | null): SizeColumn {
  const variant = (variationName ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (/^1 ?oz/.test(variant)) return "1 oz";
  if (/^2 ?oz/.test(variant)) return "2 oz";
  if (/^4 ?oz/.test(variant)) return "4 oz";
  if (/^8 ?oz/.test(variant)) return "8 oz";
  if (/^10 ?g/.test(variant)) return "10g";
  if (sku && /^\d{6}$/.test(sku)) {
    const code = sku.slice(4);
    if (code === "01") return "1 oz";
    if (code === "02") return "2 oz";
    if (code === "04") return "4 oz";
    if (code === "08") return "8 oz";
  }
  return "Other";
}

const emptySizes = (): Record<SizeColumn, number> => ({
  "1 oz": 0,
  "2 oz": 0,
  "4 oz": 0,
  "8 oz": 0,
  "10g": 0,
  Other: 0,
});

export async function computeUnitsBySizeReport(
  shop: string,
  range: DayRange,
): Promise<UnitsBySizeReport> {
  // Net units after returns on both channels — include return rows; their
  // quantities are signed negative.
  const lines = await prisma.salesLine.findMany({
    where: {
      shop,
      day: { gte: range.start, lte: range.end },
      OR: [
        {
          source: "square",
          channel: { in: ["WV", "EV"] },
          category: "Retail Loose Leaf Tea",
        },
        { source: "shopify", category: "Loose Leaf" },
      ],
    },
    select: {
      channel: true,
      itemName: true,
      variationName: true,
      sku: true,
      quantity: true,
    },
  });

  interface Acc {
    name: string;
    styleNumber: string | null;
    byChannel: Map<string, Record<SizeColumn, number>>;
  }
  const products = new Map<string, Acc>();
  const channels = new Set<string>();

  // Pass 1: learn each product name's SKU family by unit-majority vote.
  // This both adopts SKU-less lines into their product (same name, no SKU)
  // and corrects mislabeled SKUs (a variant carrying another product's SKU
  // groups with its name, not the wrong family).
  const votes = new Map<string, Map<string, number>>();
  for (const line of lines) {
    const family = skuFamily(line.sku);
    if (!family) continue;
    const name = productName(line.itemName, line.variationName).toLowerCase();
    let tally = votes.get(name);
    if (!tally) {
      tally = new Map();
      votes.set(name, tally);
    }
    tally.set(family, (tally.get(family) ?? 0) + Math.abs(line.quantity));
  }
  const nameToFamily = new Map<string, string>();
  for (const [name, tally] of votes) {
    const winner = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    nameToFamily.set(name, winner[0]);
  }

  for (const line of lines) {
    channels.add(line.channel);
    const name = productName(line.itemName, line.variationName);
    const family = nameToFamily.get(name.toLowerCase()) ?? skuFamily(line.sku);
    const key = family ?? `name:${name.toLowerCase()}`;
    let acc = products.get(key);
    if (!acc) {
      acc = {
        name,
        styleNumber: family ? family.slice(1) : null,
        byChannel: new Map(),
      };
      products.set(key, acc);
    } else if (name.length > acc.name.length) {
      // Prefer the longest variant of the name — abbreviations lose.
      acc.name = name;
    }
    const sizes = acc.byChannel.get(line.channel) ?? emptySizes();
    sizes[sizeOf(line.variationName, line.sku)] += line.quantity;
    acc.byChannel.set(line.channel, sizes);
  }

  const channelList = [...channels].sort();
  const rows: UnitsRow[] = [...products.values()].map((acc) => {
    const total = emptySizes();
    const byChannel: UnitsRow["byChannel"] = {};
    for (const channel of channelList) {
      const sizes = acc.byChannel.get(channel) ?? emptySizes();
      byChannel[channel] = sizes;
      for (const size of SIZE_COLUMNS) total[size] += sizes[size];
    }
    return {
      name: acc.name,
      styleNumber: acc.styleNumber,
      byChannel,
      total,
      totalUnits: SIZE_COLUMNS.reduce((sum, size) => sum + total[size], 0),
    };
  });
  rows.sort((a, b) => b.totalUnits - a.totalUnits);

  return { range, channels: channelList, rows };
}
