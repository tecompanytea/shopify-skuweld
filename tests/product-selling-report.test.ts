import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("../app/db.server", () => ({
  default: { salesLine: { findMany } },
}));

import {
  computeProductSellingReport,
  productReportScope,
} from "../app/.server/analytics/product-selling-report";

type Line = {
  source: string;
  channel: string;
  kind: string;
  itemName: string;
  variationName: string | null;
  productKey: string | null;
  productTitle: string | null;
  sku: string | null;
  quantity: number;
  netCents: number;
};

const RANGE = { start: "2026-06-01", end: "2026-06-30" };

const line = (over: Partial<Line>): Line => ({
  source: "square",
  channel: "WV",
  kind: "sale",
  itemName: "?",
  variationName: null,
  productKey: null,
  productTitle: null,
  sku: null,
  quantity: 1,
  netCents: 0,
  ...over,
});

const TY_LINES: Line[] = [
  // One Square item, two size variations: they share a productKey, so the
  // sizes combine into a single row.
  line({
    itemName: "Jade Oolong",
    variationName: "2 Oz",
    productKey: "sq:item-jade",
    productTitle: "Jade Oolong",
    sku: "100202",
    quantity: 2,
    netCents: 5000,
  }),
  line({
    itemName: "Jade Oolong",
    variationName: "4 Oz",
    productKey: "sq:item-jade",
    productTitle: "Jade Oolong",
    sku: "100204",
    quantity: 1,
    netCents: 2000,
  }),
  // Shopify sells the same product under its own name and product id; the
  // shared SKU 100202 bridges the two channels, and the Shopify title wins.
  line({
    source: "shopify",
    channel: "ECOM",
    itemName: "Jade Oolong Tea - 2 oz",
    variationName: "2 oz",
    productKey: "sh:gid/1",
    productTitle: "Jade Oolong Tea",
    sku: "100202",
    quantity: 1,
    netCents: 3000,
  }),
  // Same SKU family (1002) but a different Square item: must NOT merge into
  // Jade Oolong. This is the Sweet Potato / Mung bean sesame cake bug.
  line({
    channel: "EV",
    itemName: "Osmanthus Oolong",
    productKey: "sq:item-osmanthus",
    productTitle: "Osmanthus Oolong",
    sku: "100211",
    quantity: 4,
    netCents: 4000,
  }),
  // A return nets the dollars but not the unit count.
  line({
    kind: "return",
    itemName: "Jade Oolong",
    variationName: "2 Oz",
    productKey: "sq:item-jade",
    productTitle: "Jade Oolong",
    sku: "100202",
    quantity: -1,
    netCents: -1000,
  }),
  // SKU has since left the catalog, so there is no productKey. Its name
  // matches exactly one catalog product, so it is adopted into that row
  // rather than becoming a second "Jade Oolong Tea".
  line({
    source: "shopify",
    channel: "ECOM",
    itemName: "Jade Oolong Tea - 8 oz",
    variationName: "8 oz",
    sku: "100299",
    quantity: 1,
    netCents: 1500,
  }),
  // Uncatalogued line naming nothing in the catalog: keeps name identity.
  line({ channel: "EV", itemName: "Mystery Tea", netCents: 1000 }),
];

const LY_LINES: Line[] = [
  line({
    itemName: "Jade Oolong",
    variationName: "8 Oz",
    productKey: "sq:item-jade",
    productTitle: "Jade Oolong",
    sku: "100208",
    quantity: 1,
    netCents: 2000,
  }),
];

beforeEach(() => {
  findMany.mockReset();
  findMany.mockImplementation((args) => {
    // The Shopify bridge query is the one without a day window.
    if (args.distinct) return Promise.resolve([]);
    return Promise.resolve(
      args.where.day.gte === RANGE.start ? TY_LINES : LY_LINES,
    );
  });
});

const report = () =>
  computeProductSellingReport("s", "tea", RANGE, "previous-year");

describe("computeProductSellingReport", () => {
  it("combines a catalog item's sizes and bridges channels by shared SKU", async () => {
    const jade = (await report()).rows[0];
    expect(jade.name).toBe("Jade Oolong Tea"); // Shopify title wins
    expect(jade.ty).toEqual({ net: 10500, units: 5 });
    expect(jade.ly).toEqual({ net: 2000, units: 1 });
    expect(jade.channels.WV.ty).toEqual({ net: 6000, units: 3 });
    expect(jade.channels.ECOM.ty).toEqual({ net: 4500, units: 2 });
    expect(jade.channels.EV.ty).toEqual({ net: 0, units: 0 });
  });

  it("keeps distinct catalog items in the same SKU family apart", async () => {
    const rows = (await report()).rows;
    expect(rows.map((r) => r.name)).toEqual([
      "Jade Oolong Tea",
      "Osmanthus Oolong",
      "Mystery Tea",
    ]);
    expect(rows[1].ty).toEqual({ net: 4000, units: 4 });
  });

  it("nets returns into dollars but not into units", async () => {
    const jade = (await report()).rows[0];
    // The returned unit is deducted from dollars, not from Units Sold.
    expect(jade.channels.WV.ty).toEqual({ net: 6000, units: 3 });
  });

  it("adopts a line whose SKU left the catalog into the product it names", async () => {
    const rows = (await report()).rows;
    expect(rows).toHaveLength(3); // no stray second "Jade Oolong Tea"
    expect(rows[0].channels.ECOM.ty.units).toBe(2);
  });

  it("falls back to name identity for uncatalogued lines", async () => {
    const mystery = (await report()).rows.find((r) => r.name === "Mystery Tea");
    expect(mystery?.productKey).toBe("name:mystery tea");
  });

  it("foots per-channel and ALL totals over the rows", async () => {
    const totals = (await report()).channelTotals;
    expect(totals.WV.ty).toEqual({ net: 6000, units: 3 });
    expect(totals.EV.ty).toEqual({ net: 5000, units: 5 });
    expect(totals.ECOM.ty).toEqual({ net: 4500, units: 2 });
    expect(totals.ALL.ty).toEqual({ net: 15500, units: 10 });
    expect(totals.ALL.ly).toEqual({ net: 2000, units: 1 });
  });

  it("uses calendar-aligned LY for the previous-year mode", async () => {
    expect((await report()).lyRange).toEqual({
      start: "2025-06-01",
      end: "2025-06-30",
    });
  });

  it("rejects unknown scopes", () => {
    expect(() => productReportScope("bogus")).toThrow(/Unknown product report/);
  });
});
