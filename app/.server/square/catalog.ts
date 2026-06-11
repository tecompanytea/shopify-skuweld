import { squareFetch } from "./client";

interface CatalogListResponse {
  cursor?: string;
  objects?: CatalogObject[];
}

interface CatalogObject {
  type: string;
  id: string;
  created_at?: string;
  item_data?: {
    name?: string;
    image_ids?: string[];
    variations?: CatalogObject[];
  };
  item_variation_data?: {
    name?: string;
    sku?: string;
  };
  image_data?: {
    url?: string;
  };
}

// One row per item variation — the level at which SKUs live in Square.
export interface SquareProductRow {
  itemId: string;
  itemName: string;
  itemCreatedAt: string | null;
  itemImageUrl: string | null;
  variationId: string;
  variationName: string;
  sku: string | null;
}

export async function listSquareProducts(
  shop: string,
): Promise<SquareProductRow[]> {
  // Item image URLs live on separate IMAGE catalog objects, and an item's
  // image may appear on a later page than the item — collect everything
  // first, then resolve.
  const items: CatalogObject[] = [];
  const imageUrlById = new Map<string, string>();
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ types: "ITEM,IMAGE" });
    if (cursor) params.set("cursor", cursor);
    const data = await squareFetch<CatalogListResponse>(
      shop,
      `/v2/catalog/list?${params.toString()}`,
    );

    for (const object of data.objects ?? []) {
      if (object.type === "IMAGE" && object.image_data?.url) {
        imageUrlById.set(object.id, object.image_data.url);
      } else if (object.type === "ITEM" && object.item_data) {
        items.push(object);
      }
    }
    cursor = data.cursor;
  } while (cursor);

  const rows: SquareProductRow[] = [];
  for (const object of items) {
    const itemData = object.item_data!;
    const itemName = itemData.name ?? "(unnamed item)";
    const itemImageUrl =
      itemData.image_ids
        ?.map((id) => imageUrlById.get(id))
        .find((url) => url) ?? null;
    for (const variation of itemData.variations ?? []) {
      if (variation.type !== "ITEM_VARIATION") continue;
      rows.push({
        itemId: object.id,
        itemName,
        itemCreatedAt: object.created_at ?? null,
        itemImageUrl,
        variationId: variation.id,
        variationName: variation.item_variation_data?.name ?? "",
        sku: variation.item_variation_data?.sku ?? null,
      });
    }
  }

  return rows;
}
