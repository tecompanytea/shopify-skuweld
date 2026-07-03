import { squareFetch } from "./client";

interface CatalogListResponse {
  cursor?: string;
  objects?: CatalogObject[];
}

interface CatalogObject {
  type: string;
  id: string;
  created_at?: string;
  // Dashboard-created custom attributes; each value embeds its display name.
  custom_attribute_values?: Record<
    string,
    { name?: string; string_value?: string }
  >;
  item_data?: {
    name?: string;
    image_ids?: string[];
    categories?: Array<{ id: string }>;
    reporting_category?: { id: string };
    variations?: CatalogObject[];
  };
  item_variation_data?: {
    name?: string;
    sku?: string;
    price_money?: { amount?: number }; // smallest currency unit (cents)
  };
  image_data?: {
    url?: string;
  };
  category_data?: {
    name?: string;
  };
}

// One row per item variation — the level at which SKUs live in Square.
export interface SquareProductRow {
  itemId: string;
  itemName: string;
  itemCreatedAt: string | null;
  itemImageUrl: string | null;
  categoryName: string | null;
  variationId: string;
  variationName: string;
  sku: string | null;
  priceCents: number | null; // null for variable-priced items
  // Item-level custom attributes, matched by display name — the counterparts
  // of the Shopify custom.chinese_name / custom.product_flavor metafields.
  chineseName: string | null;
  flavorNotes: string | null;
}

function customAttribute(object: CatalogObject, name: string): string | null {
  for (const value of Object.values(object.custom_attribute_values ?? {})) {
    if (value.name?.toLowerCase() === name.toLowerCase()) {
      return value.string_value ?? null;
    }
  }
  return null;
}

export async function listSquareProducts(
  shop: string,
): Promise<SquareProductRow[]> {
  // Item image URLs and category names live on separate IMAGE/CATEGORY
  // catalog objects, which may appear on a later page than the items that
  // reference them — collect everything first, then resolve.
  const items: CatalogObject[] = [];
  const imageUrlById = new Map<string, string>();
  const categoryNameById = new Map<string, string>();
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ types: "ITEM,IMAGE,CATEGORY" });
    if (cursor) params.set("cursor", cursor);
    const data = await squareFetch<CatalogListResponse>(
      shop,
      `/v2/catalog/list?${params.toString()}`,
    );

    for (const object of data.objects ?? []) {
      if (object.type === "IMAGE" && object.image_data?.url) {
        imageUrlById.set(object.id, object.image_data.url);
      } else if (object.type === "CATEGORY" && object.category_data?.name) {
        categoryNameById.set(object.id, object.category_data.name);
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
    // Prefer the reporting category; fall back to the first assigned one.
    const categoryId =
      itemData.reporting_category?.id ?? itemData.categories?.[0]?.id;
    const categoryName = categoryId
      ? (categoryNameById.get(categoryId) ?? null)
      : null;
    for (const variation of itemData.variations ?? []) {
      if (variation.type !== "ITEM_VARIATION") continue;
      rows.push({
        itemId: object.id,
        itemName,
        itemCreatedAt: object.created_at ?? null,
        itemImageUrl,
        categoryName,
        variationId: variation.id,
        variationName: variation.item_variation_data?.name ?? "",
        sku: variation.item_variation_data?.sku ?? null,
        priceCents: variation.item_variation_data?.price_money?.amount ?? null,
        chineseName: customAttribute(object, "Chinese Name"),
        flavorNotes: customAttribute(object, "Flavor Notes"),
      });
    }
  }

  return rows;
}
