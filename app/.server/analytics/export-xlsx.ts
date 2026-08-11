import ExcelJS from "exceljs";
import { COMPARISON_NOTES } from "../../lib/periods";
import type { WeeklyReport, CellPair, ChannelCells } from "./weekly-report";
import type {
  ProductSellingReport,
  ProductCell,
} from "./product-selling-report";
import { SIZE_COLUMNS, type UnitsBySizeReport } from "./units-by-size-report";
import type { Top10Report } from "./top10-report";
import type { TeaByGramReport } from "./tea-by-gram-report";
import type { SnacksByUnitReport } from "./snacks-by-unit-report";

// Renders reports as .xlsx workbooks shaped like the manual templates.
// Data fidelity is the contract; styling is intentionally minimal.

const MONEY = "$#,##0.00";
const MONEY0 = "$#,##0";
const PCT = "0.0%";
const PCT0 = "0%"; // Distribution mix is whole-percent, like the manual sheet
const GRAMS = "#,##0.##";
const KILOGRAMS = "#,##0.000";

// "All borders" (dotted hairline) for boxed table blocks, applied per cell.
const ALL_BORDERS: Partial<ExcelJS.Borders> = {
  top: { style: "dotted" },
  left: { style: "dotted" },
  bottom: { style: "dotted" },
  right: { style: "dotted" },
};

// Draws a medium-weight outside border around a cell range, preserving any
// existing (e.g. thin) borders on the interior edges of the perimeter cells.
function outsideBox(
  sheet: ExcelJS.Worksheet,
  top: number,
  bottom: number,
  left: number,
  right: number,
): void {
  const edge = { style: "medium" } as const;
  for (let r = top; r <= bottom; r += 1) {
    for (let c = left; c <= right; c += 1) {
      const cell = sheet.getRow(r).getCell(c);
      cell.border = {
        ...cell.border,
        ...(r === top ? { top: edge } : {}),
        ...(r === bottom ? { bottom: edge } : {}),
        ...(c === left ? { left: edge } : {}),
        ...(c === right ? { right: edge } : {}),
      };
    }
  }
}

// Lays a weighted horizontal rule between two adjacent rows across the given
// columns, setting both coincident edges and preserving each cell's other
// (e.g. thin) borders.
function horizontalRule(
  sheet: ExcelJS.Worksheet,
  upperRow: number,
  lowerRow: number,
  cols: number[],
  style: "medium" | "thick",
): void {
  const edge = { style };
  for (const c of cols) {
    const upper = sheet.getRow(upperRow).getCell(c);
    upper.border = { ...upper.border, bottom: edge };
    const lower = sheet.getRow(lowerRow).getCell(c);
    lower.border = { ...lower.border, top: edge };
  }
}

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
  sheet.views = [{ showGridLines: false }]; // white background; only drawn borders show
  sheet.getColumn(1).width = 26;
  // Money tables (B–Q) and the Distribution percentages (T–X) center their
  // headers and numbers; the label columns (A, S) and the gap (R) stay default.
  for (let c = 2; c <= 17; c += 1) {
    sheet.getColumn(c).width = 12;
    sheet.getColumn(c).alignment = { horizontal: "center" };
  }
  sheet.getColumn(18).width = 3; // gap between By Category and Distribution
  sheet.getColumn(19).width = 22; // Distribution row labels
  for (const c of [20, 21, 22, 23, 24]) {
    sheet.getColumn(c).width = 8;
    sheet.getColumn(c).alignment = { horizontal: "center" };
  }

  sheet.addRow(["Té Company Weekly Report"]).font = { bold: true, size: 14 };
  // Leave C2 untouched (no "" spacer) so the date in B2 can spill into it,
  // matching B3. Labels stack in column A (A2 / A3); dates sit in column B.
  const dateRow = sheet.addRow([
    "Date range",
    `${report.range.start} to ${report.range.end}`,
  ]);
  const lyDateRow = sheet.addRow([
    "LY (weekday-aligned)",
    `${report.lyRange.start} to ${report.lyRange.end}`,
  ]);
  // Column B is centered for the tables below; keep the date values
  // left-aligned (left-aligned B2 also preserves its spill into C2).
  dateRow.getCell(2).alignment = { horizontal: "left" };
  lyDateRow.getCell(2).alignment = { horizontal: "left" };
  sheet.addRow([]);

  const channelHeader = sheet.addRow([
    "BY CHANNEL",
    "TY",
    "LY",
    "AVG 6 WK",
    "% to LY",
  ]);
  channelHeader.font = { bold: true };
  const { grand, invoiced, invoicedAvg6, totals } = report;
  const channelRows: Array<[string, CellPair, number]> = [
    ["West Village", grand.wv, grand.avg6.wv],
    ["East Village", grand.ev, grand.avg6.ev],
    ["E-Commerce", grand.ecom, grand.avg6.ecom],
    ["Invoiced", invoiced, invoicedAvg6],
    ["TOTAL w.o. Inv", grand.total, grand.avg6.total],
    [
      "TOTAL w.o. Ecomm",
      totals.woEcom,
      grand.avg6.wv + grand.avg6.ev + invoicedAvg6,
    ],
    ["TOTAL", totals.all, grand.avg6.total + invoicedAvg6],
  ];
  for (const [label, pair, avg6] of channelRows) {
    const row = sheet.addRow([label]);
    if (label.startsWith("TOTAL")) row.font = { bold: true };
    moneyCell(row, 2, pair.ty);
    moneyCell(row, 3, pair.ly);
    moneyCell(row, 4, avg6);
    pctCell(row, 5, pair.ty, pair.ly);
    // All-borders box around the four channel rows (A–E); TOTAL rows excluded.
    if (!label.startsWith("TOTAL")) {
      for (let c = 1; c <= 5; c += 1) row.getCell(c).border = ALL_BORDERS;
    }
  }
  sheet.addRow([]);

  // By Category (columns A–Q) and Distribution (columns S–X) sit side by side
  // on shared rows. Distribution prints no grand-total rows, so where By
  // Category prints a TOTAL the Distribution side stays blank — which keeps
  // the two tables row-aligned and supplies the spacing on that side.
  // Every group — TOTAL and each store channel — carries its trailing-six-week
  // weekly average (AVG 6 WK) between its LY and % columns.
  const catHeader = sheet.addRow([
    "BY CATEGORY",
    "TOTAL TY",
    "TOTAL LY",
    "AVG 6 WK",
    "% to LY",
    "WV TY",
    "WV LY",
    "AVG 6 WK",
    "WV %",
    "EV TY",
    "EV LY",
    "AVG 6 WK",
    "EV %",
    "Web TY",
    "Web LY",
    "AVG 6 WK",
    "Web %",
  ]);
  ["DISTRIBUTION", "TOTAL", "STRS", "WV", "EV", "WEB"].forEach((h, i) => {
    catHeader.getCell(19 + i).value = h;
  });
  catHeader.font = { bold: true };
  // All three blocks (categories, sections, groups) foot to the same grand
  // total (report.grand), so each ends with it. Invoiced is uncategorized,
  // so it's excluded.
  const distDenom = {
    total: grand.total.ty,
    strs: grand.wv.ty + grand.ev.ty,
    wv: grand.wv.ty,
    ev: grand.ev.ty,
    web: grand.ecom.ty,
  };
  const share = (value: number, denom: number) =>
    denom === 0 ? 0 : value / denom;

  // Writes the By Category money cells (cols 1–17) onto an existing row.
  const catCells = (row: ExcelJS.Row, label: string, c: ChannelCells) => {
    row.getCell(1).value = label;
    moneyCell(row, 2, c.total.ty);
    moneyCell(row, 3, c.total.ly);
    moneyCell(row, 4, c.avg6.total);
    pctCell(row, 5, c.total.ty, c.total.ly);
    moneyCell(row, 6, c.wv.ty);
    moneyCell(row, 7, c.wv.ly);
    moneyCell(row, 8, c.avg6.wv);
    pctCell(row, 9, c.wv.ty, c.wv.ly);
    moneyCell(row, 10, c.ev.ty);
    moneyCell(row, 11, c.ev.ly);
    moneyCell(row, 12, c.avg6.ev);
    pctCell(row, 13, c.ev.ty, c.ev.ly);
    moneyCell(row, 14, c.ecom.ty);
    moneyCell(row, 15, c.ecom.ly);
    moneyCell(row, 16, c.avg6.ecom);
    pctCell(row, 17, c.ecom.ty, c.ecom.ly);
  };

  // Writes the Distribution percentage cells (cols 19–24) onto an existing row.
  const distCells = (row: ExcelJS.Row, label: string, c: ChannelCells) => {
    row.getCell(19).value = label;
    const vals: Array<[number, number]> = [
      [c.total.ty, distDenom.total],
      [c.wv.ty + c.ev.ty, distDenom.strs],
      [c.wv.ty, distDenom.wv],
      [c.ev.ty, distDenom.ev],
      [c.ecom.ty, distDenom.web],
    ];
    vals.forEach(([value, denom], i) => {
      const cell = row.getCell(20 + i);
      cell.value = share(value, denom);
      cell.numFmt = PCT0;
    });
  };

  // One category / section / group line: By Category (left) and Distribution
  // (right) share the same sheet row.
  const dataRow = (label: string, c: ChannelCells, bold = false) => {
    const row = sheet.addRow([]);
    if (bold) row.font = { bold: true };
    catCells(row, label, c);
    distCells(row, label, c);
    // Box each data row across the By Category (A–Q) and Distribution (S–X)
    // tables; column R is the gap between them, left unboxed.
    for (let col = 1; col <= 24; col += 1) {
      if (col !== 18) row.getCell(col).border = ALL_BORDERS;
    }
    return row;
  };

  // A grand-total line. By Category always shows the dollar total. The
  // Distribution side only foots the section and group blocks — each column
  // sums to 100% there — not the raw category list.
  const totalRow = (withDist = false) => {
    const row = sheet.addRow([]);
    row.font = { bold: true };
    catCells(row, "TOTAL", grand);
    if (withDist) distCells(row, "TOTAL", grand);
    return row;
  };

  let firstServiceRow = 0;
  let lastServiceRow = 0;
  for (const c of report.categories) {
    const row = dataRow(c.row.key, c);
    if (c.row.section === "service") {
      if (firstServiceRow === 0) firstServiceRow = row.number;
      lastServiceRow = row.number;
    }
  }
  totalRow();
  sheet.addRow([]);
  dataRow("Total Retail", report.sections.retail, true);
  dataRow("Total Service", report.sections.service, true);
  dataRow("Others", report.sections.others, true);
  totalRow(true);
  sheet.addRow([]);
  for (const g of report.groups) dataRow(`TTL ${g.group}`, g, true);
  const lastTotal = totalRow(true);

  // Medium-weight outside box around the By Category totals (TOTAL TY /
  // TOTAL LY / AVG 6 WK / % to LY), from the BY CATEGORY header (row 14) down
  // to the final groups total (row 36 today) — anchored to the rows so it
  // never drifts.
  outsideBox(sheet, catHeader.number, lastTotal.number, 2, 5);

  // Medium rules bracketing the Service section (rows 20–22 today) across the
  // By Category (A–Q) and Distribution (S–X) tables — anchored to the section.
  if (firstServiceRow > 0) {
    const tableCols = Array.from({ length: 24 }, (_, i) => i + 1).filter(
      (col) => col !== 18,
    );
    horizontalRule(
      sheet,
      firstServiceRow - 1,
      firstServiceRow,
      tableCols,
      "medium",
    );
    horizontalRule(
      sheet,
      lastServiceRow,
      lastServiceRow + 1,
      tableCols,
      "medium",
    );
  }

  // Weekly meeting report shows whole dollars and whole percents (no decimals).
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      if (cell.numFmt === MONEY) cell.numFmt = MONEY0;
      else if (cell.numFmt === PCT) cell.numFmt = PCT0;
    });
  });

  // Peach highlight on the BY CATEGORY % change columns (% to LY, WV %, EV %,
  // Web %), from the header (row 14) to the final total (36). Blank separator
  // rows (empty column A) are skipped, so the band breaks into three blocks.
  const pctFill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFBE2D5" },
  };
  for (let r = catHeader.number; r <= lastTotal.number; r += 1) {
    if (!sheet.getRow(r).getCell(1).value) continue; // skip blank separator rows
    for (const col of [5, 9, 13, 17]) {
      sheet.getRow(r).getCell(col).fill = pctFill;
    }
  }
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
    if (key === "ECOM" && report.scope.shopifyProductTypes.length === 0)
      continue;
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
      if (typeof change === "number" && r.ty.net !== 0)
        row.getCell(5).numFmt = PCT;
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

function writeSnacksByUnitSheet(
  workbook: ExcelJS.Workbook,
  report: SnacksByUnitReport,
  title = "Snacks by Unit",
): void {
  const sheet = workbook.addWorksheet(title.slice(0, 31));
  sheet.getColumn(1).width = 42;
  sheet.getColumn(2).width = 24;
  for (let column = 3; column <= report.channels.length + 3; column += 1) {
    sheet.getColumn(column).width = 14;
  }
  sheet.addRow([
    `Snacks — Kitchen Units · ${report.range.start} → ${report.range.end} · packs and gifts converted; returns subtract`,
  ]).font = { bold: true, size: 13 };
  const header = sheet.addRow([
    "Snack",
    "Category",
    ...report.channels,
    "Total Units",
  ]);
  header.font = { bold: true };
  for (const reportRow of report.rows) {
    sheet.addRow([
      reportRow.name,
      reportRow.category,
      ...report.channels.map((channel) => reportRow.byChannel[channel]),
      reportRow.totalUnits,
    ]);
  }
  const total = sheet.addRow([
    "TOTAL",
    "",
    ...report.channels.map((channel) => report.totalsByChannel[channel]),
    report.totalUnits,
  ]);
  total.font = { bold: true };

  if (report.unmapped.length > 0) {
    sheet.addRow([]);
    sheet.addRow(["Unmapped snack SKUs — excluded from totals"]).font = {
      bold: true,
    };
    sheet.addRow(["SKU", "Snack", "Channel", "Sold Quantity"]).font = {
      bold: true,
    };
    for (const row of report.unmapped) {
      sheet.addRow([row.sku ?? "", row.name, row.channel, row.quantity]);
    }
  }
}

export async function buildSnacksByUnitWorkbook(
  report: SnacksByUnitReport,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  writeSnacksByUnitSheet(workbook, report);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function writeTeaByGramSheets(
  workbook: ExcelJS.Workbook,
  report: TeaByGramReport,
  prefix = "",
): void {
  const summary = workbook.addWorksheet(`${prefix}Tea by Gram`.slice(0, 31));
  summary.getColumn(1).width = 12;
  summary.getColumn(2).width = 36;
  for (let c = 3; c <= report.channels.length + 4; c += 1) {
    summary.getColumn(c).width = 13;
  }
  summary.addRow([
    `Tea usage · ${report.range.start} → ${report.range.end} · positive sales only (returns ignored; gift sets decomposed by recipe)`,
  ]).font = { bold: true };
  const summaryHeader = summary.addRow([
    "SKU Family",
    "Tea",
    ...report.channels.map((channel) => `${channel} g`),
    "Total g",
    "Total kg",
  ]);
  summaryHeader.font = { bold: true };
  for (const reportRow of report.rows) {
    const row = summary.addRow([
      reportRow.skuFamily ?? "",
      reportRow.name,
      ...report.channels.map((channel) => reportRow.byChannel[channel] ?? 0),
      reportRow.totalGrams,
      reportRow.totalKilograms,
    ]);
    for (let c = 3; c < row.cellCount; c += 1) row.getCell(c).numFmt = GRAMS;
    row.getCell(row.cellCount).numFmt = KILOGRAMS;
  }
  const total = summary.addRow([
    "",
    "TOTAL",
    ...report.channels.map((channel) =>
      report.rows.reduce(
        (sum, reportRow) => sum + (reportRow.byChannel[channel] ?? 0),
        0,
      ),
    ),
    report.totalGrams,
    report.totalKilograms,
  ]);
  total.font = { bold: true };
  for (let c = 3; c < total.cellCount; c += 1) total.getCell(c).numFmt = GRAMS;
  total.getCell(total.cellCount).numFmt = KILOGRAMS;

  const bags = workbook.addWorksheet(`${prefix}Tea Bags by Count`.slice(0, 31));
  const bagWidths = [14, 42, 14, ...report.channels.map(() => 13), 16];
  bagWidths.forEach((width, index) => {
    bags.getColumn(index + 1).width = width;
  });
  bags.addRow([
    `Tea bags · ${report.range.start} → ${report.range.end} · counted separately from loose-leaf grams`,
  ]).font = { bold: true };
  const bagHeader = bags.addRow([
    "SKU",
    "Gift",
    "Bags / gift",
    ...report.channels.map((channel) => `${channel} bags`),
    "Total tea bags",
  ]);
  bagHeader.font = { bold: true };
  for (const reportRow of report.teaBagRows) {
    const row = bags.addRow([
      reportRow.sku,
      reportRow.gift,
      reportRow.teaBagsPerUnit,
      ...report.channels.map((channel) => reportRow.byChannel[channel] ?? 0),
      reportRow.totalTeaBags,
    ]);
    for (let c = 3; c <= row.cellCount; c += 1) {
      row.getCell(c).numFmt = "#,##0";
    }
  }
  if (report.teaBagRows.length > 0) {
    const bagTotal = bags.addRow([
      "",
      "TOTAL",
      "",
      ...report.channels.map((channel) =>
        report.teaBagRows.reduce(
          (sum, reportRow) => sum + (reportRow.byChannel[channel] ?? 0),
          0,
        ),
      ),
      report.totalTeaBags,
    ]);
    bagTotal.font = { bold: true };
    for (let c = 4; c <= bagTotal.cellCount; c += 1) {
      bagTotal.getCell(c).numFmt = "#,##0";
    }
  }

  const detail = workbook.addWorksheet(`${prefix}Gram SKU Detail`.slice(0, 31));
  const detailWidths = [12, 32, 12, 20, 12, 18, 13, 12, 13, 13];
  detailWidths.forEach((width, index) => {
    detail.getColumn(index + 1).width = width;
  });
  const detailHeader = detail.addRow([
    "SKU Family",
    "Tea",
    "SKU",
    "Variant",
    "Channel",
    "Conversion",
    "Grams / unit",
    "Units sold",
    "Total g",
    "Total kg",
  ]);
  detailHeader.font = { bold: true };
  for (const reportRow of report.skuRows) {
    const row = detail.addRow([
      reportRow.skuFamily ?? "",
      reportRow.tea,
      reportRow.sku,
      reportRow.variant,
      reportRow.channel,
      reportRow.basis,
      reportRow.gramsPerUnit,
      reportRow.units,
      reportRow.totalGrams,
      reportRow.totalGrams / 1_000,
    ]);
    for (const c of [7, 8, 9]) row.getCell(c).numFmt = GRAMS;
    row.getCell(10).numFmt = KILOGRAMS;
  }

  const audit = workbook.addWorksheet(`${prefix}Gram Unmapped`.slice(0, 31));
  const auditWidths = [14, 36, 22, 26, 12, 12, 46];
  auditWidths.forEach((width, index) => {
    audit.getColumn(index + 1).width = width;
  });
  audit.addRow([
    "Tea lines and gift components that need conversion or SKU-family review.",
  ]).font = { bold: true };
  const auditHeader = audit.addRow([
    "SKU",
    "Item",
    "Variant",
    "Category",
    "Channel",
    "Units",
    "Reason",
  ]);
  auditHeader.font = { bold: true };
  for (const reportRow of report.unmapped) {
    const row = audit.addRow([
      reportRow.sku,
      reportRow.item,
      reportRow.variant,
      reportRow.category,
      reportRow.channel,
      reportRow.units,
      reportRow.reason,
    ]);
    row.getCell(6).numFmt = GRAMS;
  }
}

export async function buildTeaByGramWorkbook(
  report: TeaByGramReport,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  writeTeaByGramSheets(workbook, report);
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
    `Net sales by category · ${report.range.start} → ${report.range.end} vs ${report.lyRange.start} → ${report.lyRange.end} (${COMPARISON_NOTES[report.compare]}) · invoiced excluded`,
  ]).font = { bold: true };
  for (const channel of report.channels) {
    summary.addRow([]);
    const head = summary.addRow([
      channel.channel,
      "Category",
      "TY",
      "LY",
      "% to LY",
      "TY % pen",
    ]);
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
    const sheet = workbook.addWorksheet(
      `${prefix}Top10 ${channel.channel}`.slice(0, 31),
    );
    sheet.getColumn(2).width = 44;
    sheet.getColumn(3).width = 12;
    sheet.getColumn(4).width = 8;
    const writeList = (
      label: string,
      items: Top10Report["channels"][number]["topOverall"],
    ) => {
      sheet.addRow([]);
      sheet.addRow([label]).font = { bold: true };
      const head = sheet.addRow(["#", "Product", "Net $", "Units"]);
      head.font = { bold: true };
      items.forEach((item, index) => {
        const row = sheet.addRow([index + 1, item.name]);
        moneyCell(row, 3, item.net);
        row.getCell(4).value = item.units;
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
// report, a combined product-selling sheet per category, the Top10 category
// summary, units-by-size totals, tea usage, and converted snack kitchen units.
export async function buildAllReportsWorkbook(
  weekly: WeeklyReport,
  productReports: ProductSellingReport[],
  top10: Top10Report,
  units: UnitsBySizeReport,
  grams: TeaByGramReport,
  snacks: SnacksByUnitReport,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  writeWeeklySheet(workbook, weekly, "Weekly Report");
  for (const report of productReports) {
    writeProductCombinedSheet(
      workbook,
      report,
      report.scope.label.slice(0, 31),
    );
  }
  writeTop10Sheets(workbook, top10, "T10 ");
  writeUnitsSheet(workbook, units, "Units by Size", null);
  writeTeaByGramSheets(workbook, grams);
  writeSnacksByUnitSheet(workbook, snacks);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
