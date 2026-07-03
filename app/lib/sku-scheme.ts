// The 6-digit SKU scheme, used to group sales lines into cross-channel
// product families: first digit = category, next 3 = product family, last
// 2 = size/variant code ("100204" -> family "1002", size "04"). Pure string
// helpers shared by the product-selling and units-by-size report engines.

// Shopify line names are "Product - Variant"; strip the variant suffix so
// products group across sizes (the manual reports combine sizes).
export function productName(
  itemName: string,
  variationName: string | null,
): string {
  if (variationName && itemName.endsWith(` - ${variationName}`)) {
    return itemName.slice(0, -(variationName.length + 3));
  }
  return itemName;
}

// "100204" -> "1002" (category digit + family); null when not in scheme.
export function skuFamily(sku: string | null): string | null {
  return sku && /^\d{6}$/.test(sku) ? sku.slice(0, 4) : null;
}
