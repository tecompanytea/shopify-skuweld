import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("../app/db.server", () => ({
  default: { salesLine: { findMany } },
}));

import { computeTop10Report } from "../app/.server/analytics/top10-report";

type Line = {
  source: string;
  channel: string;
  category: string | null;
  itemName: string;
  variationName: string | null;
  netCents: number;
  quantity: number;
  kind: string;
};

const line = (over: Partial<Line>): Line => ({
  source: "square",
  channel: "WV",
  category: "Retail Loose Leaf Tea",
  itemName: "Jade Oolong",
  variationName: "2 oz",
  netCents: 1000,
  quantity: 1,
  kind: "sale",
  ...over,
});

const RANGE = { start: "2026-06-22", end: "2026-06-28" };

const TY_LINES: Line[] = [
  line({ netCents: 5000, quantity: 2 }),
  // Return: nets the dollars but must not reduce the units count.
  line({ kind: "return", netCents: -1000, quantity: -1 }),
  // Square gift cards are liabilities — excluded everywhere.
  line({ category: "Gift Card", itemName: "Gift Card", netCents: 9999 }),
  // Shopify product type bridges to the Square category vocabulary.
  line({
    source: "shopify",
    channel: "ECOM",
    category: "Loose Leaf",
    itemName: "Silver Needle",
    variationName: null,
    netCents: 6000,
  }),
  line({
    source: "shopify",
    channel: "ECOM",
    category: "Odd Type",
    itemName: "Mystery Box",
    variationName: null,
    netCents: 500,
  }),
  line({
    source: "shopify",
    channel: "ECOM",
    category: null,
    itemName: "Untyped",
    variationName: null,
    netCents: 250,
  }),
];
const LY_LINES: Line[] = [line({ netCents: 2000 })];

const setLines = (ty: Line[], ly: Line[]) => {
  findMany.mockImplementation(({ where }) =>
    Promise.resolve(where.day.gte === RANGE.start ? ty : ly),
  );
};

beforeEach(() => {
  findMany.mockReset();
  setLines(TY_LINES, LY_LINES);
});

describe("computeTop10Report", () => {
  it("only emits channels that have data, in WV/EV/ECOM/ALL order", async () => {
    const report = await computeTop10Report("s", RANGE, "previous-year-dow");
    expect(report.channels.map((c) => c.channel)).toEqual([
      "WV",
      "ECOM",
      "ALL",
    ]);
  });

  it("excludes Square gift cards and nets returns into dollars but not units", async () => {
    const report = await computeTop10Report("s", RANGE, "previous-year-dow");
    const wv = report.channels.find((c) => c.channel === "WV")!;
    expect(wv.totalTy).toBe(4000); // 5000 − 1000 return; gift card ignored
    expect(wv.totalLy).toBe(2000);
    expect(wv.categories.map((c) => c.category)).toEqual([
      "Retail Loose Leaf Tea",
    ]);
    const jade = wv.topOverall.find((i) => i.name === "Jade Oolong")!;
    expect(jade.net).toBe(4000);
    expect(jade.units).toBe(2); // return quantity doesn't subtract
  });

  it("bridges Shopify product types into the category vocabulary on ALL", async () => {
    const report = await computeTop10Report("s", RANGE, "previous-year-dow");
    const all = report.channels.find((c) => c.channel === "ALL")!;
    expect(all.totalTy).toBe(10750);
    const tea = all.categories.find(
      (c) => c.category === "Retail Loose Leaf Tea",
    )!;
    expect(tea.ty).toBe(10000); // Square 4000 + Shopify Loose Leaf 6000
    expect(tea.tyPenetration).toBeCloseTo(10000 / 10750);
    // Unbridged and untyped Shopify lines keep distinct buckets.
    expect(all.categories.map((c) => c.category)).toContain("Web: Odd Type");
    expect(all.categories.map((c) => c.category)).toContain("Uncategorized");
  });

  it("ranks top items by TY net and caps the list at 10", async () => {
    setLines(
      Array.from({ length: 12 }, (_, i) =>
        line({ itemName: `Tea ${i}`, variationName: null, netCents: (i + 1) * 100 }),
      ),
      [],
    );
    const report = await computeTop10Report("s", RANGE, "previous-year-dow");
    const wv = report.channels.find((c) => c.channel === "WV")!;
    expect(wv.topOverall).toHaveLength(10);
    expect(wv.topOverall[0].name).toBe("Tea 11"); // highest net first
    expect(wv.topByCategory["Retail Loose Leaf Tea"]).toHaveLength(10);
  });
});
