import prisma from "../../db.server";
import {
  IGNORED_SNACK_SKUS,
  SNACK_BUNDLE_SKUS,
  snackAllocations,
} from "../../lib/snack-units";
import type { DayRange } from "../../lib/periods";

// Kitchen-unit snack demand for the selected period. Package and gift SKUs
// expand into their individual components, Snack Flight modifier rows replace
// the parent bundle, and returns subtract units, matching kitchen-stores-par.

export interface SnackUnitsRow {
  key: string;
  name: string;
  category: string;
  byChannel: Record<string, number>;
  totalUnits: number;
}

export interface UnmappedSnackUnitsRow {
  sku: string | null;
  name: string;
  channel: string;
  quantity: number;
}

export interface SnacksByUnitReport {
  range: DayRange;
  channels: string[];
  rows: SnackUnitsRow[];
  totalsByChannel: Record<string, number>;
  totalUnits: number;
  unmapped: UnmappedSnackUnitsRow[];
}

interface Accumulator {
  key: string;
  name: string;
  category: string;
  byChannel: Map<string, number>;
}

function isSnackFlight(sku: string | null, name: string): boolean {
  return sku === "270210" || /\bsnack flight\b/i.test(name);
}

export async function computeSnacksByUnitReport(
  shop: string,
  range: DayRange,
): Promise<SnacksByUnitReport> {
  const lines = await prisma.salesLine.findMany({
    where: {
      shop,
      day: { gte: range.start, lte: range.end },
      channel: { in: ["WV", "EV", "ECOM"] },
      kind: { in: ["sale", "return", "usage"] },
      OR: [
        { sku: { startsWith: "2" } },
        { sku: { in: SNACK_BUNDLE_SKUS } },
        {
          category: {
            in: [
              "Retail Snacks",
              "Service Snacks",
              "Snacks",
              "Snack Flight Component",
            ],
          },
        },
      ],
    },
    select: {
      channel: true,
      kind: true,
      sku: true,
      itemName: true,
      quantity: true,
      category: true,
    },
  });

  const channels = [...new Set(lines.map((line) => line.channel))].sort();
  const products = new Map<string, Accumulator>();
  const unmapped = new Map<string, UnmappedSnackUnitsRow>();

  for (const line of lines) {
    // A Snack Flight's selected modifiers are separate usage facts. Counting
    // its parent as well would double-count the flight.
    if (line.kind !== "usage" && isSnackFlight(line.sku, line.itemName)) {
      continue;
    }
    if (line.sku && IGNORED_SNACK_SKUS.has(line.sku)) continue;

    const allocations = snackAllocations(line.sku, line.itemName);
    if (!allocations) {
      const looksLikeSnack =
        line.sku?.startsWith("2") ||
        line.category === "Snack Flight Component" ||
        line.category === "Retail Snacks" ||
        line.category === "Service Snacks" ||
        line.category === "Snacks";
      if (looksLikeSnack) {
        const key = `${line.sku ?? ""}\t${line.itemName}\t${line.channel}`;
        const row = unmapped.get(key) ?? {
          sku: line.sku,
          name: line.itemName,
          channel: line.channel,
          quantity: 0,
        };
        row.quantity += line.quantity;
        unmapped.set(key, row);
      }
      continue;
    }

    for (const allocation of allocations) {
      let product = products.get(allocation.key);
      if (!product) {
        product = {
          key: allocation.key,
          name: allocation.name,
          category: allocation.category,
          byChannel: new Map(),
        };
        products.set(allocation.key, product);
      }
      product.byChannel.set(
        line.channel,
        (product.byChannel.get(line.channel) ?? 0) +
          line.quantity * allocation.multiplier,
      );
    }
  }

  const rows = [...products.values()].map((product) => {
    const byChannel = Object.fromEntries(
      channels.map((channel) => [channel, product.byChannel.get(channel) ?? 0]),
    );
    return {
      key: product.key,
      name: product.name,
      category: product.category,
      byChannel,
      totalUnits: channels.reduce(
        (total, channel) => total + byChannel[channel],
        0,
      ),
    };
  });
  rows.sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      b.totalUnits - a.totalUnits ||
      a.name.localeCompare(b.name),
  );

  const totalsByChannel = Object.fromEntries(
    channels.map((channel) => [
      channel,
      rows.reduce((total, row) => total + row.byChannel[channel], 0),
    ]),
  );
  const totalUnits = rows.reduce((total, row) => total + row.totalUnits, 0);
  const unmappedRows = [...unmapped.values()]
    .filter((row) => row.quantity !== 0)
    .sort(
      (a, b) =>
        Math.abs(b.quantity) - Math.abs(a.quantity) ||
        a.name.localeCompare(b.name),
    );

  return {
    range,
    channels,
    rows,
    totalsByChannel,
    totalUnits,
    unmapped: unmappedRows,
  };
}
