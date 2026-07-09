import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("../app/db.server", () => ({
  default: { salesLine: { findMany } },
}));

import { computeUnitsBySizeReport } from "../app/.server/analytics/units-by-size-report";

type Line = {
  source: string;
  channel: string;
  itemName: string;
  variationName: string | null;
  productKey: string | null;
  productTitle: string | null;
  sku: string | null;
  quantity: number;
  netCents: number;
};

const RANGE = { start: "2026-06-22", end: "2026-06-28" };

const line = (over: Partial<Line>): Line => ({
  source: "square",
  channel: "WV",
  itemName: "Jade Oolong",
  variationName: null,
  productKey: null,
  productTitle: null,
  sku: null,
  quantity: 1,
  netCents: 0,
  ...over,
});

const LINES: Line[] = [
  line({
    itemName: "Jade Oolong - 2 oz",
    variationName: "2 oz",
    productKey: "sq:item-jade",
    productTitle: "Jade Oolong",
    sku: "100202",
    quantity: 3,
  }),
  // Mislabeled SKU (family 9999) on a variation of the same catalog item: it
  // groups with its product, and the Style # comes from the family that sold
  // the most units. Its size still reads off its own SKU code ("01" -> 1 oz)
  // since the variant name matches no size.
  line({
    variationName: "Sample Pack",
    productKey: "sq:item-jade",
    productTitle: "Jade Oolong",
    sku: "999901",
    quantity: 2,
  }),
  // No catalog key (retired variant): adopted by the product it names.
  line({
    channel: "ECOM",
    source: "shopify",
    itemName: "Jade Oolong - 8 oz",
    variationName: "8 oz",
    quantity: 1,
  }),
  // Return: signed negative units net against the same size bucket.
  line({
    itemName: "Jade Oolong - 2 oz",
    variationName: "2 oz",
    productKey: "sq:item-jade",
    productTitle: "Jade Oolong",
    sku: "100202",
    quantity: -1,
  }),
  // In-scheme SKU with a non-size code lands in "Other".
  line({
    channel: "EV",
    itemName: "Gift Box",
    productKey: "sq:item-gift",
    productTitle: "Gift Box",
    sku: "300099",
    quantity: 6,
  }),
  // No SKU and no catalog key: keyed by name, no style number.
  line({
    channel: "EV",
    itemName: "Matcha - 10g",
    variationName: "10g",
    quantity: 4,
  }),
];

beforeEach(() => {
  findMany.mockReset();
  // The Shopify bridge query is the one without a day window.
  findMany.mockImplementation((args) =>
    Promise.resolve(args.distinct ? [] : LINES),
  );
});

describe("computeUnitsBySizeReport", () => {
  it("lists the channels present, sorted", async () => {
    const report = await computeUnitsBySizeReport("s", RANGE);
    expect(report.channels).toEqual(["ECOM", "EV", "WV"]);
  });

  it("groups by catalog product, nets returns, and buckets sizes", async () => {
    const report = await computeUnitsBySizeReport("s", RANGE);
    const jade = report.rows.find((r) => r.name === "Jade Oolong")!;
    expect(jade.styleNumber).toBe("002"); // family 1002 minus category digit
    expect(jade.total["2 oz"]).toBe(2); // 3 sold − 1 returned
    expect(jade.total["1 oz"]).toBe(2); // mislabeled-SKU line, same product
    expect(jade.total["8 oz"]).toBe(1); // keyless line, adopted by name
    expect(jade.totalUnits).toBe(5);
    expect(jade.byChannel.WV["2 oz"]).toBe(2);
    expect(jade.byChannel.ECOM["8 oz"]).toBe(1);
    expect(jade.byChannel.EV["2 oz"]).toBe(0);
  });

  it("maps non-size SKU codes to Other and keeps name-only products unstyled", async () => {
    const report = await computeUnitsBySizeReport("s", RANGE);
    const giftBox = report.rows.find((r) => r.name === "Gift Box")!;
    expect(giftBox.styleNumber).toBe("000");
    expect(giftBox.total.Other).toBe(6);
    const matcha = report.rows.find((r) => r.name === "Matcha")!;
    expect(matcha.styleNumber).toBeNull();
    expect(matcha.total["10g"]).toBe(4);
  });

  it("sorts rows by total units, descending", async () => {
    const report = await computeUnitsBySizeReport("s", RANGE);
    expect(report.rows.map((r) => r.totalUnits)).toEqual([6, 5, 4]);
  });
});
