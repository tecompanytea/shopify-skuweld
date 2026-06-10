import { squareFetch } from "./client";

interface CatalogListResponse {
  cursor?: string;
  objects?: CatalogObject[];
}

interface CatalogObject {
  type: string;
  id: string;
  item_data?: {
    name?: string;
    variations?: CatalogObject[];
  };
  item_variation_data?: {
    name?: string;
    sku?: string;
  };
}

// One row per item variation — the level at which SKUs live in Square.
export interface SquareProductRow {
  itemId: string;
  itemName: string;
  variationId: string;
  variationName: string;
  sku: string | null;
}

export async function listSquareProducts(
  shop: string,
): Promise<SquareProductRow[]> {
  const rows: SquareProductRow[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ types: "ITEM" });
    if (cursor) params.set("cursor", cursor);
    const data = await squareFetch<CatalogListResponse>(
      shop,
      `/v2/catalog/list?${params.toString()}`,
    );

    for (const object of data.objects ?? []) {
      if (object.type !== "ITEM" || !object.item_data) continue;
      const itemName = object.item_data.name ?? "(unnamed item)";
      for (const variation of object.item_data.variations ?? []) {
        if (variation.type !== "ITEM_VARIATION") continue;
        rows.push({
          itemId: object.id,
          itemName,
          variationId: variation.id,
          variationName: variation.item_variation_data?.name ?? "",
          sku: variation.item_variation_data?.sku ?? null,
        });
      }
    }
    cursor = data.cursor;
  } while (cursor);

  return rows;
}
