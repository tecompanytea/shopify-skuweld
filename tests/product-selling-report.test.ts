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
  channel: string;
  itemName: string;
  variationName: string | null;
  sku: string | null;
  quantity: number;
  netCents: number;
};

const RANGE = { start: "2026-06-01", end: "2026-06-30" };

// WV first so the family row is created with the clean product name.
const TY_LINES: Line[] = [
  {
    channel: "WV",
    itemName: "Jade Oolong",
    variationName: "2 oz",
    sku: "100204",
    quantity: 2,
    netCents: 5000,
  },
  // Shopify-style "Product - Variant" name, different size SKU: must merge
  // into the same family row ("1002") with the suffix stripped.
  {
    channel: "ECOM",
    itemName: "Jade Oolong - 2 oz",
    variationName: "2 oz",
    sku: "100202",
    quantity: 1,
    netCents: 3000,
  },
  // No SKU: falls back to case-insensitive name identity.
  {
    channel: "EV",
    itemName: "Mystery Tea",
    variationName: null,
    sku: null,
    quantity: 1,
    netCents: 1000,
  },
];
const LY_LINES: Line[] = [
  {
    channel: "WV",
    itemName: "Jade Oolong",
    variationName: "8 oz",
    sku: "100208",
    quantity: 1,
    netCents: 2000,
  },
];

beforeEach(() => {
  findMany.mockReset();
  findMany.mockImplementation(({ where }) =>
    Promise.resolve(where.day.gte === RANGE.start ? TY_LINES : LY_LINES),
  );
});

describe("computeProductSellingReport", () => {
  it("groups cross-channel lines by SKU family with name fallback", async () => {
    const report = await computeProductSellingReport(
      "s",
      "tea",
      RANGE,
      "previous-year",
    );
    expect(report.rows.map((r) => r.familyKey)).toEqual([
      "1002",
      "name:mystery tea",
    ]); // sorted by TY net desc
    const jade = report.rows[0];
    expect(jade.name).toBe("Jade Oolong");
    expect(jade.ty).toEqual({ net: 8000, units: 3 });
    expect(jade.ly).toEqual({ net: 2000, units: 1 });
    expect(jade.channels.WV.ty).toEqual({ net: 5000, units: 2 });
    expect(jade.channels.ECOM.ty).toEqual({ net: 3000, units: 1 });
    expect(jade.channels.EV.ty).toEqual({ net: 0, units: 0 });
  });

  it("foots per-channel and ALL totals over the rows", async () => {
    const report = await computeProductSellingReport(
      "s",
      "tea",
      RANGE,
      "previous-year",
    );
    expect(report.channelTotals.WV.ty).toEqual({ net: 5000, units: 2 });
    expect(report.channelTotals.EV.ty).toEqual({ net: 1000, units: 1 });
    expect(report.channelTotals.ECOM.ty).toEqual({ net: 3000, units: 1 });
    expect(report.channelTotals.ALL.ty).toEqual({ net: 9000, units: 4 });
    expect(report.channelTotals.ALL.ly).toEqual({ net: 2000, units: 1 });
  });

  it("uses calendar-aligned LY for the previous-year mode", async () => {
    const report = await computeProductSellingReport(
      "s",
      "tea",
      RANGE,
      "previous-year",
    );
    expect(report.lyRange).toEqual({ start: "2025-06-01", end: "2025-06-30" });
  });

  it("rejects unknown scopes", () => {
    expect(() => productReportScope("bogus")).toThrow(/Unknown product report/);
  });
});
