// Golden-file reconciliation for the product-selling report family.
// Targets from the manual workbooks:
//  - "5 - May Product Selling Teaware.xlsx"  (May 2026 vs May 2025)
//  - "YTD - Product Selling - Tea Ending 5.31.26.xlsx" (Jan 1 - May 31)
//
// Run: npx tsx scripts/reconcile-product-selling.ts [--shop=<domain>]

import { readFileSync } from "node:fs";

for (const line of readFileSync(".env", "utf8").split("\n")) {
  const match = line.match(/^([A-Z0-9_]+)=("?)(.*)\2$/);
  if (match && !(match[1] in process.env)) process.env[match[1]] = match[3];
}

const { default: prisma } = await import("../app/db.server");
const { computeProductSellingReport } = await import(
  "../app/.server/analytics/product-selling-report"
);

interface ChannelGolden {
  wv: { ty: number; ly: number };
  ev: { ty: number; ly: number };
  ecom: { ty: number; ly: number };
  all: { ty: number; ly: number };
}

// Known methodology difference: the manual YTD Tea workbook excluded the
// limited in-store "BTS" batch items (store-only small batches, almost all
// East Village). Those are real loose-leaf sales, so the engine includes
// them — within the YTD windows that's EV +$25.00 TY (S Wild '19, Feb 15
// 2026) and EV +$151.00 LY (May 31 2025 batch cluster).
const CASES: Array<{
  label: string;
  scope: string;
  range: { start: string; end: string };
  golden: ChannelGolden;
  adjust?: Partial<Record<"wv" | "ev" | "ecom" | "all", { ty: number; ly: number }>>;
}> = [
  {
    label: "May Teaware (May 2026 vs May 2025)",
    scope: "teaware",
    range: { start: "2026-05-01", end: "2026-05-31" },
    golden: {
      wv: { ty: 177600, ly: 115500 },
      ev: { ty: 113080, ly: 112450 },
      ecom: { ty: 171410, ly: 94100 },
      all: { ty: 462090, ly: 322050 },
    },
  },
  {
    label: "YTD Tea (Jan 1 - May 31)",
    scope: "tea",
    range: { start: "2026-01-01", end: "2026-05-31" },
    golden: {
      wv: { ty: 3538845, ly: 2989020 },
      ev: { ty: 2570210, ly: 1667420 },
      ecom: { ty: 5751040, ly: 4896702 },
      all: { ty: 11860095, ly: 9553142 },
    },
    adjust: {
      ev: { ty: 2500, ly: 15100 },
      all: { ty: 2500, ly: 15100 },
    },
  },
];

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

let failures = 0;
for (const testCase of CASES) {
  console.log(`== ${testCase.label} ==`);
  const report = await computeProductSellingReport(
    shop,
    testCase.scope,
    testCase.range,
  );
  const actuals: Array<[string, number, number]> = [
    ["WV", report.channelTotals.WV.ty.net, report.channelTotals.WV.ly.net],
    ["EV", report.channelTotals.EV.ty.net, report.channelTotals.EV.ly.net],
    ["ECOM", report.channelTotals.ECOM.ty.net, report.channelTotals.ECOM.ly.net],
    ["ALL", report.channelTotals.ALL.ty.net, report.channelTotals.ALL.ly.net],
  ];
  const goldenByKey: Record<string, { ty: number; ly: number }> = {
    WV: testCase.golden.wv,
    EV: testCase.golden.ev,
    ECOM: testCase.golden.ecom,
    ALL: testCase.golden.all,
  };
  const adjustByKey: Record<string, { ty: number; ly: number } | undefined> = {
    WV: testCase.adjust?.wv,
    EV: testCase.adjust?.ev,
    ECOM: testCase.adjust?.ecom,
    ALL: testCase.adjust?.all,
  };
  for (const [key, ty, ly] of actuals) {
    for (const [year, actual, golden] of [
      ["TY", ty, goldenByKey[key].ty],
      ["LY", ly, goldenByKey[key].ly],
    ] as const) {
      const adjust = adjustByKey[key]?.[year === "TY" ? "ty" : "ly"] ?? 0;
      const expected = golden + adjust;
      const ok = actual === expected;
      if (!ok) failures += 1;
      const note = adjust
        ? ` (golden ${dollars(golden)} + known difference)`
        : "";
      console.log(
        `${ok ? "✓" : "✗"} ${key} ${year}  actual ${dollars(actual)}  target ${dollars(expected)}${note}${
          ok ? "" : `  DIFF ${dollars(actual - expected)}`
        }`,
      );
    }
  }
  console.log();
}

console.log(
  failures === 0
    ? "ALL NUMBERS RECONCILE ✓"
    : `${failures} numbers do not reconcile yet ✗`,
);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);
