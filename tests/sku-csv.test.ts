import { describe, expect, it } from "vitest";

import type { ParityRow } from "../app/.server/parity";
import { buildSkuCsv, rowName, rowPrice, rowVariant } from "../app/lib/sku-csv";

const shopifyRow = (over: Partial<ParityRow["shopify"]> = {}): ParityRow => ({
  sku: "100202",
  shopify: {
    sku: "100202",
    productTitle: "Royal Courtesan",
    variantTitle: "2 oz",
    variantGid: "gid://shopify/ProductVariant/1",
    inventoryQuantity: 5,
    category: "Loose Leaf",
    price: "28.00",
    chineseName: "貴妃美人",
    flavorNotes: "Rose, artichoke, muscat grape",
    ...over,
  },
  square: null,
});

const squareOnlyRow = (): ParityRow => ({
  sku: "SVC-01",
  shopify: null,
  square: {
    sku: "SVC-01",
    itemName: "Tea Service",
    variationName: "Regular",
    variationId: "sq-1",
    inventoryQuantity: 0,
    category: "Service To Stay",
    priceCents: 1250,
  },
});

describe("buildSkuCsv", () => {
  it("writes the fixed header and one line per row, BOM-prefixed with CRLF", () => {
    const csv = buildSkuCsv([shopifyRow()]);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe(
      "SKU,SKU Name,Variant,Category,Name,Chinese Name,Flavor Notes,Price",
    );
    expect(lines[1]).toBe(
      '100202,Royal Courtesan — 2 oz,2 oz,Loose Leaf,Royal Courtesan,貴妃美人,"Rose, artichoke, muscat grape",28.00',
    );
    expect(lines[2]).toBe(""); // trailing newline
  });

  it("escapes embedded quotes by doubling them", () => {
    const csv = buildSkuCsv([
      shopifyRow({ flavorNotes: 'Notes of "stone fruit"' }),
    ]);
    expect(csv).toContain('"Notes of ""stone fruit"""');
  });

  it("falls back to Square identity and price for Square-only rows", () => {
    const csv = buildSkuCsv([squareOnlyRow()]);
    const line = csv.slice(1).split("\r\n")[1];
    expect(line).toBe("SVC-01,Tea Service,,Service To Stay,Tea Service,,,12.50");
  });
});

describe("row helpers", () => {
  it("collapses the channels' default variant names", () => {
    const defaultVariant = shopifyRow({ variantTitle: "Default Title" });
    expect(rowVariant(defaultVariant)).toBe("");
    expect(rowName(defaultVariant)).toBe("Royal Courtesan");
    expect(rowVariant(squareOnlyRow())).toBe("");
  });

  it("prefers the Shopify price string over Square cents", () => {
    const both: ParityRow = {
      ...shopifyRow(),
      square: squareOnlyRow().square,
    };
    expect(rowPrice(both)).toBe("28.00");
    expect(rowPrice(squareOnlyRow())).toBe("12.50");
    expect(rowPrice(shopifyRow({ price: null }))).toBe("");
  });
});
