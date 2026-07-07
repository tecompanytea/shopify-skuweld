import crypto from "node:crypto";

import { hasSku, normalizeSku } from "../../lib/sku-normalize";
import type { ShopifyProductForSquare } from "../shopify/product-for-square";
import {
  listSquareCatalogObjects,
  listSquareCategories,
  listSquareProducts,
  listSquareTaxes,
  type CatalogObject,
  type SquareCategory,
  type SquareProductRow,
  type SquareTax,
} from "./catalog";
import { squareFetch, squareFetchForm } from "./client";

const SQUARE_STRING_LIMIT = 255;
const SQUARE_DESCRIPTION_LIMIT = 65_535;
const SQUARE_IMAGE_LIMIT_BYTES = 15 * 1024 * 1024;
const CATEGORY_BLOCKER = "Choose at least one Square category";
const DEFAULT_SQUARE_PRODUCT_TYPE = "FOOD_AND_BEV";

const SQUARE_PRODUCT_TYPES = new Set([
  "FOOD_AND_BEV",
  "REGULAR",
  "EVENT",
  "DONATION",
  "DIGITAL",
  "LEGACY_SQUARE_ONLINE_SERVICE",
]);

type SkuCheckStatus =
  | "ready"
  | "missing"
  | "duplicate-product"
  | "exists-square"
  | "invalid-price";

export interface PublishSkuCheck {
  variantId: string;
  variantTitle: string;
  sku: string | null;
  normalizedSku: string | null;
  price: string;
  status: SkuCheckStatus;
  message: string;
}

export interface PublishPreview {
  product: {
    id: string;
    title: string;
    description: string | null;
    productType: string | null;
    status: string;
    imageUrl: string | null;
    currencyCode: string;
    variantCount: number;
    chineseName: string | null;
    flavorNotes: string | null;
  };
  categories: SquareCategory[];
  taxes: SquareTax[];
  suggestedCategoryIds: string[];
  suggestedCategoryName: string | null;
  suggestedTaxIds: string[];
  suggestedProductType: string;
  skuChecks: PublishSkuCheck[];
  notices: string[];
  blockers: string[];
}

interface BatchUpsertCatalogObjectsResponse {
  objects?: CatalogObject[];
  id_mappings?: Array<{
    client_object_id?: string;
    object_id?: string;
  }>;
  errors?: unknown[];
}

interface CreateCatalogImageResponse {
  image?: CatalogObject;
  errors?: unknown[];
}

interface CategoryResolution {
  categories: Array<{ id: string; name: string }>;
  objects: CatalogObject[];
}

interface CustomAttributeDefinition {
  id: string;
  key: string;
  name: string;
  object: CatalogObject | null;
}

interface PublishInput {
  categoryIds?: string[];
  createCategoryName?: string | null;
  taxIds?: string[];
  productType?: string | null;
  uploadImage?: boolean;
}

export interface PublishVariantOverride {
  variantId: string;
  name?: string | null;
  sku?: string | null;
  price?: string | null;
}

export interface PublishOverrides {
  itemName?: string | null;
  description?: string | null;
  productType?: string | null;
  chineseName?: string | null;
  flavorNotes?: string | null;
  uploadImage?: boolean;
  variants?: PublishVariantOverride[];
}

export interface PublishResult {
  itemId: string;
  itemName: string;
  categoryName: string;
  categoryNames: string[];
  taxNames: string[];
  productType: string;
  variationCount: number;
  image: {
    uploaded: boolean;
    imageId: string | null;
    warning: string | null;
  };
}

const CUSTOM_ATTRIBUTES = [
  {
    key: "chinese_name",
    name: "Chinese Name",
    productField: "chineseName",
  },
  {
    key: "flavor_notes",
    name: "Flavor Notes",
    productField: "flavorNotes",
  },
] as const;

function sameName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function suggestedCategory(
  categories: SquareCategory[],
  productType: string,
): { id: string | null; name: string | null } {
  const name = productType.trim();
  if (!name) return { id: null, name: null };
  const match = categories.find((category) => sameName(category.name, name));
  return { id: match?.id ?? null, name };
}

function suggestedTaxes(taxes: SquareTax[]): string[] {
  const enabledTaxes = taxes.filter((tax) => tax.enabled);
  const nycTax = enabledTaxes.find((tax) => {
    const name = tax.name.toLowerCase();
    return (
      name.includes("nyc") ||
      name.includes("new york") ||
      tax.percentage === "8.875"
    );
  });
  if (nycTax) return [nycTax.id];
  return enabledTaxes.length === 1 ? [enabledTaxes[0].id] : [];
}

function parsePriceCents(price: string): number | null {
  const match = price.trim().match(/^(\d+)(?:\.(\d{1,}))?$/);
  if (!match) return null;

  const dollars = Number(match[1]);
  if (!Number.isSafeInteger(dollars)) return null;
  const decimals = (match[2] ?? "").padEnd(3, "0");
  const cents = Number(decimals.slice(0, 2));
  const roundUp = Number(decimals[2]) >= 5 ? 1 : 0;
  const amount = dollars * 100 + cents + roundUp;
  return Number.isSafeInteger(amount) ? amount : null;
}

function squareVariationName(variantTitle: string): string {
  const title = variantTitle.trim();
  return !title || title === "Default Title" ? "Regular" : title;
}

function squareString(value: string): string {
  const trimmed = value.trim();
  const chars = [...trimmed];
  if (chars.length <= SQUARE_STRING_LIMIT) return trimmed;
  return `${chars.slice(0, SQUARE_STRING_LIMIT - 3).join("")}...`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function squareDescriptionHtml(value: string | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed
    .split(/\n{2,}/)
    .map((paragraph) => {
      const body = escapeHtml(paragraph.trim()).replace(/\n/g, "<br />");
      return body ? `<p>${body}</p>` : "";
    })
    .filter((paragraph) => paragraph)
    .join("");
}

function descriptionLength(value: string | null): number {
  return squareDescriptionHtml(value)?.length ?? 0;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  return undefined;
}

function normalizeSquareProductType(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return SQUARE_PRODUCT_TYPES.has(trimmed) ? trimmed : undefined;
}

export function normalizePublishOverrides(raw: unknown): PublishOverrides {
  if (!raw || typeof raw !== "object") return {};
  const input = raw as Record<string, unknown>;
  const overrides: PublishOverrides = {};

  const itemName = nullableString(input.itemName);
  if (itemName !== undefined) overrides.itemName = itemName;
  const description = nullableString(input.description);
  if (description !== undefined) overrides.description = description;
  const productType = normalizeSquareProductType(input.productType);
  if (productType !== undefined) overrides.productType = productType;
  const chineseName = nullableString(input.chineseName);
  if (chineseName !== undefined) overrides.chineseName = chineseName;
  const flavorNotes = nullableString(input.flavorNotes);
  if (flavorNotes !== undefined) overrides.flavorNotes = flavorNotes;
  if (typeof input.uploadImage === "boolean") {
    overrides.uploadImage = input.uploadImage;
  }

  if (Array.isArray(input.variants)) {
    overrides.variants = input.variants
      .map((value): PublishVariantOverride | null => {
        if (!value || typeof value !== "object") return null;
        const variant = value as Record<string, unknown>;
        if (typeof variant.variantId !== "string" || !variant.variantId) {
          return null;
        }
        const override: PublishVariantOverride = {
          variantId: variant.variantId,
        };
        const name = nullableString(variant.name);
        if (name !== undefined) override.name = name;
        const sku = nullableString(variant.sku);
        if (sku !== undefined) override.sku = sku;
        const price = nullableString(variant.price);
        if (price !== undefined) override.price = price;
        return override;
      })
      .filter((value): value is PublishVariantOverride => Boolean(value));
  }

  return overrides;
}

function cleanNullableText(value: string | null | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

export function applyPublishOverrides(
  product: ShopifyProductForSquare,
  overrides: PublishOverrides,
): ShopifyProductForSquare {
  const variantsById = new Map(
    (overrides.variants ?? []).map((variant) => [variant.variantId, variant]),
  );

  return {
    ...product,
    title:
      overrides.itemName === undefined
        ? product.title
        : (overrides.itemName ?? "").trim(),
    description:
      overrides.description === undefined
        ? product.description
        : cleanNullableText(overrides.description),
    chineseName:
      overrides.chineseName === undefined
        ? product.chineseName
        : cleanNullableText(overrides.chineseName),
    flavorNotes:
      overrides.flavorNotes === undefined
        ? product.flavorNotes
        : cleanNullableText(overrides.flavorNotes),
    variants: product.variants.map((variant) => {
      const override = variantsById.get(variant.id);
      if (!override) return variant;
      return {
        ...variant,
        title:
          override.name === undefined
            ? variant.title
            : (override.name ?? "").trim(),
        sku:
          override.sku === undefined
            ? variant.sku
            : cleanNullableText(override.sku),
        price:
          override.price === undefined
            ? variant.price
            : (override.price ?? "").trim(),
      };
    }),
  };
}

function existingSkuByNormalized(
  squareRows: SquareProductRow[],
): Map<string, SquareProductRow> {
  const existing = new Map<string, SquareProductRow>();
  for (const row of squareRows) {
    if (!hasSku(row.sku)) continue;
    const key = normalizeSku(row.sku as string);
    if (!existing.has(key)) existing.set(key, row);
  }
  return existing;
}

export function buildSkuChecks(
  product: ShopifyProductForSquare,
  squareRows: SquareProductRow[],
): PublishSkuCheck[] {
  const existing = existingSkuByNormalized(squareRows);
  const counts = new Map<string, number>();

  for (const variant of product.variants) {
    if (!hasSku(variant.sku)) continue;
    const key = normalizeSku(variant.sku as string);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return product.variants.map((variant) => {
    const normalizedSku = hasSku(variant.sku)
      ? normalizeSku(variant.sku as string)
      : null;
    const priceCents = parsePriceCents(variant.price);

    if (!normalizedSku) {
      return {
        variantId: variant.id,
        variantTitle: variant.title,
        sku: variant.sku,
        normalizedSku,
        price: variant.price,
        status: "missing",
        message: "Missing SKU",
      };
    }

    if ((counts.get(normalizedSku) ?? 0) > 1) {
      return {
        variantId: variant.id,
        variantTitle: variant.title,
        sku: variant.sku,
        normalizedSku,
        price: variant.price,
        status: "duplicate-product",
        message: "SKU is reused on this Shopify product",
      };
    }

    const squareRow = existing.get(normalizedSku);
    if (squareRow) {
      const variation =
        squareRow.variationName && squareRow.variationName !== "Regular"
          ? ` / ${squareRow.variationName}`
          : "";
      return {
        variantId: variant.id,
        variantTitle: variant.title,
        sku: variant.sku,
        normalizedSku,
        price: variant.price,
        status: "exists-square",
        message: `Already in Square: ${squareRow.itemName}${variation}`,
      };
    }

    if (priceCents === null) {
      return {
        variantId: variant.id,
        variantTitle: variant.title,
        sku: variant.sku,
        normalizedSku,
        price: variant.price,
        status: "invalid-price",
        message: "Price could not be converted to Square money",
      };
    }

    return {
      variantId: variant.id,
      variantTitle: variant.title,
      sku: variant.sku,
      normalizedSku,
      price: variant.price,
      status: "ready",
      message: "Ready",
    };
  });
}

function buildNotices(
  product: ShopifyProductForSquare,
  taxes: SquareTax[],
  taxIds: string[],
): string[] {
  const notices = ["Initial inventory is not set by this action."];

  if (taxes.length === 0) {
    notices.push("No Square taxes were found for this account.");
  } else if (taxIds.length === 0) {
    notices.push("No Square tax is selected for this item.");
  }

  for (const attribute of CUSTOM_ATTRIBUTES) {
    const value = product[attribute.productField];
    if (value && [...value.trim()].length > SQUARE_STRING_LIMIT) {
      notices.push(
        `${attribute.name} is longer than Square's ${SQUARE_STRING_LIMIT}-character custom attribute limit and will be shortened.`,
      );
    }
  }

  return notices;
}

function blockersFor(
  skuChecks: PublishSkuCheck[],
  categoryIds: string[],
  product: ShopifyProductForSquare,
): string[] {
  const blockers = skuChecks
    .filter((check) => check.status !== "ready")
    .map((check) => check.message);
  if (!product.title.trim()) blockers.push("Square item name is required");
  if (descriptionLength(product.description) > SQUARE_DESCRIPTION_LIMIT) {
    blockers.push("Customer-facing description is too long for Square");
  }
  if (categoryIds.length === 0) blockers.push(CATEGORY_BLOCKER);
  return Array.from(new Set(blockers));
}

export async function buildPublishPreview(
  shop: string,
  product: ShopifyProductForSquare,
): Promise<PublishPreview> {
  const [categories, taxes, squareRows] = await Promise.all([
    listSquareCategories(shop),
    listSquareTaxes(shop),
    listSquareProducts(shop),
  ]);
  const category = suggestedCategory(categories, product.productType);
  const categoryIds = category.id ? [category.id] : [];
  const taxIds = suggestedTaxes(taxes);
  const skuChecks = buildSkuChecks(product, squareRows);

  return {
    product: {
      id: product.id,
      title: product.title,
      description: product.description,
      productType: product.productType.trim() || null,
      status: product.status,
      imageUrl: product.featuredImageUrl,
      currencyCode: product.currencyCode,
      variantCount: product.variants.length,
      chineseName: product.chineseName,
      flavorNotes: product.flavorNotes,
    },
    categories,
    taxes,
    suggestedCategoryIds: categoryIds,
    suggestedCategoryName: category.name,
    suggestedTaxIds: taxIds,
    suggestedProductType: DEFAULT_SQUARE_PRODUCT_TYPE,
    skuChecks,
    notices: buildNotices(product, taxes, taxIds),
    blockers: blockersFor(skuChecks, categoryIds, product),
  };
}

function uniqueStrings(values: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
}

async function resolveCategories(
  shop: string,
  input: PublishInput,
): Promise<CategoryResolution> {
  const categories = await listSquareCategories(shop);
  const createName = input.createCategoryName?.trim();
  const requestedCategoryIds = uniqueStrings(input.categoryIds);
  const resolvedCategories: Array<{ id: string; name: string }> = [];
  const objects: CatalogObject[] = [];

  for (const id of requestedCategoryIds) {
    const category = categories.find((item) => item.id === id);
    if (!category) {
      throw new Response("Choose valid Square categories", { status: 422 });
    }
    resolvedCategories.push({ id: category.id, name: category.name });
  }

  if (createName) {
    const existing = categories.find((category) =>
      sameName(category.name, createName),
    );
    if (existing) {
      if (!resolvedCategories.some((category) => category.id === existing.id)) {
        resolvedCategories.push({ id: existing.id, name: existing.name });
      }
    } else {
      const id = `#skuweld-category-${crypto.randomUUID()}`;
      const name = squareString(createName);
      resolvedCategories.push({ id, name });
      objects.push({
        type: "CATEGORY",
        id,
        category_data: { name },
      });
    }
  }

  if (resolvedCategories.length === 0) {
    throw new Response(CATEGORY_BLOCKER, { status: 422 });
  }

  return { categories: resolvedCategories, objects };
}

async function resolveTaxes(
  shop: string,
  input: PublishInput,
): Promise<{ taxIds: string[]; taxNames: string[] }> {
  const requestedTaxIds = uniqueStrings(input.taxIds);
  if (requestedTaxIds.length === 0) return { taxIds: [], taxNames: [] };

  const taxes = await listSquareTaxes(shop);
  const taxNames: string[] = [];
  for (const id of requestedTaxIds) {
    const tax = taxes.find((item) => item.id === id);
    if (!tax) {
      throw new Response("Choose valid Square taxes", { status: 422 });
    }
    taxNames.push(
      tax.percentage ? `${tax.name} (${tax.percentage}%)` : tax.name,
    );
  }

  return { taxIds: requestedTaxIds, taxNames };
}

function publishProductType(input: PublishInput): string {
  const type = input.productType?.trim() || DEFAULT_SQUARE_PRODUCT_TYPE;
  if (!SQUARE_PRODUCT_TYPES.has(type)) {
    throw new Response("Choose a valid Square item type", { status: 422 });
  }
  return type;
}

function mapResponseId(
  response: BatchUpsertCatalogObjectsResponse,
  temporaryId: string,
): string | null {
  return (
    response.id_mappings?.find(
      (mapping) => mapping.client_object_id === temporaryId,
    )?.object_id ?? null
  );
}

function customAttributeDefinition(
  objects: CatalogObject[],
  key: string,
  name: string,
): CustomAttributeDefinition | null {
  const normalizedKey = key.toLowerCase();
  const definitions = objects.filter(
    (object) =>
      object.type === "CUSTOM_ATTRIBUTE_DEFINITION" &&
      object.custom_attribute_definition_data,
  );
  const match =
    definitions.find((object) =>
      sameName(object.custom_attribute_definition_data?.name ?? "", name),
    ) ??
    definitions.find((object) => {
      const objectKey =
        object.custom_attribute_definition_data?.key?.split(":").pop() ?? "";
      return objectKey.toLowerCase() === normalizedKey;
    });

  if (!match?.custom_attribute_definition_data?.key) return null;
  return {
    id: match.id,
    key: match.custom_attribute_definition_data.key,
    name: match.custom_attribute_definition_data.name ?? name,
    object: null,
  };
}

async function customAttributeDefinitions(
  shop: string,
  product: ShopifyProductForSquare,
): Promise<CustomAttributeDefinition[]> {
  const attributesWithValues = CUSTOM_ATTRIBUTES.filter((attribute) => {
    const value = product[attribute.productField];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (attributesWithValues.length === 0) return [];

  const objects = await listSquareCatalogObjects(
    shop,
    "CUSTOM_ATTRIBUTE_DEFINITION",
  );

  return attributesWithValues.map((attribute) => {
    const existing = customAttributeDefinition(
      objects,
      attribute.key,
      attribute.name,
    );
    if (existing) return existing;

    const id = `#skuweld-${attribute.key}-${crypto.randomUUID()}`;
    return {
      id,
      key: attribute.key,
      name: attribute.name,
      object: {
        type: "CUSTOM_ATTRIBUTE_DEFINITION",
        id,
        custom_attribute_definition_data: {
          key: attribute.key,
          name: attribute.name,
          type: "STRING",
          allowed_object_types: ["ITEM"],
        },
      },
    };
  });
}

function itemCustomAttributeValues(
  product: ShopifyProductForSquare,
  definitions: CustomAttributeDefinition[],
): CatalogObject["custom_attribute_values"] | undefined {
  const values: NonNullable<CatalogObject["custom_attribute_values"]> = {};

  for (const attribute of CUSTOM_ATTRIBUTES) {
    const value = product[attribute.productField];
    if (!value?.trim()) continue;
    const definition = definitions.find(
      (item) =>
        sameName(item.name, attribute.name) ||
        (item.key.split(":").pop() ?? "").toLowerCase() === attribute.key,
    );
    if (!definition) continue;
    values[definition.key] = {
      key: definition.key,
      name: definition.name,
      custom_attribute_definition_id: definition.id,
      type: "STRING",
      string_value: squareString(value),
    };
  }

  return Object.keys(values).length > 0 ? values : undefined;
}

async function uploadFeaturedImage(
  shop: string,
  itemId: string,
  product: ShopifyProductForSquare,
): Promise<PublishResult["image"]> {
  if (!product.featuredImageUrl) {
    return { uploaded: false, imageId: null, warning: null };
  }

  const response = await fetch(product.featuredImageUrl);
  if (!response.ok) {
    throw new Error(`Shopify image download failed (${response.status})`);
  }

  const blob = await response.blob();
  if (blob.size > SQUARE_IMAGE_LIMIT_BYTES) {
    return {
      uploaded: false,
      imageId: null,
      warning: "Featured image was larger than Square's 15 MB upload limit.",
    };
  }

  const contentType = response.headers.get("content-type") ?? blob.type;
  const extension = contentType.includes("png")
    ? "png"
    : contentType.includes("gif")
      ? "gif"
      : "jpg";
  const form = new FormData();
  form.append(
    "request",
    new Blob(
      [
        JSON.stringify({
          idempotency_key: crypto.randomUUID(),
          object_id: itemId,
          is_primary: true,
          image: {
            type: "IMAGE",
            id: `#skuweld-image-${crypto.randomUUID()}`,
            image_data: { name: squareString(product.title) },
          },
        }),
      ],
      { type: "application/json" },
    ),
  );
  form.append("image_file", blob, `shopify-product.${extension}`);

  const data = await squareFetchForm<CreateCatalogImageResponse>(
    shop,
    "/v2/catalog/images",
    form,
  );
  if (data.errors?.length) {
    throw new Error(`Square image upload failed: ${JSON.stringify(data.errors)}`);
  }

  return {
    uploaded: true,
    imageId: data.image?.id ?? null,
    warning: null,
  };
}

export async function publishProductToSquare(
  shop: string,
  product: ShopifyProductForSquare,
  input: PublishInput,
): Promise<PublishResult> {
  const [categoryResolution, taxResolution, squareRows, definitions] =
    await Promise.all([
      resolveCategories(shop, input),
      resolveTaxes(shop, input),
      listSquareProducts(shop),
      customAttributeDefinitions(shop, product),
    ]);
  const productType = publishProductType(input);
  const categoryIds = categoryResolution.categories.map(
    (category) => category.id,
  );
  const skuChecks = buildSkuChecks(product, squareRows);
  const blockers = blockersFor(skuChecks, categoryIds, product);
  if (blockers.length > 0) {
    throw new Response(blockers.join("\n"), { status: 422 });
  }

  const itemId = `#skuweld-item-${crypto.randomUUID()}`;
  const descriptionHtml = squareDescriptionHtml(product.description);
  const definitionObjects = definitions
    .map((definition) => definition.object)
    .filter((object): object is CatalogObject => Boolean(object));
  const variationObjects: CatalogObject[] = product.variants.map(
    (variant, index) => ({
      type: "ITEM_VARIATION",
      id: `#skuweld-variation-${index}-${crypto.randomUUID()}`,
      present_at_all_locations: true,
      item_variation_data: {
        item_id: itemId,
        name: squareVariationName(variant.title),
        sku: variant.sku?.trim(),
        pricing_type: "FIXED_PRICING",
        price_money: {
          amount: parsePriceCents(variant.price),
          currency: product.currencyCode,
        },
        track_inventory: false,
        sellable: true,
        stockable: true,
      },
    }),
  );
  const item: CatalogObject = {
    type: "ITEM",
    id: itemId,
    present_at_all_locations: true,
    item_data: {
      name: squareString(product.title),
      ...(descriptionHtml ? { description_html: descriptionHtml } : {}),
      product_type: productType,
      categories: categoryIds.map((id) => ({ id })),
      reporting_category: { id: categoryIds[0] },
      is_taxable: taxResolution.taxIds.length > 0,
      ...(taxResolution.taxIds.length > 0
        ? { tax_ids: taxResolution.taxIds }
        : {}),
      variations: variationObjects,
    },
    custom_attribute_values: itemCustomAttributeValues(product, definitions),
  };

  const objects = [...definitionObjects, ...categoryResolution.objects, item];

  const data = await squareFetch<BatchUpsertCatalogObjectsResponse>(
    shop,
    "/v2/catalog/batch-upsert",
    {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        batches: [{ objects }],
      }),
    },
  );
  if (data.errors?.length) {
    throw new Error(`Square publish failed: ${JSON.stringify(data.errors)}`);
  }

  const createdItemId = mapResponseId(data, itemId);
  if (!createdItemId) {
    throw new Error("Square did not return a catalog item ID");
  }

  let image: PublishResult["image"] = {
    uploaded: false,
    imageId: null,
    warning: null,
  };
  try {
    if (input.uploadImage === false) {
      return {
        itemId: createdItemId,
        itemName: product.title,
        categoryName: categoryResolution.categories[0].name,
        categoryNames: categoryResolution.categories.map(
          (category) => category.name,
        ),
        taxNames: taxResolution.taxNames,
        productType,
        variationCount: product.variants.length,
        image,
      };
    }
    image = await uploadFeaturedImage(shop, createdItemId, product);
  } catch (error) {
    image = {
      uploaded: false,
      imageId: null,
      warning:
        error instanceof Error
          ? `Square item was created, but the image was not uploaded: ${error.message}`
          : "Square item was created, but the image was not uploaded.",
    };
  }

  return {
    itemId: createdItemId,
    itemName: product.title,
    categoryName: categoryResolution.categories[0].name,
    categoryNames: categoryResolution.categories.map((category) => category.name),
    taxNames: taxResolution.taxNames,
    productType,
    variationCount: product.variants.length,
    image,
  };
}
