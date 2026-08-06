import { beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";

const { salesFindMany, skuFindMany } = vi.hoisted(() => ({
  salesFindMany: vi.fn(),
  skuFindMany: vi.fn(),
}));
vi.mock("../app/db.server", () => ({
  default: {
    salesLine: { findMany: salesFindMany },
    sku: { findMany: skuFindMany },
  },
}));

import {
  computeTeaByGramReport,
  giftGramRecipe,
  gramConversionOf,
  teaBagRecipe,
} from "../app/.server/analytics/tea-by-gram-report";
import { buildTeaByGramWorkbook } from "../app/.server/analytics/export-xlsx";

type Line = {
  channel: string;
  category: string | null;
  itemName: string;
  variationName: string | null;
  productTitle: string | null;
  sku: string | null;
  quantity: number;
};

const RANGE = { start: "2026-07-20", end: "2026-07-26" };
const line = (over: Partial<Line> = {}): Line => ({
  channel: "WV",
  category: "Retail Loose Leaf Tea",
  itemName: "Royal Courtesan",
  variationName: "1 oz",
  productTitle: "Royal Courtesan",
  sku: "100201",
  quantity: 1,
  ...over,
});

describe("gramConversionOf", () => {
  it("uses the rounded ounce recipes and 10 g recipe", () => {
    expect(gramConversionOf(line({ variationName: "1 oz" }))?.grams).toBe(30);
    expect(gramConversionOf(line({ variationName: "2oz" }))?.grams).toBe(60);
    expect(gramConversionOf(line({ variationName: "4 oz" }))?.grams).toBe(120);
    expect(gramConversionOf(line({ variationName: "8 OZ" }))?.grams).toBe(240);
    expect(gramConversionOf(line({ variationName: "10 g" }))).toEqual({
      grams: 10,
      basis: "10 g",
    });
  });

  it("uses SKU size codes only as a loose-leaf fallback", () => {
    expect(
      gramConversionOf(line({ variationName: "Regular", sku: "100204" })),
    ).toEqual({
      grams: 120,
      basis: "4 oz",
    });
    expect(
      gramConversionOf(line({ variationName: "Regular", sku: "100299" })),
    ).toBeNull();
  });

  it("uses the Hibiscus 20g and 60g package overrides", () => {
    expect(
      gramConversionOf(
        line({
          itemName: "Hibiscus 20g",
          productTitle: "Hibiscus 20g",
          variationName: "Regular",
          sku: "110601",
        }),
      ),
    ).toEqual({ grams: 20, basis: "20 g" });
    expect(
      gramConversionOf(
        line({
          itemName: "Hibiscus",
          productTitle: "Hibiscus",
          variationName: "60 grams",
          sku: "110606",
        }),
      ),
    ).toEqual({ grams: 60, basis: "60 g" });
  });

  it("maps TO GO, hot TO STAY, and iced TO STAY before looking at SKU suffixes", () => {
    expect(
      gramConversionOf(
        line({
          category: "Service To Go",
          variationName: "TO GO",
          sku: "100220",
        }),
      ),
    ).toEqual({ grams: 4, basis: "TO GO" });
    expect(
      gramConversionOf(
        line({
          category: "Service To Stay",
          itemName: "Iron Goddess",
          variationName: "TO STAY",
          sku: "100510",
        }),
      ),
    ).toEqual({ grams: 6, basis: "TO STAY" });
    expect(
      gramConversionOf(
        line({
          category: "Service To Stay",
          variationName: "Iced TO STAY",
          sku: "100510",
        }),
      ),
    ).toEqual({ grams: 4, basis: "ICED TO STAY" });
    expect(
      gramConversionOf(
        line({
          category: "Service To Stay",
          itemName: "Hibiscus Soda TO STAY",
          productTitle: "Hibiscus Soda TO STAY",
          variationName: "Regular",
          sku: "110611",
        }),
      ),
    ).toEqual({ grams: 4, basis: "ICED TO STAY" });
  });

  it("excludes service buttons that are not teas and converts flight selections", () => {
    expect(
      gramConversionOf(
        line({
          category: "Service To Stay",
          itemName: "Sharing Pot",
          productTitle: "Sharing Pot",
          sku: "170410",
        }),
      ),
    ).toBeNull();
    expect(
      gramConversionOf(
        line({
          category: "Service To Go",
          itemName: "Shopping Bag",
          productTitle: "Shopping Bag",
          sku: "999999",
        }),
      ),
    ).toBeNull();
    expect(
      gramConversionOf(
        line({
          category: "Service To Stay",
          itemName: "Tasting Flight",
          productTitle: "Tasting Flight",
          sku: "170110",
        }),
      ),
    ).toBeNull();
    expect(
      gramConversionOf(
        line({
          category: "Tasting Flight Tea",
          itemName: "Oriental Beauty",
          productTitle: "Oriental Beauty",
          variationName: "Tasting Flight",
          sku: "105620",
        }),
      ),
    ).toEqual({ grams: 4, basis: "TASTING FLIGHT" });
    expect(
      gramConversionOf(
        line({
          category: "Tasting Flight Tea",
          itemName: "(missing tasting flight selection)",
          productTitle: "(missing tasting flight selection)",
          variationName: "Tasting Flight",
          sku: null,
        }),
      ),
    ).toEqual({ grams: 4, basis: "TASTING FLIGHT" });
  });
});

describe("gift recipes", () => {
  it.each([
    ["400101", 60],
    ["400301", 60],
    ["400801", 60],
    ["400201", 63.5],
    ["400601", 120],
    ["400501", 180],
    ["400401", 180],
    ["402405", 40],
    ["402406", 110],
  ])("decomposes gift SKU %s into %s grams", (sku, expectedGrams) => {
    const recipe = giftGramRecipe(sku);
    expect(recipe).not.toBeNull();
    expect(
      recipe?.components.reduce((sum, component) => sum + component.grams, 0),
    ).toBe(expectedGrams);
  });

  it("tracks sachet gifts by tea-bag count instead of grams", () => {
    expect(giftGramRecipe("400303")).toBeNull();
    expect(teaBagRecipe("400303")).toEqual({
      gift: "Choicest Tea & Biscuits — Tea Sachets",
      teaBagsPerUnit: 12,
    });
  });

  it("includes Baozhong Vintage as 10 grams in the Formosa Collection", () => {
    expect(
      giftGramRecipe("400201")?.components.find(
        (component) => component.tea === "Baozhong Vintage",
      ),
    ).toMatchObject({ grams: 10 });
  });

  it("keeps all six Iconic set teas at 10 grams each", () => {
    const recipe = giftGramRecipe("400101");
    expect(recipe?.components).toHaveLength(6);
    expect(
      recipe?.components.every((component) => component.grams === 10),
    ).toBe(true);
  });
});

function mockDefaultReportData(): void {
  salesFindMany.mockReset();
  skuFindMany.mockReset();
  skuFindMany.mockResolvedValue([
    { value: "100201", productName: "Royal Courtesan" },
    { value: "100501", productName: "Iron Goddess" },
    { value: "100301", productName: "Oriental Beauty" },
  ]);
  salesFindMany.mockResolvedValue([
    line({ quantity: 2 }), // 60 g retail
    line({
      category: "Service To Go",
      variationName: "TO GO",
      sku: "100220",
      quantity: 3,
    }), // 12 g service, same 1002 family
    line({
      channel: "EV",
      category: "Service To Stay",
      itemName: "Iron Goddess",
      productTitle: "Iron Goddess",
      variationName: "TO STAY",
      sku: "100510",
      quantity: 2,
    }), // 12 g
    line({
      channel: "EV",
      category: "Service To Stay",
      itemName: "Iron Goddess Iced",
      productTitle: "Iron Goddess",
      variationName: "Iced TO STAY",
      sku: "100510",
      quantity: 1,
    }), // 4 g
    line({
      category: "Gift Sets",
      itemName: "Superb Iced Tea Duo",
      productTitle: "Superb Iced Tea Duo",
      variationName: null,
      sku: "400601",
      quantity: 2,
    }), // 120 g Royal Courtesan + 120 g Iron Goddess
    line({
      category: "Gift Sets",
      itemName: "Choicest Tea & Biscuits — Loose Leaf",
      productTitle: "Choicest Tea & Biscuits — Loose Leaf",
      variationName: null,
      sku: "400301",
    }), // 60 g Oriental Beauty
    line({
      category: "Gift Sets",
      itemName: "Choicest Tea & Biscuits — Tea Sachets",
      productTitle: "Choicest Tea & Biscuits — Tea Sachets",
      variationName: null,
      sku: "400303",
      quantity: 2,
    }), // 24 tea bags, never grams
    line({ sku: null, quantity: 4 }),
    line({ sku: "100299", variationName: "Mystery", quantity: 2 }),
  ] satisfies Line[]);
}

describe("computeTeaByGramReport", () => {
  beforeEach(mockDefaultReportData);

  it("groups retail and service usage by SKU family across channels", async () => {
    const report = await computeTeaByGramReport("tea.myshopify.com", RANGE);

    expect(report.channels).toEqual(["EV", "WV"]);
    expect(report.rows).toEqual([
      {
        key: "family:1002",
        skuFamily: "1002",
        name: "Royal Courtesan",
        byChannel: { EV: 0, WV: 192 },
        totalGrams: 192,
        totalKilograms: 0.192,
      },
      {
        key: "family:1005",
        skuFamily: "1005",
        name: "Iron Goddess",
        byChannel: { EV: 16, WV: 120 },
        totalGrams: 136,
        totalKilograms: 0.136,
      },
      {
        key: "family:1003",
        skuFamily: "1003",
        name: "Oriental Beauty",
        byChannel: { EV: 0, WV: 60 },
        totalGrams: 60,
        totalKilograms: 0.06,
      },
    ]);
    expect(report.totalGrams).toBe(388);
    expect(report.totalKilograms).toBe(0.388);
    expect(report.teaBagRows).toEqual([
      {
        sku: "400303",
        gift: "Choicest Tea & Biscuits — Tea Sachets",
        teaBagsPerUnit: 12,
        byChannel: { EV: 0, WV: 24 },
        totalTeaBags: 24,
      },
    ]);
    expect(report.totalTeaBags).toBe(24);
  });

  it("keeps SKU-level detail and an audit list for unmapped tea lines", async () => {
    const report = await computeTeaByGramReport("tea.myshopify.com", RANGE);

    expect(report.skuRows).toHaveLength(7);
    expect(report.skuRows.find((row) => row.sku === "100220")).toMatchObject({
      tea: "Royal Courtesan",
      gramsPerUnit: 4,
      units: 3,
      totalGrams: 12,
    });
    expect(report.unmapped).toEqual([
      expect.objectContaining({
        sku: "(missing)",
        units: 4,
        reason: "Missing or non-standard six-digit tea SKU",
      }),
      expect.objectContaining({
        sku: "100299",
        units: 2,
        reason: "Variant has no gram conversion",
      }),
    ]);
  });

  it("requests positive sale and usage rows only, so refunds do not subtract usage", async () => {
    await computeTeaByGramReport("tea.myshopify.com", RANGE);
    expect(salesFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: { in: ["sale", "usage"] },
          quantity: { gt: 0 },
        }),
      }),
    );
  });

  it("reports seasonal Bounty teas as individual named rows", async () => {
    skuFindMany.mockResolvedValue([]);
    salesFindMany.mockResolvedValue([
      line({
        category: "Gift Sets",
        itemName: "Bounty Box '26",
        productTitle: "Bounty Box '26",
        variationName: null,
        sku: "402405",
        quantity: 2,
      }),
    ]);

    const report = await computeTeaByGramReport("tea.myshopify.com", RANGE);

    expect(report.rows).toHaveLength(6);
    expect(report.rows.every((row) => row.skuFamily === null)).toBe(true);
    expect(report.rows.map((row) => row.name).sort()).toEqual(
      [
        "Crimson White",
        "Jaipuri Assam Black",
        "Jaipuri Assam White",
        "Lugu Dark Roast",
        "Lugu Medium Roast",
        "Sun Moon Lake Mountain Black",
      ].sort(),
    );
    expect(report.totalGrams).toBe(80);
    expect(report.unmapped).toEqual([]);
  });

  it("removes non-tea service buttons, assigns flights, and halves Oolong Palmer into Ruby Brew", async () => {
    skuFindMany.mockResolvedValue([
      { value: "105501", productName: "Ruby Brew" },
      { value: "105601", productName: "Oriental Beauty" },
    ]);
    salesFindMany.mockResolvedValue([
      line({
        category: "Service To Stay",
        itemName: "Sharing Pot",
        productTitle: "Sharing Pot",
        variationName: "Regular",
        sku: "170410",
        quantity: 10,
      }),
      line({
        category: "Service To Go",
        itemName: "Shopping Bag",
        productTitle: "Shopping Bag",
        variationName: "Regular",
        sku: "999999",
        quantity: 10,
      }),
      line({
        category: "Service To Stay",
        itemName: "Tasting Flight",
        productTitle: "Tasting Flight",
        variationName: "Regular",
        sku: "170110",
        quantity: 10,
      }),
      line({
        category: "Tasting Flight Tea",
        itemName: "Oriental Beauty",
        productTitle: "Oriental Beauty",
        variationName: "Tasting Flight",
        sku: "105620",
        quantity: 2,
      }),
      line({
        category: "Service To Stay",
        itemName: "Oolong Palmer TO STAY",
        productTitle: "Oolong Palmer TO STAY",
        variationName: "Regular",
        sku: "155511",
        quantity: 2,
      }),
      line({
        category: "Service To Go",
        itemName: "Oolong Palmer TO GO",
        productTitle: "Oolong Palmer TO GO",
        variationName: "Regular",
        sku: "155521",
        quantity: 3,
      }),
    ]);

    const report = await computeTeaByGramReport("tea.myshopify.com", RANGE);

    expect(report.rows).toEqual([
      expect.objectContaining({
        skuFamily: "1055",
        name: "Ruby Brew",
        totalGrams: 12,
      }),
      expect.objectContaining({
        skuFamily: "1056",
        name: "Oriental Beauty",
        totalGrams: 8,
      }),
    ]);
    expect(report.rows.some((row) => row.skuFamily === "1701")).toBe(false);
    expect(report.rows.some((row) => row.skuFamily === "1704")).toBe(false);
    expect(report.rows.some((row) => row.skuFamily === "9999")).toBe(false);
    expect(
      report.skuRows.filter((row) => row.basis === "OOLONG PALMER"),
    ).toEqual([
      expect.objectContaining({ gramsPerUnit: 3, units: 2, totalGrams: 6 }),
      expect.objectContaining({ gramsPerUnit: 2, units: 3, totalGrams: 6 }),
    ]);
    expect(report.totalGrams).toBe(20);
    expect(report.unmapped).toEqual([]);
  });

  it("maps Valley gifts, Hibiscus gram packs, and Wuyi shared SKUs to their canonical families", async () => {
    skuFindMany.mockResolvedValue([
      { value: "107101", productName: "Baozhong Expert's Pick" },
      { value: "105201", productName: "Valley of DP" },
      { value: "105601", productName: "Oriental Beauty" },
      { value: "106601", productName: "Frozen Summit" },
      { value: "107901", productName: "Jade Rouge" },
      { value: "100501", productName: "Iron Goddess" },
    ]);
    salesFindMany.mockResolvedValue([
      line({
        itemName: "Valley of DP",
        productTitle: "Valley of DP",
        sku: "105201",
      }),
      line({
        category: "Retail Gifts",
        itemName: "Iconic Gift",
        productTitle: "Iconic Gift",
        variationName: "Regular",
        sku: "400101",
      }),
      line({
        itemName: "Hibiscus 20g",
        productTitle: "Hibiscus 20g",
        variationName: "Regular",
        sku: "110601",
      }),
      line({
        itemName: "Hibiscus 60g",
        productTitle: "Hibiscus 60g",
        variationName: "Regular",
        sku: "110606",
        quantity: 2,
      }),
      line({
        category: "Service To Stay",
        itemName: "Hibiscus Soda TO STAY",
        productTitle: "Hibiscus Soda TO STAY",
        variationName: "Regular",
        sku: "110611",
        quantity: 3,
      }),
      line({
        itemName: "Wuyi Roast",
        productTitle: "Wuyi Roast",
        sku: "102401",
      }),
      line({
        category: "Tasting Flight Tea",
        itemName: "Wuyi Roast",
        productTitle: "Wuyi Roast",
        variationName: "Tasting Flight",
        sku: "150124",
        quantity: 2,
      }),
    ]);

    const report = await computeTeaByGramReport("tea.myshopify.com", RANGE);

    expect(report.rows.find((row) => row.skuFamily === "1052")).toMatchObject({
      totalGrams: 40,
    });
    expect(report.rows.find((row) => row.skuFamily === "1106")).toMatchObject({
      totalGrams: 152,
    });
    expect(report.rows.find((row) => row.skuFamily === "1024")).toMatchObject({
      name: "Wuyi Roast",
      totalGrams: 38,
    });
    expect(report.rows.some((row) => row.skuFamily === "1501")).toBe(false);
    expect(report.unmapped.some((row) => /valley/i.test(row.variant))).toBe(
      false,
    );
    expect(report.totalGrams).toBe(280);
  });
});

describe("buildTeaByGramWorkbook", () => {
  it("exports grams, tea-bag counts, SKU detail, and the audit list", async () => {
    mockDefaultReportData();
    const report = await computeTeaByGramReport("tea.myshopify.com", RANGE);
    const buffer = await buildTeaByGramWorkbook(report);
    const workbook = new ExcelJS.Workbook();
    const workbookBuffer = Buffer.alloc(buffer.length);
    buffer.copy(workbookBuffer);
    await workbook.xlsx.load(workbookBuffer.buffer);

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "Tea by Gram",
      "Tea Bags by Count",
      "Gram SKU Detail",
      "Gram Unmapped",
    ]);
    expect(workbook.getWorksheet("Tea by Gram")?.getRow(2).values).toEqual([
      undefined,
      "SKU Family",
      "Tea",
      "EV g",
      "WV g",
      "Total g",
      "Total kg",
    ]);
    expect(workbook.getWorksheet("Tea by Gram")?.getRow(3).values).toEqual([
      undefined,
      "1002",
      "Royal Courtesan",
      0,
      192,
      192,
      0.192,
    ]);
    expect(
      workbook.getWorksheet("Tea Bags by Count")?.getRow(3).values,
    ).toEqual([
      undefined,
      "400303",
      "Choicest Tea & Biscuits — Tea Sachets",
      12,
      0,
      24,
      24,
    ]);
    expect(workbook.getWorksheet("Gram SKU Detail")?.rowCount).toBe(8);
    expect(workbook.getWorksheet("Gram Unmapped")?.rowCount).toBe(4);
  });
});
