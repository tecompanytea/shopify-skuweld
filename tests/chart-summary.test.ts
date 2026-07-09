import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("../app/db.server", () => ({
  default: { salesLine: { findMany } },
}));

import { computeAnalyticsChartSummary } from "../app/.server/analytics/chart-summary";

type Line = {
  day: string;
  source: string;
  channel: string;
  kind: string;
  orderId: string;
  itemName: string;
  variationName: string | null;
  productKey: string | null;
  productTitle: string | null;
  sku: string | null;
  category: string | null;
  netCents: number;
};

const line = (over: Partial<Line>): Line => ({
  day: "2026-06-08",
  source: "square",
  channel: "WV",
  kind: "sale",
  orderId: "1",
  itemName: "Jade Oolong",
  variationName: "2 oz",
  productKey: null,
  productTitle: null,
  sku: null,
  category: "Retail Loose Leaf Tea",
  netCents: 1000,
  ...over,
});

const RANGE = { start: "2026-06-08", end: "2026-06-10" };

// The Shopify bridge query is the one without a day window.
const setRows = (rows: Line[]) =>
  findMany.mockImplementation((args) =>
    Promise.resolve(args.distinct ? [] : rows),
  );

beforeEach(() => {
  findMany.mockReset();
  setRows([
    // One two-line order: contributes $15 once to the AOV denominator.
    line({ orderId: "ty-1", itemName: "Jade Oolong", netCents: 1000 }),
    line({ orderId: "ty-1", itemName: "Jade Oolong", netCents: 500 }),
    line({
      source: "shopify",
      channel: "ECOM",
      orderId: "ty-2",
      itemName: "Pineapple Linzer Cookie",
      variationName: null,
      category: "Snacks",
      netCents: 2500,
    }),
    line({
      day: "2026-06-09",
      orderId: "ty-3",
      itemName: "Jade Oolong - 8 oz",
      variationName: "8 oz",
      netCents: 1000,
    }),
    // Returns affect total sales, but do not create new orders for AOV.
    line({
      day: "2026-06-09",
      kind: "return",
      orderId: "return-1",
      itemName: "Jade Oolong",
      netCents: -200,
    }),
    line({
      day: "2025-06-09",
      orderId: "ly-1",
      itemName: "Jade Oolong",
      netCents: 2000,
    }),
  ]);
});

describe("computeAnalyticsChartSummary", () => {
  it("uses the shared comparison window and aligns comparison points by index", async () => {
    const summary = await computeAnalyticsChartSummary(
      "s",
      RANGE,
      "previous-year-dow",
    );
    expect(summary.comparisonRange).toEqual({
      start: "2025-06-09",
      end: "2025-06-11",
    });
    expect(summary.salesOverTime.map((point) => point.comparisonDay)).toEqual([
      "2025-06-09",
      "2025-06-10",
      "2025-06-11",
    ]);
  });

  it("nets total sales by day and channel without changing source rows", async () => {
    const summary = await computeAnalyticsChartSummary(
      "s",
      RANGE,
      "previous-year-dow",
    );
    expect(summary.totalSales.ty).toBe(4800);
    expect(summary.totalSales.ly).toBe(2000);
    expect(summary.salesOverTime.map((point) => point.ty)).toEqual([
      4000, 800, 0,
    ]);
    expect(summary.salesByChannel.map((row) => [row.channel, row.ty])).toEqual([
      ["ECOM", 2500],
      ["WV", 2300],
    ]);
  });

  it("computes AOV from distinct sale orders instead of sales lines or returns", async () => {
    const summary = await computeAnalyticsChartSummary(
      "s",
      RANGE,
      "previous-year-dow",
    );
    expect(summary.averageOrderValue.ty).toBe(5000 / 3);
    expect(summary.averageOrderValue.ly).toBe(2000);
    expect(summary.averageOrderValueOverTime.map((point) => point.ty)).toEqual([
      2000, 1000, 0,
    ]);
  });

  it("groups product bars by product name with Shopify variant suffix stripped", async () => {
    const summary = await computeAnalyticsChartSummary(
      "s",
      RANGE,
      "previous-year-dow",
    );
    expect(
      summary.topProducts.map((row) => [row.name, row.ty, row.ly]),
    ).toEqual(
      [
        ["Jade Oolong", 2300, 2000],
        ["Pineapple Linzer Cookie", 2500, 0],
      ].sort((a, b) => Number(b[1]) - Number(a[1])),
    );
  });

  // The POS button and the web product spell the same tea differently; the
  // bar chart used to show them as two products.
  it("merges a product across channels by catalog identity, not by name", async () => {
    setRows([
      line({
        itemName: "Mt Ali",
        productKey: "sq:item-ali",
        productTitle: "Mt Ali",
        sku: "101002",
        netCents: 1000,
      }),
      line({
        source: "shopify",
        channel: "ECOM",
        orderId: "ty-2",
        itemName: "Mount A-Li - 2 oz",
        variationName: "2 oz",
        productKey: "sh:gid/9",
        productTitle: "Mount A-Li",
        sku: "101002",
        category: "Loose Leaf",
        netCents: 4000,
      }),
    ]);
    const summary = await computeAnalyticsChartSummary(
      "s",
      RANGE,
      "previous-year-dow",
    );
    expect(summary.topProducts.map((row) => [row.name, row.ty])).toEqual([
      ["Mount A-Li", 5000],
    ]);
  });
});
