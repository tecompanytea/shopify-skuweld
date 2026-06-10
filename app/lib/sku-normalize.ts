// Canonical SKU key used to match products across Shopify and Square.
// Trim + uppercase absorbs casual drift between platforms without false merges.
export function normalizeSku(raw: string): string {
  return raw.trim().toUpperCase();
}

export function hasSku(raw: string | null | undefined): raw is string {
  return typeof raw === "string" && raw.trim().length > 0;
}
