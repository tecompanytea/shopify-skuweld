import { describe, expect, it } from "vitest";
import { computeParity } from "../app/.server/parity";
import { normalizeSku } from "../app/lib/sku-normalize";

const shopifyEntry = (sku: string, inventory = 1) => ({
  sku,
  productTitle: `Product ${sku}`,
  variantTitle: "Default Title",
  variantGid: `gid://shopify/ProductVariant/${sku}`,
  inventoryQuantity: inventory,
});

const squareEntry = (sku: string, inventory = 1) => ({
  sku,
  itemName: `Item ${sku}`,
  variationName: "Regular",
  variationId: `sq-${sku}`,
  inventoryQuantity: inventory,
});

describe("normalizeSku", () => {
  it("trims and uppercases", () => {
    expect(normalizeSku("  te-123 ")).toBe("TE-123");
  });
});

describe("computeParity", () => {
  it("buckets SKUs into both / shopifyOnly / squareOnly", () => {
    const result = computeParity(
      [shopifyEntry("A"), shopifyEntry("B")],
      [squareEntry("B"), squareEntry("C")],
    );
    expect(result.both.map((row) => row.sku)).toEqual(["B"]);
    expect(result.shopifyOnly.map((row) => row.sku)).toEqual(["A"]);
    expect(result.squareOnly.map((row) => row.sku)).toEqual(["C"]);
  });

  it("matches across case and whitespace drift", () => {
    const result = computeParity(
      [shopifyEntry("te-123 ")],
      [squareEntry("TE-123")],
    );
    expect(result.both).toHaveLength(1);
    expect(result.both[0].sku).toBe("TE-123");
    expect(result.shopifyOnly).toHaveLength(0);
    expect(result.squareOnly).toHaveLength(0);
  });

  it("ignores empty SKUs", () => {
    const result = computeParity([shopifyEntry("  ")], [squareEntry("")]);
    expect(result.both).toHaveLength(0);
    expect(result.shopifyOnly).toHaveLength(0);
    expect(result.squareOnly).toHaveLength(0);
  });

  it("flags duplicate SKUs within a channel", () => {
    const result = computeParity(
      [shopifyEntry("A"), shopifyEntry("a ")],
      [],
    );
    expect(result.duplicates).toEqual([
      { channel: "shopify", sku: "A", count: 2 },
    ]);
    expect(result.shopifyOnly).toHaveLength(1);
  });

  it("keeps both sides' inventory on matched rows", () => {
    const result = computeParity(
      [shopifyEntry("A", 7)],
      [squareEntry("A", 3)],
    );
    expect(result.both[0].shopify?.inventoryQuantity).toBe(7);
    expect(result.both[0].square?.inventoryQuantity).toBe(3);
  });
});
