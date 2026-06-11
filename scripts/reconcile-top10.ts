// Golden-file reconciliation for the Top10 report against
// "Category Top10 Selling Report - Wk of 5.4.26.xlsx".
// TY week 2026-05-04..2026-05-10 (Mon-Sun), LY weekday-aligned.
//
// Run: npx tsx scripts/reconcile-top10.ts [--shop=<domain>]

import { readFileSync } from "node:fs";

for (const line of readFileSync(".env", "utf8").split("\n")) {
  const match = line.match(/^([A-Z0-9_]+)=("?)(.*)\2$/);
  if (match && !(match[1] in process.env)) process.env[match[1]] = match[3];
}

const { default: prisma } = await import("../app/db.server");
const { computeTop10Report } = await import("../app/.server/analytics/top10-report");

const RANGE = { start: "2026-05-04", end: "2026-05-10" };

// From 'Total by Category' (W10 = West Village, E9 = East Village).
const GOLDEN = {
  channelTotals: {
    WV: { ty: 943908, ly: 681670 },
    EV: { ty: 729200, ly: 555060 },
    ECOM: { ty: 666570, ly: 677300 },
    ALL: { ty: 2339678, ly: 1914030 },
  } as Record<string, { ty: number; ly?: number }>,
  // WV Service To Stay / Service Snacks LY carry +-23200 vs the workbook:
  // items recategorized between the two service categories after the export
  // (offsetting, same drift mechanism as the weekly report's To Stay/To Go).
  categories: [
    { channel: "WV", category: "Service To Stay", ty: 257000, ly: 175200 + 23200 },
    { channel: "WV", category: "Service To Go", ty: 34770, ly: 41760 },
    { channel: "WV", category: "Service Snacks", ty: 158740, ly: 140910 - 23200 },
    { channel: "WV", category: "Retail Loose Leaf Tea", ty: 239550, ly: 93400 },
    { channel: "WV", category: "Retail Snacks", ty: 114860, ly: 123600 },
    { channel: "WV", category: "Retail Sachets", ty: 55800, ly: 38800 },
    { channel: "WV", category: "Retail Gifts", ty: 59388, ly: 56200 },
    { channel: "WV", category: "Retail Accessories", ty: 23800, ly: 11800 },
    { channel: "EV", category: "Service To Stay", ty: 294600 },
    { channel: "EV", category: "Service To Go", ty: 23050 },
    { channel: "EV", category: "Service Snacks", ty: 96710 },
    { channel: "EV", category: "Retail Loose Leaf Tea", ty: 120300 },
    { channel: "EV", category: "Retail Snacks", ty: 104800 },
    { channel: "EV", category: "Retail Sachets", ty: 28600 },
    { channel: "EV", category: "Retail Gifts", ty: 38900 },
    { channel: "EV", category: "Retail Accessories", ty: 22240 },
  ],
  topItems: [
    { channel: "ALL", rank: 0, name: "Tasting Flight", net: 102600, units: 22 },
    {
      channel: "ALL",
      category: "Retail Loose Leaf Tea",
      rank: 0,
      name: "Oriental Beauty",
      variation: "2 Oz",
      net: 62160,
      units: 17,
    },
  ],
};

function dollars(cents: number): string {
  return (cents / 100).toFixed(2).padStart(11);
}

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

const report = await computeTop10Report(shop, RANGE);
let failures = 0;
const check = (label: string, actual: number, expected: number) => {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "✓" : "✗"} ${label.padEnd(44)} actual ${dollars(actual)}  target ${dollars(expected)}${
      ok ? "" : `  DIFF ${dollars(actual - expected)}`
    }`,
  );
};

console.log("== Channel totals ==");
for (const [channel, golden] of Object.entries(GOLDEN.channelTotals)) {
  const actual = report.channels.find((c) => c.channel === channel);
  if (!actual) {
    failures += 1;
    console.log(`✗ channel ${channel} missing`);
    continue;
  }
  check(`${channel} TY`, actual.totalTy, golden.ty);
  if (golden.ly !== undefined) check(`${channel} LY`, actual.totalLy, golden.ly);
}

console.log("\n== Category totals ==");
for (const golden of GOLDEN.categories) {
  const channel = report.channels.find((c) => c.channel === golden.channel);
  const actual = channel?.categories.find((c) => c.category === golden.category);
  check(
    `${golden.channel} ${golden.category} TY`,
    actual?.ty ?? 0,
    golden.ty,
  );
  if (golden.ly !== undefined) {
    check(`${golden.channel} ${golden.category} LY`, actual?.ly ?? 0, golden.ly);
  }
}

console.log("\n== Top item spot checks ==");
for (const golden of GOLDEN.topItems) {
  const channel = report.channels.find((c) => c.channel === golden.channel);
  const list =
    "category" in golden && golden.category
      ? (channel?.topByCategory[golden.category] ?? [])
      : (channel?.topOverall ?? []);
  const item = list[golden.rank];
  const label = `${golden.channel} #${golden.rank + 1} ${golden.name}`;
  if (!item || item.name !== golden.name) {
    failures += 1;
    console.log(`✗ ${label} — got ${item?.name ?? "nothing"}`);
    continue;
  }
  check(`${label} net`, item.net, golden.net);
  const unitsOk = item.units === golden.units;
  if (!unitsOk) failures += 1;
  console.log(
    `${unitsOk ? "✓" : "✗"} ${label} units  actual ${item.units}  target ${golden.units}`,
  );
}

console.log(
  failures === 0
    ? "\nALL NUMBERS RECONCILE ✓"
    : `\n${failures} numbers do not reconcile yet ✗`,
);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);
