import prisma from "../db.server";
import { hasSku, normalizeSku } from "../lib/sku-normalize";
import { isSkuClean } from "../lib/sku-rules";
import { listShopifyProducts } from "./shopify/products";
import { listSquareProducts } from "./square/catalog";
import { getSquareConnection } from "./square/client";

interface AdminClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

interface SkuObservation {
  rawValue: string;
  productName: string | null;
  shopifyVariantGid: string | null;
  squareVariationId: string | null;
  presentInShopify: boolean;
  presentInSquare: boolean;
}

export interface SyncResult {
  seen: number;
  created: number;
  updated: number;
  disappeared: number;
}

// Idempotent: upserts every SKU currently visible on either channel, flips
// presence flags off for master-list rows no longer seen (history is kept),
// and recomputes isClean against the current rule set.
export async function syncSkus(
  shop: string,
  admin: AdminClient,
): Promise<SyncResult> {
  const squareConnected = Boolean(await getSquareConnection(shop));
  const [shopifyRows, squareRows] = await Promise.all([
    listShopifyProducts(admin),
    squareConnected ? listSquareProducts(shop) : Promise.resolve([]),
  ]);

  const observations = new Map<string, SkuObservation>();

  for (const row of shopifyRows) {
    if (!hasSku(row.sku)) continue;
    const key = normalizeSku(row.sku);
    const existing = observations.get(key);
    observations.set(key, {
      rawValue: row.sku.trim(),
      productName: row.productTitle,
      shopifyVariantGid: row.variantGid,
      squareVariationId: existing?.squareVariationId ?? null,
      presentInShopify: true,
      presentInSquare: existing?.presentInSquare ?? false,
    });
  }

  for (const row of squareRows) {
    if (!hasSku(row.sku)) continue;
    const key = normalizeSku(row.sku);
    const existing = observations.get(key);
    observations.set(key, {
      rawValue: existing?.rawValue ?? row.sku.trim(),
      productName: existing?.productName ?? row.itemName,
      shopifyVariantGid: existing?.shopifyVariantGid ?? null,
      squareVariationId: row.variationId,
      presentInShopify: existing?.presentInShopify ?? false,
      presentInSquare: true,
    });
  }

  const rules = await prisma.skuRule.findMany({ where: { shop } });
  const existingRows = await prisma.sku.findMany({
    where: { shop },
    select: { value: true },
  });
  const existingValues = new Set(existingRows.map((row) => row.value));

  const now = new Date();
  let created = 0;
  let updated = 0;

  for (const [value, observation] of observations) {
    const isClean = isSkuClean(rules, observation.rawValue);
    const common = {
      rawValue: observation.rawValue,
      productName: observation.productName,
      presentInShopify: observation.presentInShopify,
      presentInSquare: observation.presentInSquare,
      shopifyVariantGid: observation.shopifyVariantGid,
      squareVariationId: observation.squareVariationId,
      isClean,
      lastSeenAt: now,
    };
    await prisma.sku.upsert({
      where: { shop_value: { shop, value } },
      create: { shop, value, ...common },
      update: common,
    });
    if (existingValues.has(value)) updated += 1;
    else created += 1;
  }

  // SKUs in the master list but no longer on any channel keep their row;
  // presence flags go false so they read as historical.
  const disappearedResult = await prisma.sku.updateMany({
    where: {
      shop,
      value: { notIn: [...observations.keys()] },
      OR: [{ presentInShopify: true }, { presentInSquare: true }],
    },
    data: { presentInShopify: false, presentInSquare: false },
  });

  return {
    seen: observations.size,
    created,
    updated,
    disappeared: disappearedResult.count,
  };
}

// Re-evaluates isClean for every master-list SKU; called whenever rules change.
export async function recomputeClean(shop: string): Promise<number> {
  const rules = await prisma.skuRule.findMany({ where: { shop } });
  const skus = await prisma.sku.findMany({
    where: { shop },
    select: { id: true, rawValue: true, isClean: true },
  });

  let changed = 0;
  for (const sku of skus) {
    const isClean = isSkuClean(rules, sku.rawValue);
    if (isClean !== sku.isClean) {
      await prisma.sku.update({ where: { id: sku.id }, data: { isClean } });
      changed += 1;
    }
  }
  return changed;
}
