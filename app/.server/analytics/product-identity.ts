import prisma from "../../db.server";
import { hasSku, normalizeSku } from "../../lib/sku-normalize";
import { productName } from "../../lib/sku-scheme";

// Cross-channel product identity, shared by every report engine that ranks or
// groups products.
//
// Neither of the fact table's obvious keys works on its own:
//   - `itemName` is the order line's snapshot, so a renamed Square button
//     ("Mushroom Biscuit" -> "Daikon Biscuit") reads as two products, and the
//     two channels spell the same product differently ("Sachet Golden Lily"
//     vs "Golden Lily Sachet | Oolong Tea").
//   - the 4-digit SKU family is not a product: Square packs distinct items
//     into one family (2502 = Sweet Potato + Mung bean sesame cake), which
//     silently sums unrelated products into one row.
//
// `productKey` is the catalog's own identity — a Square item or a Shopify
// product — and a Square item's variations (the sizes) already share one key.
// The two catalogs disagree on granularity, though, and Shopify's is the one
// that matches how the products are actually sold:
//
//   - One Shopify product, several Square items ("Hibiscus" vs "Hibiscus 20g"
//     + "Hibiscus 60g"; "tinybars" vs one item per flavour). The Square items
//     collapse into the Shopify product.
//   - One Square item, several Shopify products ("Mooncake Box" vs
//     "Taiwanese Mooncake" + "Red Bean Mooncake with Yolk" + "Assorted
//     Mooncake"). The Square item splits along the Shopify products.
//
// So a Square item is resolved through the Shopify products its SKUs land on:
// exactly one, and it merges into that product; more than one, and it splits
// per SKU (its unmatched SKUs collect in a single leftover row); none, and it
// stands alone, which is every POS-only item (all the Service categories).
//
// Two distinct Shopify products are NEVER merged. That is the invariant that
// keeps "Mooncake Box" from chaining three unrelated mooncakes into one row —
// the failure mode of a naive union-find over shared SKUs.

export interface IdentityLine {
  source: string;
  sku: string | null;
  itemName: string;
  variationName: string | null;
  productKey: string | null;
  productTitle: string | null;
  netCents: number;
}

export interface ProductIdentity {
  /** Stable group id for a line — equal for every line of one product. */
  keyOf(line: IdentityLine): string;
  /** Display name for a group id. */
  titleOf(key: string): string;
}

/** sku -> the Shopify product selling it; null where two products claim it. */
export type ShopifyBridge = Map<string, { key: string; title: string } | null>;

// The bridge is read across all time, not just the report's window: whether
// "Hibiscus 20g" is its own product or a size of "Hibiscus" must not depend on
// whether the web store happened to sell a 20g bag inside the date range.
export async function loadShopifyBridge(shop: string): Promise<ShopifyBridge> {
  const rows = await prisma.salesLine.findMany({
    where: {
      shop,
      source: "shopify",
      sku: { not: null },
      productKey: { not: null },
    },
    select: { sku: true, productKey: true, productTitle: true },
    distinct: ["sku", "productKey"],
  });
  const bridge: ShopifyBridge = new Map();
  for (const row of rows) {
    const sku = normalizeSku(row.sku!);
    const seen = bridge.get(sku);
    if (seen === undefined) {
      bridge.set(sku, {
        key: row.productKey!,
        title: row.productTitle ?? row.productKey!,
      });
    } else if (seen && seen.key !== row.productKey) {
      bridge.set(sku, null); // two Shopify products claim this SKU
    }
  }
  return bridge;
}

interface Candidate {
  title: string;
  source: string;
  net: number;
}

const isShopify = (candidate: Candidate): number =>
  candidate.source === "shopify" ? 1 : 0;

// The Shopify title wins when there is one — it is the customer-facing name
// and already spans sizes. Otherwise the highest-grossing Square item name.
// Ties break on the name so a label never depends on database row order.
function preferred(a: Candidate, b: Candidate): Candidate {
  if (isShopify(a) !== isShopify(b)) return isShopify(a) > isShopify(b) ? a : b;
  if (a.net !== b.net) return a.net > b.net ? a : b;
  return a.title <= b.title ? a : b;
}

// Lines predating the productKey backfill, and custom uncatalogued lines,
// fall back to the name they were sold under.
function nameNode(line: IdentityLine): string {
  return `name:${productName(line.itemName, line.variationName).toLowerCase()}`;
}

export function resolveProductIdentity(
  lines: IdentityLine[],
  bridge: ShopifyBridge = new Map(),
): ProductIdentity {
  // sku -> the Shopify product selling it. `null` marks a SKU that two
  // Shopify products both claim (a catalog error): it bridges nothing.
  const shopifyBySku: ShopifyBridge = new Map(bridge);
  for (const line of lines) {
    if (line.source !== "shopify" || !line.productKey || !hasSku(line.sku)) {
      continue;
    }
    const sku = normalizeSku(line.sku);
    const seen = shopifyBySku.get(sku);
    const product = {
      key: line.productKey,
      title: line.productTitle ?? line.productKey,
    };
    if (seen === undefined) shopifyBySku.set(sku, product);
    else if (seen && seen.key !== line.productKey) shopifyBySku.set(sku, null);
  }

  const shopifyFor = (line: IdentityLine): string | null => {
    if (!hasSku(line.sku)) return null;
    return shopifyBySku.get(normalizeSku(line.sku))?.key ?? null;
  };

  // Square item -> the Shopify products its SKUs land on.
  const shopifyBySquareItem = new Map<string, Set<string>>();
  for (const line of lines) {
    if (line.source !== "square" || !line.productKey) continue;
    const product = shopifyFor(line);
    if (!product) continue;
    let products = shopifyBySquareItem.get(line.productKey);
    if (!products) {
      products = new Set();
      shopifyBySquareItem.set(line.productKey, products);
    }
    products.add(product);
  }

  const nodeOf = (line: IdentityLine): string => {
    if (line.source === "square" && line.productKey) {
      const products = shopifyBySquareItem.get(line.productKey);
      if (products?.size === 1) return [...products][0];
      if (products && products.size > 1) {
        // Square's item is coarser than Shopify's catalog: follow Shopify,
        // and keep the SKUs Shopify doesn't sell together in one leftover row.
        return shopifyFor(line) ?? `${line.productKey}#other`;
      }
      return line.productKey;
    }
    if (line.productKey) return line.productKey;
    // No catalog key (deleted variant, custom line): a SKU that Shopify still
    // sells is enough to place the line.
    return shopifyFor(line) ?? nameNode(line);
  };

  const tallies = new Map<string, Map<string, Candidate>>();
  for (const line of lines) {
    const node = nodeOf(line);
    let group = tallies.get(node);
    if (!group) {
      group = new Map();
      tallies.set(node, group);
    }
    const title = line.productTitle ?? productName(line.itemName, line.variationName);
    const id = `${line.source} ${title}`;
    const candidate = group.get(id) ?? { title, source: line.source, net: 0 };
    candidate.net += line.netCents;
    group.set(id, candidate);
  }
  // A Square-only window can resolve onto a Shopify product that sold nothing
  // in it ("Hibiscus 20g" -> "Hibiscus"). Name the row from the bridge rather
  // than from whichever POS button happens to be the top seller.
  const shopifyTitles = new Map<string, string>();
  for (const product of shopifyBySku.values()) {
    if (product) shopifyTitles.set(product.key, product.title);
  }
  for (const [node, group] of tallies) {
    const title = shopifyTitles.get(node);
    if (!title || [...group.values()].some((c) => c.source === "shopify")) {
      continue;
    }
    group.set(`shopify ${title}`, { title, source: "shopify", net: 0 });
  }

  const titles = new Map<string, string>();
  for (const [node, group] of tallies) {
    titles.set(node, [...group.values()].reduce(preferred).title);
  }

  // Adopt name-fallback nodes into the catalog product they name. A line whose
  // SKU has left both catalogs resolves to `name:<product>` and would sit in
  // its own row beside the very product it belongs to — two "Batch #8" rows.
  // Only an unambiguous title match adopts; a name shared by two products
  // stays on its own rather than guess.
  const nodesByTitle = new Map<string, Set<string>>();
  for (const [node, title] of titles) {
    if (node.startsWith("name:")) continue;
    const key = title.toLowerCase();
    let nodes = nodesByTitle.get(key);
    if (!nodes) {
      nodes = new Set();
      nodesByTitle.set(key, nodes);
    }
    nodes.add(node);
  }
  const adopted = new Map<string, string>();
  for (const node of titles.keys()) {
    if (!node.startsWith("name:")) continue;
    const nodes = nodesByTitle.get(node.slice("name:".length));
    if (nodes?.size === 1) adopted.set(node, [...nodes][0]);
  }

  const resolve = (node: string): string => adopted.get(node) ?? node;
  return {
    keyOf: (line) => resolve(nodeOf(line)),
    titleOf: (key) => titles.get(key) ?? key,
  };
}
