// Golden-file reconciliation for the analytics engine. Syncs the golden
// week (TY + weekday-aligned LY) from both channels, computes the weekly
// report, and diffs every number against the manual spreadsheet
// "Wkly Mtg Report - 2026-06-01 - 2026-06-07.xlsx".
//
// Run: npx tsx scripts/reconcile-weekly.ts [--skip-sync]

import { readFileSync } from "node:fs";

// Minimal .env loader (no dotenv dependency).
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const match = line.match(/^([A-Z0-9_]+)=("?)(.*)\2$/);
  if (match && !(match[1] in process.env)) process.env[match[1]] = match[3];
}

const { default: prisma } = await import("../app/db.server");
const { syncSquareOrders } = await import("../app/.server/analytics/square-sync");
const { syncShopifyOrders } = await import("../app/.server/analytics/shopify-sync");
const { computeWeeklyReport } = await import("../app/.server/analytics/weekly-report");

const TY = { start: "2026-06-01", end: "2026-06-07" };
const LY = { start: "2025-06-02", end: "2025-06-08" };

// Golden numbers (cents) from the manual workbook.
const GOLDEN = {
  channels: {
    wv: { ty: 780395, ly: 516695 },
    ev: { ty: 645365, ly: 522000 },
    ecom: { ty: 433150, ly: 350750 },
    invoiced: { ty: 359360, ly: 303270 },
  },
  categories: {
    "Retail Loose Leaf Tea": { ty: 452980, ly: 306800 },
    "Retail Snacks": { ty: 224200, ly: 153200 },
    "Retail Gifts": { ty: 142700, ly: 170400 },
    "Retail Sachets": { ty: 83980, ly: 45400 },
    "Retail Accessories": { ty: 77640, ly: 62550 },
    "Service To Stay": { ty: 505105, ly: 385300 },
    "Service Snacks": { ty: 244850, ly: 176240 },
    "Service To Go": { ty: 98255, ly: 62355 },
    Uncategorized: { ty: 29200, ly: 27200 },
    Teaware: { ty: 0, ly: 0 },
  } as Record<string, { ty: number; ly: number }>,
};

// Known post-export drift — places where today's catalogs disagree with the
// catalogs as they stood when the manual export was made. Totals unaffected.
// 1. 4 Shopify products re-typed "Accessories" → "Teaware" (verified via
//    ShopifyQL 2026-06-11).
// 2. Square iced-tea "(TO STAY)" items were created 2026-05-22 under the
//    Service To Go category and corrected to Service To Stay on 2026-06-08
//    (item 42TGOJRG5OAF3PSRY6K56MYJ updated_at) — after the export. The
//    export booked them under To Go; current categories book them To Stay.
const KNOWN_DRIFT: Record<string, { ty: number; ly: number }> = {
  "Retail Accessories": { ty: -14600, ly: -17850 },
  Teaware: { ty: 14600, ly: 17850 },
  "Service To Stay": { ty: 16250, ly: 11700 },
  "Service To Go": { ty: -16250, ly: -11700 },
};

function dollars(cents: number): string {
  return (cents / 100).toFixed(2).padStart(10);
}

function check(
  label: string,
  actual: number,
  expected: number,
  driftAdjusted?: number,
): boolean {
  const target = expected + (driftAdjusted ?? 0);
  const diff = actual - target;
  const ok = diff === 0;
  const flag = ok ? "✓" : "✗";
  const driftNote = driftAdjusted ? ` (golden ${dollars(expected)} + known drift)` : "";
  console.log(
    `${flag} ${label.padEnd(34)} actual ${dollars(actual)}  target ${dollars(target)}${driftNote}${
      ok ? "" : `  DIFF ${dollars(diff)}`
    }`,
  );
  return ok;
}

async function main() {
  // --shop=<domain> targets a specific shop; otherwise prefer the real
  // store over the dev store when both are connected.
  const shopArg = process.argv
    .find((arg) => arg.startsWith("--shop="))
    ?.slice("--shop=".length);
  const connections = await prisma.squareConnection.findMany();
  if (connections.length === 0) throw new Error("No Square connection in DB");
  const connection = shopArg
    ? connections.find((c) => c.shop === shopArg)
    : (connections.find((c) => !/dev/.test(c.shop)) ?? connections[0]);
  if (!connection) throw new Error(`No Square connection for ${shopArg}`);
  const shop = connection.shop;
  console.log(`Shop: ${shop}\n`);

  if (!process.argv.includes("--skip-sync")) {
    const session = await prisma.session.findFirst({
      where: { shop, isOnline: false },
    });
    if (!session) throw new Error(`No offline session for ${shop}`);
    const admin = {
      graphql: (query: string, options?: { variables?: Record<string, unknown> }) =>
        fetch(`https://${shop}/admin/api/2026-07/graphql.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": session.accessToken,
          },
          body: JSON.stringify({ query, variables: options?.variables }),
        }),
    };

    for (const range of [TY, LY]) {
      console.log(`Syncing Square ${range.start} → ${range.end}…`);
      console.log("  ", await syncSquareOrders(shop, range));
      console.log(`Syncing Shopify ${range.start} → ${range.end}…`);
      console.log("  ", await syncShopifyOrders(shop, admin, range));
    }
    console.log();
  }

  const report = await computeWeeklyReport(shop, TY);
  let failures = 0;
  const tally = (ok: boolean) => {
    if (!ok) failures += 1;
  };

  console.log("== BY CHANNEL ==");
  tally(check("West Village TY", report.channels.wv.ty, GOLDEN.channels.wv.ty));
  tally(check("West Village LY", report.channels.wv.ly, GOLDEN.channels.wv.ly));
  tally(check("East Village TY", report.channels.ev.ty, GOLDEN.channels.ev.ty));
  tally(check("East Village LY", report.channels.ev.ly, GOLDEN.channels.ev.ly));
  tally(check("E-Commerce TY", report.channels.ecom.ty, GOLDEN.channels.ecom.ty));
  tally(check("E-Commerce LY", report.channels.ecom.ly, GOLDEN.channels.ecom.ly));
  tally(
    check("Invoiced TY", report.channels.invoiced.ty, GOLDEN.channels.invoiced.ty),
  );
  tally(
    check("Invoiced LY", report.channels.invoiced.ly, GOLDEN.channels.invoiced.ly),
  );

  console.log("\n== BY CATEGORY (TOTAL = WV+EV+Web) ==");
  for (const category of report.categories) {
    const golden = GOLDEN.categories[category.row.key];
    if (!golden) continue;
    const drift = KNOWN_DRIFT[category.row.key];
    tally(
      check(`${category.row.key} TY`, category.total.ty, golden.ty, drift?.ty),
    );
    tally(
      check(`${category.row.key} LY`, category.total.ly, golden.ly, drift?.ly),
    );
  }

  console.log(
    failures === 0
      ? "\nALL NUMBERS RECONCILE ✓"
      : `\n${failures} numbers do not reconcile yet ✗`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().finally(() => prisma.$disconnect());
