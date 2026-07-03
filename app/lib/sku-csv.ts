import type { ParityRow } from "../.server/parity";

// CSV export of the SKU-mapping rows, plus the row-field helpers the
// mapping table shares with it. Columns follow the manual catalog sheet:
// SKU, SKU Name, Variant, Category, Name, Chinese Name, Flavor Notes, Price.
// Client-safe: runs in the browser on the already-loaded parity rows.

// The raw SKU as it exists on a channel (the normalized row key strips
// case/whitespace, which would hide what the merchant actually typed).
export function rowSku(row: ParityRow): string {
  return row.shopify?.sku ?? row.square?.sku ?? row.sku;
}

// "Product — Variant", collapsing the channels' default variant names.
export function rowName(row: ParityRow): string {
  const name = row.shopify?.productTitle ?? row.square?.itemName ?? row.sku;
  const variant = rowVariant(row);
  return variant ? `${name} — ${variant}` : name;
}

export function rowVariant(row: ParityRow): string {
  if (row.shopify) {
    return row.shopify.variantTitle !== "Default Title"
      ? row.shopify.variantTitle
      : "";
  }
  if (row.square) {
    return row.square.variationName !== "Regular"
      ? row.square.variationName
      : "";
  }
  return "";
}

export function rowCategory(row: ParityRow): string {
  return row.shopify?.category || row.square?.category || "";
}

// Shopify's Money string wins; Square-only rows format their cents.
export function rowPrice(row: ParityRow): string {
  if (row.shopify?.price) return row.shopify.price;
  const cents = row.square?.priceCents;
  return cents == null ? "" : (cents / 100).toFixed(2);
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function buildSkuCsv(rows: ParityRow[]): string {
  const lines = [
    [
      "SKU",
      "SKU Name",
      "Variant",
      "Category",
      "Name",
      "Chinese Name",
      "Flavor Notes",
      "Price",
    ],
    ...rows.map((row) => [
      rowSku(row),
      rowName(row),
      rowVariant(row),
      rowCategory(row),
      row.shopify?.productTitle ?? row.square?.itemName ?? "",
      row.shopify?.chineseName ?? "",
      row.shopify?.flavorNotes ?? "",
      rowPrice(row),
    ]),
  ];
  const body = lines.map((line) => line.map(csvField).join(",")).join("\r\n");
  // BOM so Excel decodes the Chinese names as UTF-8; CRLF per RFC 4180.
  return "\uFEFF" + body + "\r\n";
}
