import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("../app/db.server", () => ({
  default: { salesLine: { findMany } },
}));

import { computeSnacksByUnitReport } from "../app/.server/analytics/snacks-by-unit-report";

type Line = {
  channel: string;
  kind: string;
  sku: string | null;
  itemName: string;
  quantity: number;
  category: string | null;
};

const RANGE = { start: "2026-07-01", end: "2026-07-31" };

const line = (over: Partial<Line>): Line => ({
  channel: "WV",
  kind: "sale",
  sku: "203020",
  itemName: "Pineapple Cake",
  quantity: 1,
  category: "Retail Snacks",
  ...over,
});

const LINES: Line[] = [
  line({ quantity: 3 }),
  // A boxed SKU expands into individual kitchen units.
  line({
    channel: "EV",
    sku: "203002",
    itemName: "Pineapple Cake Box",
    quantity: 2,
  }),
  // Returns subtract the same converted units.
  line({
    channel: "EV",
    kind: "return",
    sku: "203002",
    itemName: "Pineapple Cake Box",
    quantity: -1,
  }),
  // Bundles split into each component.
  line({
    channel: "ECOM",
    sku: "210421",
    itemName: "Button Trio",
    quantity: 2,
  }),
  // The flight parent is skipped; selected modifiers are stored as usage rows.
  line({ sku: "270210", itemName: "Snack Flight", quantity: 1 }),
  line({
    kind: "usage",
    sku: "200120",
    itemName: "Pineapple Linzer",
    quantity: 2,
    category: "Snack Flight Component",
  }),
  line({
    channel: "EV",
    sku: "200101",
    itemName: "Pineapple Linzer Box",
    quantity: 1,
  }),
  line({
    channel: "ECOM",
    sku: "200102",
    itemName: "Pineapple Linzer Cookie - 2 Boxes",
    quantity: 1,
    category: "Snacks",
  }),
  line({
    sku: "202220",
    itemName: "Raspberry Linzer",
    quantity: 3,
    category: "Service Snacks",
  }),
  line({
    channel: "EV",
    sku: "200220",
    itemName: "Shortbread",
    quantity: 1,
    category: "Service Snacks",
  }),
  line({
    channel: "ECOM",
    sku: "200201",
    itemName: "Shortbread Box",
    quantity: 1,
    category: "Snacks",
  }),
  line({
    sku: "250221",
    itemName: "Sweet Potato",
    quantity: 1,
    category: "Service Snacks",
  }),
  line({
    channel: "ECOM",
    sku: "230301",
    itemName: "Assorted Mooncake",
    quantity: 1,
    category: "Snacks",
  }),
  line({
    channel: "ECOM",
    sku: null,
    itemName: "Assorted Mooncake",
    quantity: 1,
    category: "Snacks",
  }),
  line({
    channel: "EV",
    sku: "202201",
    itemName: "Raspberry Linzer Box",
    quantity: 2,
  }),
  line({
    channel: "EV",
    sku: "200305",
    itemName: "Panna Cotta",
    quantity: 2,
    category: "Service Snacks",
  }),
  // Unknown 2-prefix SKU remains visible for configuration review.
  line({ channel: "EV", sku: "299999", itemName: "New Snack", quantity: 4 }),
  // Explicitly ignored PAR SKU stays out of both totals and audit.
  line({ sku: "261400", itemName: "Spicy Candied Peanuts Tube", quantity: 5 }),
];

beforeEach(() => {
  findMany.mockReset();
  findMany.mockResolvedValue(LINES);
});

describe("computeSnacksByUnitReport", () => {
  it("requests mapped snack candidates and excludes invoiced sales", async () => {
    await computeSnacksByUnitReport("tea.myshopify.com", RANGE);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          shop: "tea.myshopify.com",
          day: { gte: RANGE.start, lte: RANGE.end },
          channel: { in: ["WV", "EV", "ECOM"] },
          kind: { in: ["sale", "return", "usage"] },
        }),
      }),
    );
  });

  it("converts packs, nets returns, and splits bundles into kitchen units", async () => {
    const report = await computeSnacksByUnitReport("s", RANGE);
    expect(report.channels).toEqual(["ECOM", "EV", "WV"]);
    expect(
      report.rows.find((row) => row.key === "pineapple_cake"),
    ).toMatchObject({
      byChannel: { ECOM: 0, EV: 16, WV: 3 },
      totalUnits: 19,
    });
    expect(
      report.rows.find((row) => row.key === "pineapple_linzer"),
    ).toMatchObject({
      byChannel: { ECOM: 12, EV: 6, WV: 2 },
      totalUnits: 20,
    });
    for (const key of [
      "button_shortbread",
      "button_almond",
      "button_chocolate",
      "button_walnut",
    ]) {
      expect(report.rows.find((row) => row.key === key)).toMatchObject({
        byChannel: { ECOM: 2, EV: 0, WV: 0 },
        totalUnits: 2,
      });
    }
    expect(
      report.rows.find((row) => row.key === "raspberry_linzer"),
    ).toMatchObject({
      byChannel: { ECOM: 0, EV: 12, WV: 3 },
      totalUnits: 15,
    });
    expect(report.rows.find((row) => row.key === "panna_cotta")).toMatchObject({
      byChannel: { ECOM: 0, EV: 2, WV: 0 },
      totalUnits: 2,
    });
    expect(
      report.rows.find((row) => row.key === "butter_shortbread"),
    ).toMatchObject({
      byChannel: { ECOM: 6, EV: 2, WV: 0 },
      totalUnits: 8,
    });
    expect(report.rows.find((row) => row.key === "sweet_potato")).toMatchObject(
      {
        byChannel: { ECOM: 0, EV: 0, WV: 1 },
        totalUnits: 1,
      },
    );
    expect(
      report.rows.find((row) => row.key === "red_bean_moon"),
    ).toMatchObject({
      byChannel: { ECOM: 4, EV: 0, WV: 0 },
      totalUnits: 4,
    });
    expect(
      report.rows.find((row) => row.key === "mung_bean_moon"),
    ).toMatchObject({
      byChannel: { ECOM: 4, EV: 0, WV: 0 },
      totalUnits: 4,
    });
    expect(
      report.rows.find((row) => row.key === "mung_bean_moon_yolk"),
    ).toMatchObject({
      byChannel: { ECOM: 4, EV: 0, WV: 0 },
      totalUnits: 4,
    });
    // Unknown 2-prefix snacks still enter totals 1:1 until configured.
    expect(report.totalUnits).toBe(94);
  });

  it("reports unconfigured snack SKUs while counting them 1:1", async () => {
    const report = await computeSnacksByUnitReport("s", RANGE);
    expect(report.unmapped).toEqual([
      {
        sku: "261400",
        name: "Spicy Candied Peanuts Tube",
        channel: "WV",
        quantity: 5,
      },
      { sku: "299999", name: "New Snack", channel: "EV", quantity: 4 },
    ]);
    expect(
      report.rows.find((row) => row.key === "unmapped:261400")?.totalUnits,
    ).toBe(5);
  });
});
