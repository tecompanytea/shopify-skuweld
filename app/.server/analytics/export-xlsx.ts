import ExcelJS from "exceljs";
import type { WeeklyReport, CellPair } from "./weekly-report";
import type { ProductSellingReport, ProductCell } from "./product-selling-report";

// Renders reports as .xlsx workbooks shaped like the manual templates.
// Data fidelity is the contract; styling is intentionally minimal.

const MONEY = "#,##0.00";
const PCT = "0.0%";

function pct(ty: number, ly: number): number | string {
  if (ly === 0) return ty === 0 ? "—" : "New";
  return (ty - ly) / Math.abs(ly);
}

function pctCell(row: ExcelJS.Row, col: number, ty: number, ly: number) {
  const value = pct(ty, ly);
  const cell = row.getCell(col);
  cell.value = value;
  if (typeof value === "number") cell.numFmt = PCT;
}

function moneyCell(row: ExcelJS.Row, col: number, cents: number) {
  const cell = row.getCell(col);
  cell.value = cents / 100;
  cell.numFmt = MONEY;
}

export async function buildWeeklyWorkbook(
  report: WeeklyReport,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Report");
  sheet.getColumn(1).width = 26;
  for (const c of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
    sheet.getColumn(c).width = 12;
  }

  sheet.addRow(["Té Company Weekly Report"]).font = { bold: true, size: 14 };
  sheet.addRow([
    "Date range",
    `${report.range.start} to ${report.range.end}`,
    "",
    "LY (weekday-aligned)",
    `${report.lyRange.start} to ${report.lyRange.end}`,
  ]);
  sheet.addRow([]);

  const channelHeader = sheet.addRow(["BY CHANNEL", "TY", "LY", "% to LY"]);
  channelHeader.font = { bold: true };
  const { channels } = report;
  const channelRows: Array<[string, CellPair]> = [
    ["West Village", channels.wv],
    ["East Village", channels.ev],
    ["E-Commerce", channels.ecom],
    ["Invoiced", channels.invoiced],
    [
      "TOTAL w.o. Inv",
      {
        ty: channels.wv.ty + channels.ev.ty + channels.ecom.ty,
        ly: channels.wv.ly + channels.ev.ly + channels.ecom.ly,
      },
    ],
    [
      "TOTAL w.o. Ecomm",
      {
        ty: channels.wv.ty + channels.ev.ty + channels.invoiced.ty,
        ly: channels.wv.ly + channels.ev.ly + channels.invoiced.ly,
      },
    ],
    [
      "TOTAL",
      {
        ty: channels.wv.ty + channels.ev.ty + channels.ecom.ty + channels.invoiced.ty,
        ly: channels.wv.ly + channels.ev.ly + channels.ecom.ly + channels.invoiced.ly,
      },
    ],
  ];
  for (const [label, pair] of channelRows) {
    const row = sheet.addRow([label]);
    if (label.startsWith("TOTAL")) row.font = { bold: true };
    moneyCell(row, 2, pair.ty);
    moneyCell(row, 3, pair.ly);
    pctCell(row, 4, pair.ty, pair.ly);
  }
  sheet.addRow([]);

  const catHeader = sheet.addRow([
    "BY CATEGORY",
    "TOTAL TY",
    "TOTAL LY",
    "% to LY",
    "WV TY",
    "WV LY",
    "WV %",
    "EV TY",
    "EV LY",
    "EV %",
    "Web TY",
    "Web LY",
    "Web %",
  ]);
  catHeader.font = { bold: true };
  const writeCategoryRow = (
    label: string,
    total: CellPair,
    wv?: CellPair,
    ev?: CellPair,
    ecom?: CellPair,
    bold = false,
  ) => {
    const row = sheet.addRow([label]);
    if (bold) row.font = { bold: true };
    moneyCell(row, 2, total.ty);
    moneyCell(row, 3, total.ly);
    pctCell(row, 4, total.ty, total.ly);
    if (wv && ev && ecom) {
      moneyCell(row, 5, wv.ty);
      moneyCell(row, 6, wv.ly);
      pctCell(row, 7, wv.ty, wv.ly);
      moneyCell(row, 8, ev.ty);
      moneyCell(row, 9, ev.ly);
      pctCell(row, 10, ev.ty, ev.ly);
      moneyCell(row, 11, ecom.ty);
      moneyCell(row, 12, ecom.ly);
      pctCell(row, 13, ecom.ty, ecom.ly);
    }
  };
  for (const c of report.categories) {
    writeCategoryRow(c.row.key, c.total, c.wv, c.ev, c.ecom);
  }
  sheet.addRow([]);
  writeCategoryRow("Total Retail", report.sections.retail, undefined, undefined, undefined, true);
  writeCategoryRow("Total Service", report.sections.service, undefined, undefined, undefined, true);
  writeCategoryRow("Others", report.sections.others, undefined, undefined, undefined, true);
  for (const g of report.groups) {
    writeCategoryRow(`TTL ${g.group}`, g.total, undefined, undefined, undefined, true);
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildProductSellingWorkbook(
  report: ProductSellingReport,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const summary = workbook.addWorksheet("Summary");
  summary.getColumn(2).width = 18;
  for (const c of [3, 4, 5, 6]) summary.getColumn(c).width = 14;
  summary.addRow([
    `Té Company — ${report.scope.label} Net Sales, ${report.range.start} → ${report.range.end} vs ${report.lyRange.start} → ${report.lyRange.end}`,
  ]).font = { bold: true, size: 13 };
  summary.addRow([]);
  const head = summary.addRow([
    "",
    "Channel",
    "LY Net $",
    "TY Net $",
    "$ Change",
    "% Change",
  ]);
  head.font = { bold: true };
  const channelLabels: Array<["WV" | "EV" | "ECOM" | "ALL", string]> = [
    ["WV", "West Village"],
    ["EV", "East Village"],
    ["ECOM", "E-commerce"],
    ["ALL", "ALL CHANNELS"],
  ];
  for (const [key, label] of channelLabels) {
    if (key === "ECOM" && report.scope.shopifyProductTypes.length === 0) continue;
    const totals = report.channelTotals[key];
    const row = summary.addRow(["", label]);
    if (key === "ALL") row.font = { bold: true };
    moneyCell(row, 3, totals.ly.net);
    moneyCell(row, 4, totals.ty.net);
    moneyCell(row, 5, totals.ty.net - totals.ly.net);
    pctCell(row, 6, totals.ty.net, totals.ly.net);
  }

  const addChannelSheet = (
    title: string,
    pick: (rowChannels: ProductSellingReport["rows"][number]) => {
      ty: ProductCell;
      ly: ProductCell;
    },
  ) => {
    const sheet = workbook.addWorksheet(title);
    sheet.getColumn(2).width = 42;
    for (const c of [3, 4, 5, 6, 7]) sheet.getColumn(c).width = 13;
    const header = sheet.addRow([
      "#",
      "Product",
      "LY Net $",
      "TY Net $",
      "% Change",
      "LY Units",
      "TY Units",
    ]);
    header.font = { bold: true };
    let rank = 0;
    let totals = { tyNet: 0, lyNet: 0, tyUnits: 0, lyUnits: 0 };
    const rows = report.rows
      .map((r) => ({ name: r.name, ...pick(r) }))
      .filter((r) => r.ty.net !== 0 || r.ly.net !== 0)
      .sort((a, b) => b.ty.net - a.ty.net);
    for (const r of rows) {
      rank += 1;
      const row = sheet.addRow([rank, r.name]);
      moneyCell(row, 3, r.ly.net);
      moneyCell(row, 4, r.ty.net);
      const change = pct(r.ty.net, r.ly.net);
      row.getCell(5).value = r.ty.net === 0 && r.ly.net > 0 ? "Gone" : change;
      if (typeof change === "number" && r.ty.net !== 0) row.getCell(5).numFmt = PCT;
      row.getCell(6).value = r.ly.units;
      row.getCell(7).value = r.ty.units;
      totals = {
        tyNet: totals.tyNet + r.ty.net,
        lyNet: totals.lyNet + r.ly.net,
        tyUnits: totals.tyUnits + r.ty.units,
        lyUnits: totals.lyUnits + r.ly.units,
      };
    }
    const totalRow = sheet.addRow(["", `TOTAL — ${report.scope.label} Net`]);
    totalRow.font = { bold: true };
    moneyCell(totalRow, 3, totals.lyNet);
    moneyCell(totalRow, 4, totals.tyNet);
    pctCell(totalRow, 5, totals.tyNet, totals.lyNet);
    totalRow.getCell(6).value = totals.lyUnits;
    totalRow.getCell(7).value = totals.tyUnits;
  };

  addChannelSheet("West Village", (r) => r.channels.WV);
  addChannelSheet("East Village", (r) => r.channels.EV);
  if (report.scope.shopifyProductTypes.length > 0) {
    addChannelSheet("E-commerce", (r) => r.channels.ECOM);
  }

  const combined = workbook.addWorksheet("All Channels Combined");
  combined.getColumn(2).width = 42;
  for (const c of [3, 4, 5, 6, 7, 8]) combined.getColumn(c).width = 13;
  const combinedHeader = combined.addRow([
    "#",
    "Product",
    "LY Net $ TOTAL",
    "TY Net $ TOTAL",
    "% Change",
    "WV TY $",
    "EV TY $",
    "E-com TY $",
  ]);
  combinedHeader.font = { bold: true };
  report.rows.forEach((r, index) => {
    const row = combined.addRow([index + 1, r.name]);
    moneyCell(row, 3, r.ly.net);
    moneyCell(row, 4, r.ty.net);
    pctCell(row, 5, r.ty.net, r.ly.net);
    moneyCell(row, 6, r.channels.WV.ty.net);
    moneyCell(row, 7, r.channels.EV.ty.net);
    moneyCell(row, 8, r.channels.ECOM.ty.net);
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
