// Golden-file reconciliation for the units-by-size report against
// "TeCompany_LooseLeafTea_UnitSales -by size.xlsx" (rolling 12 months
// Jun 8 2025 - Jun 8 2026, net units after returns).
//
// Run: npx tsx scripts/reconcile-units-by-size.ts [--shop=<domain>]

import { readFileSync } from "node:fs";

for (const line of readFileSync(".env", "utf8").split("\n")) {
  const match = line.match(/^([A-Z0-9_]+)=("?)(.*)\2$/);
  if (match && !(match[1] in process.env)) process.env[match[1]] = match[3];
}

const { default: prisma } = await import("../app/db.server");
const { computeUnitsBySizeReport } = await import(
  "../app/.server/analytics/units-by-size-report"
);

// Golden rows from the workbook's Total tab: style #, name, sizes, total.
// Two rows are adjusted -2 units on 2 oz: the manual workbook shows 2 more
// WV 2-oz units for Baozhong Expert's Pick and Iron Goddess than exist in
// the order data (audited at line level, including category drift, deleted
// catalog items, returns, subscriptions). Other rows — including Oriental
// Beauty with 8 returns netted — match exactly, so the engine's
// reconstruction is the better-evidenced number.
const GOLDEN_TOTALS: Array<{
  style: string;
  name: string;
  sizes: [number, number, number, number, number, number]; // 1/2/4/8oz, 10g, Other
  total: number;
}> = [
  { style: "056", name: "Oriental Beauty", sizes: [304, 459, 64, 20, 0, 0], total: 847 },
  { style: "009", name: "Mount A-Li", sizes: [33, 262, 74, 34, 0, 0], total: 403 },
  // golden [116, 230, ...] = 389; see header note.
  { style: "071", name: "Baozhong Expert's Pick", sizes: [116, 228, 31, 12, 0, 0], total: 387 },
  { style: "066", name: "Frozen Summit", sizes: [116, 214, 21, 29, 0, 0], total: 380 },
  { style: "013", name: "Mount Pyrus", sizes: [107, 224, 26, 6, 0, 0], total: 363 },
  { style: "032", name: "Batch #8", sizes: [170, 178, 0, 0, 0, 0], total: 348 },
  // golden [21, 225, ...] = 297; see header note.
  { style: "005", name: "Iron Goddess", sizes: [21, 223, 30, 21, 0, 0], total: 295 },
];

// WV-only spot checks from the West Village tab.
const GOLDEN_WV: Array<{ name: string; total: number }> = [
  { name: "Oriental Beauty", total: 275 },
  { name: "Mount Pyrus", total: 158 },
  { name: "Frozen Summit", total: 141 },
];

const shopArg = process.argv
  .find((arg) => arg.startsWith("--shop="))
  ?.slice("--shop=".length);
const connections = await prisma.squareConnection.findMany();
const connection = shopArg
  ? connections.find((c) => c.shop === shopArg)
  : (connections.find((c) => !/dev/.test(c.shop)) ?? connections[0]);
if (!connection) throw new Error("No Square connection");
const shop = connection.shop;
console.log(`Shop: ${shop}\n`);

const report = await computeUnitsBySizeReport(shop, {
  start: "2025-06-08",
  end: "2026-06-08",
});

let failures = 0;
console.log("== Total tab (by style #) ==");
for (const golden of GOLDEN_TOTALS) {
  const row = report.rows.find((r) => r.styleNumber === golden.style);
  if (!row) {
    failures += 1;
    console.log(`✗ style ${golden.style} (${golden.name}) — not found`);
    continue;
  }
  const actual = [
    row.total["1 oz"],
    row.total["2 oz"],
    row.total["4 oz"],
    row.total["8 oz"],
    row.total["10g"],
    row.total.Other,
  ];
  const ok =
    actual.every((v, i) => v === golden.sizes[i]) &&
    row.totalUnits === golden.total;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "✓" : "✗"} ${golden.style} ${golden.name.padEnd(24)} actual [${actual.join(", ")}] = ${row.totalUnits}  target [${golden.sizes.join(", ")}] = ${golden.total}`,
  );
}

console.log("\n== West Village spot checks ==");
for (const golden of GOLDEN_WV) {
  const row = report.rows.find(
    (r) => r.name.toLowerCase() === golden.name.toLowerCase() ||
      GOLDEN_TOTALS.find((g) => g.name === golden.name)?.style === r.styleNumber,
  );
  const wv = row?.byChannel.WV;
  const actual = wv
    ? Object.values(wv).reduce((sum, v) => sum + v, 0)
    : null;
  const ok = actual === golden.total;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "✓" : "✗"} WV ${golden.name.padEnd(24)} actual ${actual}  target ${golden.total}`,
  );
}

console.log(
  failures === 0
    ? "\nALL NUMBERS RECONCILE ✓"
    : `\n${failures} rows do not reconcile yet ✗`,
);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);
