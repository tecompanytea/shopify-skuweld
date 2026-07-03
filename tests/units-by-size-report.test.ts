import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("../app/db.server", () => ({
  default: { salesLine: { findMany } },
}));

import { computeUnitsBySizeReport } from "../app/.server/analytics/units-by-size-report";

type Line = {
  channel: string;
  itemName: string;
  variationName: string | null;
  sku: string | null;
  quantity: number;
};

const RANGE = { start: "2026-06-22", end: "2026-06-28" };

const LINES: Line[] = [
  {
    channel: "WV",
    itemName: "Jade Oolong - 2 oz",
    variationName: "2 oz",
    sku: "100202",
    quantity: 3,
  },
  // Mislabeled SKU (family 9999): the unit-majority vote regroups it under
  // Jade Oolong's real family 1002; its size still reads off its own SKU
  // code ("01" -> 1 oz) since the variant name matches no size.
  {
    channel: "WV",
    itemName: "Jade Oolong",
    variationName: "Sample Pack",
    sku: "999901",
    quantity: 2,
  },
  // SKU-less line adopts the family voted for its product name.
  {
    channel: "ECOM",
    itemName: "Jade Oolong - 8 oz",
    variationName: "8 oz",
    sku: null,
    quantity: 1,
  },
  // Return: signed negative units net against the same size bucket.
  {
    channel: "WV",
    itemName: "Jade Oolong - 2 oz",
    variationName: "2 oz",
    sku: "100202",
    quantity: -1,
  },
  // In-scheme SKU with a non-size code lands in "Other".
  {
    channel: "EV",
    itemName: "Gift Box",
    variationName: null,
    sku: "300099",
    quantity: 6,
  },
  // No SKU anywhere for this name: keyed by name, no style number.
  {
    channel: "EV",
    itemName: "Matcha - 10g",
    variationName: "10g",
    sku: null,
    quantity: 4,
  },
];

beforeEach(() => {
  findMany.mockReset();
  findMany.mockResolvedValue(LINES);
});

describe("computeUnitsBySizeReport", () => {
  it("lists the channels present, sorted", async () => {
    const report = await computeUnitsBySizeReport("s", RANGE);
    expect(report.channels).toEqual(["ECOM", "EV", "WV"]);
  });

  it("groups by voted SKU family, nets returns, and buckets sizes", async () => {
    const report = await computeUnitsBySizeReport("s", RANGE);
    const jade = report.rows.find((r) => r.name === "Jade Oolong")!;
    expect(jade.styleNumber).toBe("002"); // family 1002 minus category digit
    expect(jade.total["2 oz"]).toBe(2); // 3 sold − 1 returned
    expect(jade.total["1 oz"]).toBe(2); // mislabeled-SKU line, regrouped
    expect(jade.total["8 oz"]).toBe(1); // SKU-less line, adopted by name
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
