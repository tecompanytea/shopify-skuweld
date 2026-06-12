// Full history backfill: syncs both channels month-by-month into the
// SalesLine fact table. Month chunks keep each delete+insert window small
// and make progress visible/resumable.
//
// Run: npx tsx scripts/backfill.ts [--shop=<domain>] [--from=2025-01] [--to=2026-06]

import { readFileSync } from "node:fs";

for (const line of readFileSync(".env", "utf8").split("\n")) {
  const match = line.match(/^([A-Z0-9_]+)=("?)(.*)\2$/);
  if (match && !(match[1] in process.env)) process.env[match[1]] = match[3];
}

const { default: prisma } = await import("../app/db.server");
const { syncSquareOrders } = await import("../app/.server/analytics/square-sync");
const { syncShopifyOrders } = await import("../app/.server/analytics/shopify-sync");
const { toReportDay } = await import("../app/lib/periods");

function arg(name: string): string | undefined {
  return process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

function monthRange(year: number, month: number) {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { start, end };
}

const shopArg = arg("shop");
const connections = await prisma.squareConnection.findMany();
const connection = shopArg
  ? connections.find((c) => c.shop === shopArg)
  : (connections.find((c) => !/dev/.test(c.shop)) ?? connections[0]);
if (!connection) throw new Error("No Square connection");
const shop = connection.shop;

const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
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

const from = arg("from") ?? "2025-01";
const to = arg("to") ?? toReportDay(new Date()).slice(0, 7);
const [fromY, fromM] = from.split("-").map(Number);
const [toY, toM] = to.split("-").map(Number);

// --only=square|shopify restricts the run. Square goes month-by-month (its
// API filters cheaply per window); Shopify goes as ONE range — each Shopify
// call scans a year before the window for edit-agreements, so month chunks
// would rescan the same orders 12+ times and invite throttling.
const only = arg("only");

console.log(`Backfilling ${shop}: ${from} → ${to}\n`);
let totalLines = 0;
if (only !== "shopify") {
  for (let y = fromY, m = fromM; y < toY || (y === toY && m <= toM); m === 12 ? (y++, (m = 1)) : m++) {
    const range = monthRange(y, m);
    const sq = await syncSquareOrders(shop, range);
    totalLines += sq.lines;
    console.log(
      `square ${range.start} → ${range.end}: ${sq.orders} orders / ${sq.lines} lines`,
    );
  }
}
if (only !== "square") {
  const fullRange = {
    start: monthRange(fromY, fromM).start,
    end: monthRange(toY, toM).end,
  };
  const sh = await syncShopifyOrders(shop, admin, fullRange);
  totalLines += sh.lines;
  console.log(
    `shopify ${fullRange.start} → ${fullRange.end}: ${sh.orders} orders / ${sh.lines} lines`,
  );
}
console.log(`\nDone. ${totalLines} total lines.`);
await prisma.$disconnect();
