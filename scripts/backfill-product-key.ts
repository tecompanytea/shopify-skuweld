// One-off backfill for SalesLine.productKey / productTitle on rows written
// before those columns existed. Both catalogs key on the 6-digit SKU, and a
// SKU belongs to exactly one Square variation and one Shopify variant, so a
// SKU -> product map is enough — no need to re-pull years of orders.
//
// Rows with no SKU (custom/uncatalogued lines) keep a null productKey and
// fall back to name identity in the reports.
//
// Run: npx tsx scripts/backfill-product-key.ts [--dry-run] [--shop=<domain>]
//
// Reads Square + Shopify admin credentials from the sibling content repo's
// .env (the app's own Square token is encrypted with a key that only lives in
// the Vercel environment).

import { readFileSync } from "node:fs";

const CONTENT_ENV = "../shopify-content/.env";
for (const source of [".env", CONTENT_ENV]) {
  for (const line of readFileSync(source, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=("?)(.*)\2$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[3];
  }
}

const { default: prisma } = await import("../app/db.server");
const { normalizeSku } = await import("../app/lib/sku-normalize");

const dryRun = process.argv.includes("--dry-run");
const shop =
  process.argv.find((a) => a.startsWith("--shop="))?.slice(7) ??
  "te-company.myshopify.com";

interface Product {
  key: string;
  title: string;
}

async function squareCatalog(): Promise<Map<string, Product>> {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) throw new Error("SQUARE_ACCESS_TOKEN missing");
  const base =
    process.env.SQUARE_ENVIRONMENT === "sandbox"
      ? "https://connect.squareupsandbox.com"
      : "https://connect.squareup.com";
  const bySku = new Map<string, Product>();
  let cursor: string | undefined;
  do {
    const response = await fetch(`${base}/v2/catalog/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Square-Version": process.env.SQUARE_API_VERSION ?? "2026-01-22",
        "Content-Type": "application/json",
      },
      // Deleted objects included: historical orders still reference them.
      body: JSON.stringify({
        object_types: ["ITEM"],
        include_deleted_objects: true,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      }),
    });
    if (!response.ok)
      throw new Error(`Square ${response.status}: ${await response.text()}`);
    const data = (await response.json()) as {
      objects?: Array<{
        id: string;
        item_data?: {
          name?: string;
          variations?: Array<{ item_variation_data?: { sku?: string } }>;
        };
      }>;
      cursor?: string;
    };
    for (const item of data.objects ?? []) {
      for (const variation of item.item_data?.variations ?? []) {
        const sku = variation.item_variation_data?.sku;
        if (!sku?.trim()) continue;
        bySku.set(normalizeSku(sku), {
          key: `sq:${item.id}`,
          title: item.item_data?.name ?? "(unknown item)",
        });
      }
    }
    cursor = data.cursor;
  } while (cursor);
  return bySku;
}

async function shopifyCatalog(): Promise<Map<string, Product>> {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) throw new Error("SHOPIFY_ACCESS_TOKEN missing");
  const domain = `${process.env.SHOPIFY_SHOP}.myshopify.com`;
  const version = process.env.SHOPIFY_API_VERSION ?? "2026-01";
  const bySku = new Map<string, Product>();
  let cursor: string | null = null;
  for (;;) {
    const response = await fetch(
      `https://${domain}/admin/api/${version}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: `query($cursor: String) {
            productVariants(first: 250, after: $cursor) {
              nodes { sku product { id title } }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          variables: { cursor },
        }),
      },
    );
    if (!response.ok)
      throw new Error(`Shopify ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as {
      errors?: unknown;
      data?: {
        productVariants: {
          nodes: Array<{
            sku: string | null;
            product: { id: string; title: string } | null;
          }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    };
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    const page = body.data!.productVariants;
    for (const variant of page.nodes) {
      if (!variant.sku?.trim() || !variant.product) continue;
      bySku.set(normalizeSku(variant.sku), {
        key: `sh:${variant.product.id}`,
        title: variant.product.title,
      });
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return bySku;
}

async function backfill(source: string, bySku: Map<string, Product>) {
  const distinct = await prisma.salesLine.findMany({
    where: { shop, source, sku: { not: null } },
    select: { sku: true },
    distinct: ["sku"],
  });
  let updated = 0;
  let unmatched = 0;
  for (const { sku } of distinct) {
    const product = bySku.get(normalizeSku(sku!));
    if (!product) {
      unmatched++;
      continue;
    }
    if (dryRun) {
      updated += await prisma.salesLine.count({ where: { shop, source, sku } });
      continue;
    }
    const result = await prisma.salesLine.updateMany({
      where: { shop, source, sku },
      data: { productKey: product.key, productTitle: product.title },
    });
    updated += result.count;
  }
  console.log(
    `${source}: ${distinct.length} distinct SKUs, ${unmatched} not in catalog, ${updated} lines ${dryRun ? "would be" : ""} updated`,
  );
}

const [square, shopify] = await Promise.all([squareCatalog(), shopifyCatalog()]);
console.log(
  `catalog: ${square.size} Square SKUs, ${shopify.size} Shopify SKUs${dryRun ? "  (DRY RUN)" : ""}\n`,
);
await backfill("square", square);
await backfill("shopify", shopify);

const remaining = await prisma.salesLine.count({
  where: { shop, productKey: null },
});
const total = await prisma.salesLine.count({ where: { shop } });
console.log(
  `\n${total - remaining}/${total} lines carry a productKey; ${remaining} fall back to name identity.`,
);

await prisma.$disconnect();
