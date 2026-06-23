import ExcelJS from "exceljs";
import type { WeeklyReport, CellPair, ChannelCells } from "./weekly-report";
import type { ProductSellingReport, ProductCell } from "./product-selling-report";
import { SIZE_COLUMNS, type UnitsBySizeReport } from "./units-by-size-report";
import type { Top10Report } from "./top10-report";

// Renders reports as .xlsx workbooks shaped like the manual templates.
// Data fidelity is the contract; styling is intentionally minimal.

const MONEY = "#,##0.00";
const PCT = "0.0%";
const PCT0 = "0%"; // Distribution mix is whole-percent, like the manual sheet

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

function writeWeeklySheet(
  workbook: ExcelJS.Workbook,
  report: WeeklyReport,
  title = "Report",
): void {
  const sheet = workbook.addWorksheet(title);
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
  const writeChannelCellsRow = (label: string, c: ChannelCells) =>
    writeCategoryRow(label, c.total, c.wv, c.ev, c.ecom, true);
  writeChannelCellsRow("Total Retail", report.sections.retail);
  writeChannelCellsRow("Total Service", report.sections.service);
  writeChannelCellsRow("Others", report.sections.others);
  sheet.addRow([]);
  for (const g of report.groups) {
    writeChannelCellsRow(`TTL ${g.group}`, g);
  }

  // Distribution: the same category / section / group roll-ups expressed as
  // each row's share of its column. Columns are TOTAL (WV+EV+Web), STRS
  // (WV+EV), WV, EV, WEB — TY only, like the manual template.
  sheet.addRow([]);
  const distHeader = sheet.addRow(["DISTRIBUTION", "TOTAL", "STRS", "WV", "EV", "WEB"]);
  distHeader.font = { bold: true };
  const distDenom = {
    total: channels.wv.ty + channels.ev.ty + channels.ecom.ty,
    strs: channels.wv.ty + channels.ev.ty,
    wv: channels.wv.ty,
    ev: channels.ev.ty,
    web: channels.ecom.ty,
  };
  const share = (value: number, denom: number) => (denom === 0 ? 0 : value / denom);
  const writeDistRow = (label: string, c: ChannelCells, bold = false) => {
    const row = sheet.addRow([label]);
    if (bold) row.font = { bold: true };
    const cells: Array<[number, number]> = [
      [c.total.ty, distDenom.total],
      [c.wv.ty + c.ev.ty, distDenom.strs],
      [c.wv.ty, distDenom.wv],
      [c.ev.ty, distDenom.ev],
      [c.ecom.ty, distDenom.web],
    ];
    cells.forEach(([value, denom], i) => {
      const cell = row.getCell(2 + i);
      cell.value = share(value, denom);
      cell.numFmt = PCT0;
    });
  };
  for (const c of report.categories) writeDistRow(c.row.key, c);
  sheet.addRow([]);
  writeDistRow("Total Retail", report.sections.retail, true);
  writeDistRow("Total Service", report.sections.service, true);
  writeDistRow("Others", report.sections.others, true);
  sheet.addRow([]);
  for (const g of report.groups) writeDistRow(`TTL ${g.group}`, g, true);
}

export async function buildWeeklyWorkbook(
  report: WeeklyReport,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  writeWeeklySheet(workbook, report);
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

  writeProductCombinedSheet(workbook, report, "All Channels Combined");

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function writeProductCombinedSheet(
  workbook: ExcelJS.Workbook,
  report: ProductSellingReport,
  title: string,
): void {
  const combined = workbook.addWorksheet(title);
  combined.getColumn(2).width = 42;
  for (const c of [3, 4, 5, 6, 7, 8]) combined.getColumn(c).width = 13;
  combined.addRow([
    `${report.scope.label} — ${report.range.start} → ${report.range.end} vs ${report.lyRange.start} → ${report.lyRange.end}`,
  ]).font = { bold: true };
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
  const totalRow = combined.addRow(["", "TOTAL"]);
  totalRow.font = { bold: true };
  moneyCell(totalRow, 3, report.channelTotals.ALL.ly.net);
  moneyCell(totalRow, 4, report.channelTotals.ALL.ty.net);
  pctCell(
    totalRow,
    5,
    report.channelTotals.ALL.ty.net,
    report.channelTotals.ALL.ly.net,
  );
}

function writeUnitsSheet(
  workbook: ExcelJS.Workbook,
  report: UnitsBySizeReport,
  title: string,
  channel: string | null, // null = totals across channels
): void {
  const sheet = workbook.addWorksheet(title);
  sheet.getColumn(1).width = 8;
  sheet.getColumn(2).width = 36;
  for (let c = 3; c <= 9; c += 1) sheet.getColumn(c).width = 10;
  sheet.addRow([
    `Loose Leaf Tea — Unit Sales ${channel ?? "Total"} · ${report.range.start} → ${report.range.end} · net units after returns`,
  ]).font = { bold: true };
  const header = sheet.addRow(["Style #", "Tea", ...SIZE_COLUMNS, "Total"]);
  header.font = { bold: true };
  for (const row of report.rows) {
    const sizes = channel ? row.byChannel[channel] : row.total;
    if (!sizes) continue;
    const total = SIZE_COLUMNS.reduce((sum, size) => sum + sizes[size], 0);
    if (total === 0) continue;
    sheet.addRow([
      row.styleNumber ?? "",
      row.name,
      ...SIZE_COLUMNS.map((size) => sizes[size]),
      total,
    ]);
  }
}

export async function buildUnitsBySizeWorkbook(
  report: UnitsBySizeReport,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const channel of report.channels) {
    writeUnitsSheet(workbook, report, channel, channel);
  }
  writeUnitsSheet(workbook, report, "Total", null);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function writeTop10Sheets(
  workbook: ExcelJS.Workbook,
  report: Top10Report,
  prefix = "",
): void {
  const summary = workbook.addWorksheet(`${prefix}By Category`.slice(0, 31));
  summary.getColumn(1).width = 14;
  summary.getColumn(2).width = 28;
  for (const c of [3, 4, 5, 6]) summary.getColumn(c).width = 12;
  summary.addRow([
    `Net sales by category · ${report.range.start} → ${report.range.end} vs ${report.lyRange.start} → ${report.lyRange.end} (weekday-aligned) · invoiced excluded`,
  ]).font = { bold: true };
  for (const channel of report.channels) {
    summary.addRow([]);
    const head = summary.addRow([channel.channel, "Category", "TY", "LY", "% to LY", "TY % pen"]);
    head.font = { bold: true };
    for (const category of channel.categories) {
      const row = summary.addRow(["", category.category]);
      moneyCell(row, 3, category.ty);
      moneyCell(row, 4, category.ly);
      pctCell(row, 5, category.ty, category.ly);
      row.getCell(6).value = category.tyPenetration;
      row.getCell(6).numFmt = PCT;
    }
    const totalRow = summary.addRow(["", "TOTAL"]);
    totalRow.font = { bold: true };
    moneyCell(totalRow, 3, channel.totalTy);
    moneyCell(totalRow, 4, channel.totalLy);
    pctCell(totalRow, 5, channel.totalTy, channel.totalLy);
  }

  for (const channel of report.channels) {
    const sheet = workbook.addWorksheet(`${prefix}Top10 ${channel.channel}`.slice(0, 31));
    sheet.getColumn(2).width = 38;
    sheet.getColumn(3).width = 16;
    sheet.getColumn(4).width = 12;
    sheet.getColumn(5).width = 8;
    const writeList = (
      label: string,
      items: Top10Report["channels"][number]["topOverall"],
    ) => {
      sheet.addRow([]);
      sheet.addRow([label]).font = { bold: true };
      const head = sheet.addRow(["#", "Item", "Variation", "Net $", "Units"]);
      head.font = { bold: true };
      items.forEach((item, index) => {
        const row = sheet.addRow([index + 1, item.name, item.variation ?? ""]);
        moneyCell(row, 4, item.net);
        row.getCell(5).value = item.units;
      });
    };
    writeList("All Categories", channel.topOverall);
    for (const category of channel.categories) {
      const items = channel.topByCategory[category.category];
      if (items?.length) writeList(category.category, items);
    }
  }
}

export async function buildTop10Workbook(report: Top10Report): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  writeTop10Sheets(workbook, report);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// One workbook with everything for the chosen period: the weekly meeting
// report, a combined product-selling sheet per category, the Top10
// category summary, and the units-by-size totals.
export async function buildAllReportsWorkbook(
  weekly: WeeklyReport,
  productReports: ProductSellingReport[],
  top10: Top10Report,
  units: UnitsBySizeReport,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  writeWeeklySheet(workbook, weekly, "Weekly Report");
  for (const report of productReports) {
    writeProductCombinedSheet(workbook, report, report.scope.label.slice(0, 31));
  }
  writeTop10Sheets(workbook, top10, "T10 ");
  writeUnitsSheet(workbook, units, "Units by Size", null);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
