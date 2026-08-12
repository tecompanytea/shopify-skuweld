import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  buildProductSellingWorkbook,
  buildSnacksByUnitWorkbook,
} from "../app/.server/analytics/export-xlsx";
import type { ProductSellingReport } from "../app/.server/analytics/product-selling-report";
import type { SnacksByUnitReport } from "../app/.server/analytics/snacks-by-unit-report";

const report: ProductSellingReport = {
  scope: {
    key: "snacks",
    label: "Snacks",
    squareCategory: "Retail Snacks",
    shopifyProductTypes: ["Snacks"],
  },
  range: { start: "2026-09-01", end: "2026-09-30" },
  lyRange: { start: "2025-09-01", end: "2025-09-30" },
  compare: "previous-year",
  rows: [
    {
      name: "Pineapple Cake",
      productKey: "snack:pineapple-cake",
      ty: { net: 10_000, units: 10 },
      ly: { net: 4_000, units: 4 },
      channels: {
        WV: {
          ty: { net: 3_000, units: 3 },
          ly: { net: 1_000, units: 1 },
        },
        EV: {
          ty: { net: 2_000, units: 2 },
          ly: { net: 1_000, units: 1 },
        },
        ECOM: {
          ty: { net: 5_000, units: 5 },
          ly: { net: 2_000, units: 2 },
        },
      },
    },
  ],
  channelTotals: {
    WV: {
      ty: { net: 3_000, units: 3 },
      ly: { net: 1_000, units: 1 },
    },
    EV: {
      ty: { net: 2_000, units: 2 },
      ly: { net: 1_000, units: 1 },
    },
    ECOM: {
      ty: { net: 5_000, units: 5 },
      ly: { net: 2_000, units: 2 },
    },
    ALL: {
      ty: { net: 10_000, units: 10 },
      ly: { net: 4_000, units: 4 },
    },
  },
};

async function productWorkbook(): Promise<ExcelJS.Workbook> {
  const buffer = await buildProductSellingWorkbook(report);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(buffer).buffer);
  return workbook;
}

function worksheet(
  workbook: ExcelJS.Workbook,
  name: string,
): ExcelJS.Worksheet {
  const sheet = workbook.getWorksheet(name);
  if (!sheet) throw new Error(`Missing worksheet: ${name}`);
  return sheet;
}

function rowValues(row: ExcelJS.Row): ExcelJS.CellValue[] {
  return row.values as ExcelJS.CellValue[];
}

describe("product-selling workbook export", () => {
  it("presents TY before LY everywhere the periods are compared", async () => {
    const workbook = await productWorkbook();
    const summary = worksheet(workbook, "Summary");
    const westVillage = worksheet(workbook, "West Village");
    const combined = worksheet(workbook, "All Channels Combined");

    expect(rowValues(summary.getRow(3)).slice(1)).toEqual([
      "",
      "Channel",
      "TY Net $",
      "LY Net $",
      "$ Change",
      "% Change",
    ]);
    expect(rowValues(summary.getRow(4)).slice(1)).toEqual([
      "",
      "West Village",
      30,
      10,
      20,
      2,
    ]);
    expect(rowValues(westVillage.getRow(1)).slice(1)).toEqual([
      "#",
      "Product",
      "TY Net $",
      "LY Net $",
      "% Change",
      "TY Units",
      "LY Units",
    ]);
    expect(rowValues(westVillage.getRow(2)).slice(1)).toEqual([
      1,
      "Pineapple Cake",
      30,
      10,
      2,
      3,
      1,
    ]);
    expect(rowValues(combined.getRow(2)).slice(1, 6)).toEqual([
      "#",
      "Product",
      "TY Net $ TOTAL",
      "LY Net $ TOTAL",
      "% Change",
    ]);
  });

  it("includes combined TY and LY unit counts with a total", async () => {
    const workbook = await productWorkbook();
    const combined = worksheet(workbook, "All Channels Combined");

    expect(rowValues(combined.getRow(2)).slice(1)).toEqual([
      "#",
      "Product",
      "TY Net $ TOTAL",
      "LY Net $ TOTAL",
      "% Change",
      "TY Units",
      "LY Units",
      "WV TY $",
      "EV TY $",
      "E-com TY $",
    ]);
    expect(rowValues(combined.getRow(3)).slice(1, 8)).toEqual([
      1,
      "Pineapple Cake",
      100,
      40,
      1.5,
      10,
      4,
    ]);
    expect(rowValues(combined.getRow(4)).slice(1, 8)).toEqual([
      "",
      "TOTAL",
      100,
      40,
      1.5,
      10,
      4,
    ]);
  });
});

describe("snacks-by-unit workbook export", () => {
  it("labels the mapped tracking category as Snack SKU Category", async () => {
    const snackReport: SnacksByUnitReport = {
      range: { start: "2026-09-01", end: "2026-09-30" },
      channels: ["ECOM", "EV", "WV"],
      rows: [
        {
          key: "pineapple_linzer",
          name: "Pineapple Linzer",
          category: "Cookies",
          byChannel: { ECOM: 12, EV: 6, WV: 2 },
          totalUnits: 20,
        },
      ],
      totalsByChannel: { ECOM: 12, EV: 6, WV: 2 },
      totalUnits: 20,
      unmapped: [],
    };
    const buffer = await buildSnacksByUnitWorkbook(snackReport);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(buffer).buffer);
    const sheet = worksheet(workbook, "Snacks by Unit");

    expect(rowValues(sheet.getRow(2)).slice(1)).toEqual([
      "Snack",
      "Snack SKU Category",
      "ECOM",
      "EV",
      "WV",
      "Total Units",
    ]);
    expect(rowValues(sheet.getRow(3)).slice(1, 3)).toEqual([
      "Pineapple Linzer",
      "Cookies",
    ]);
  });
});
