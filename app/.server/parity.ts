import { hasSku, normalizeSku } from "../lib/sku-normalize";

export interface ShopifySkuEntry {
  sku: string;
  productTitle: string;
  variantTitle: string;
  variantGid: string;
  inventoryQuantity: number;
  category?: string | null;
  price?: string | null; // "15.00"
  chineseName?: string | null;
  flavorNotes?: string | null;
}

export interface SquareSkuEntry {
  sku: string;
  itemName: string;
  variationName: string;
  variationId: string;
  inventoryQuantity: number;
  category?: string | null;
  priceCents?: number | null;
}

export interface ParityRow {
  sku: string; // normalized key
  shopify: ShopifySkuEntry | null;
  square: SquareSkuEntry | null;
}

export interface DuplicateSku {
  channel: "shopify" | "square";
  sku: string;
  count: number;
}

export interface ParityResult {
  both: ParityRow[];
  shopifyOnly: ParityRow[];
  squareOnly: ParityRow[];
  duplicates: DuplicateSku[];
}

function indexBySku<T extends { sku: string }>(
  entries: T[],
  channel: "shopify" | "square",
  duplicates: DuplicateSku[],
): Map<string, T> {
  const map = new Map<string, T>();
  const counts = new Map<string, number>();

  for (const entry of entries) {
    if (!hasSku(entry.sku)) continue;
    const key = normalizeSku(entry.sku);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    // First occurrence wins; repeats are reported as data-quality warnings.
    if (!map.has(key)) map.set(key, entry);
  }
  for (const [sku, count] of counts) {
    if (count > 1) duplicates.push({ channel, sku, count });
  }
  return map;
}

export function computeParity(
  shopifyEntries: ShopifySkuEntry[],
  squareEntries: SquareSkuEntry[],
): ParityResult {
  const duplicates: DuplicateSku[] = [];
  const shopifyMap = indexBySku(shopifyEntries, "shopify", duplicates);
  const squareMap = indexBySku(squareEntries, "square", duplicates);

  const both: ParityRow[] = [];
  const shopifyOnly: ParityRow[] = [];
  const squareOnly: ParityRow[] = [];

  for (const [sku, shopify] of shopifyMap) {
    const square = squareMap.get(sku) ?? null;
    const row = { sku, shopify, square };
    if (square) both.push(row);
    else shopifyOnly.push(row);
  }
  for (const [sku, square] of squareMap) {
    if (!shopifyMap.has(sku)) {
      squareOnly.push({ sku, shopify: null, square });
    }
  }

  const bySku = (a: ParityRow, b: ParityRow) => a.sku.localeCompare(b.sku);
  both.sort(bySku);
  shopifyOnly.sort(bySku);
  squareOnly.sort(bySku);

  return { both, shopifyOnly, squareOnly, duplicates };
}
