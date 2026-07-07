import { useEffect, useMemo, useState } from "react";

import type { ProductGroup } from "./grouped-product-table";

const CATEGORY_BLOCKER = "Choose at least one Square category";
const DEFAULT_ITEM_TYPE = "FOOD_AND_BEV";

const ITEM_TYPES = [
  { value: "FOOD_AND_BEV", label: "Prepared food and beverage" },
  { value: "REGULAR", label: "Physical good" },
  { value: "EVENT", label: "Event" },
  { value: "DONATION", label: "Donation" },
  { value: "DIGITAL", label: "Digital" },
  { value: "LEGACY_SQUARE_ONLINE_SERVICE", label: "Other" },
];

interface SquareCategory {
  id: string;
  name: string;
}

interface SquareTax {
  id: string;
  name: string;
  percentage: string | null;
  enabled: boolean;
}

interface SkuCheck {
  variantId: string;
  variantTitle: string;
  sku: string | null;
  price: string;
  status: string;
  message: string;
}

interface PublishPreview {
  product: {
    id: string;
    title: string;
    description: string | null;
    imageUrl: string | null;
    productType: string | null;
    status: string;
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
  skuChecks: SkuCheck[];
  notices: string[];
  blockers: string[];
}

interface PublishResult {
  itemName: string;
  categoryName: string;
  categoryNames?: string[];
  taxNames?: string[];
  productType: string;
  variationCount: number;
  image: {
    warning: string | null;
  };
}

interface VariantDraft {
  variantId: string;
  sourceTitle: string;
  name: string;
  sku: string;
  price: string;
}

interface Props {
  modalId: string;
  product: ProductGroup | null;
  requestKey: number;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.message || `Request failed (${response.status})`);
  }
  return json as T;
}

function choiceValues(event: Event): string[] {
  const values = (event.currentTarget as { values?: unknown }).values;
  if (Array.isArray(values)) return values;
  if (
    values &&
    typeof (values as Iterable<unknown>)[Symbol.iterator] === "function"
  ) {
    return Array.from(values as Iterable<unknown>).filter(
      (value): value is string => typeof value === "string",
    );
  }
  return [];
}

function itemTypeLabel(value: string) {
  return ITEM_TYPES.find((item) => item.value === value)?.label || value;
}

function variantName(title: string) {
  return title && title !== "Default Title" ? title : "Default";
}

function squareVariationName(title: string) {
  return title && title !== "Default Title" ? title : "Regular";
}

function variantDraftsFromPreview(preview: PublishPreview): VariantDraft[] {
  return preview.skuChecks.map((check) => ({
    variantId: check.variantId,
    sourceTitle: check.variantTitle,
    name: squareVariationName(check.variantTitle),
    sku: check.sku || "",
    price: check.price,
  }));
}

function statusBadge(status: string) {
  if (status === "ready") {
    return <s-badge icon="enabled">Ready</s-badge>;
  }
  const tone = status === "exists-square" ? "critical" : "caution";
  return (
    <s-badge tone={tone} icon="incomplete">
      Review
    </s-badge>
  );
}

function ProductSummary({ preview }: { preview: PublishPreview }) {
  const product = preview.product;
  return (
    <s-section>
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-box
          border="base"
          borderRadius="base"
          overflow="hidden"
          inlineSize="56px"
          blockSize="56px"
          background="subdued"
        >
          {product.imageUrl ? (
            <s-image objectFit="cover" src={product.imageUrl} alt="" />
          ) : null}
        </s-box>
        <s-stack direction="block" gap="small-300">
          <s-text type="strong">{product.title}</s-text>
          <s-text color="subdued">
            {product.productType || "No product type"} - {product.variantCount}{" "}
            {product.variantCount === 1 ? "variant" : "variants"} -{" "}
            {product.status}
          </s-text>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

function SkuTable({
  checks,
  variants,
  onVariantChange,
}: {
  checks: SkuCheck[];
  variants: VariantDraft[];
  onVariantChange: (variantId: string, field: string, value: string) => void;
}) {
  const checksById = new Map(checks.map((check) => [check.variantId, check]));

  return (
    <s-section heading="Square variations" padding="none">
      <s-table paginate={false}>
        <s-table-header-row>
          <s-table-header listSlot="primary">Name</s-table-header>
          <s-table-header listSlot="secondary">SKU</s-table-header>
          <s-table-header listSlot="labeled">Price</s-table-header>
          <s-table-header listSlot="labeled">Status</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {variants.map((variant) => {
            const check = checksById.get(variant.variantId);
            return (
              <s-table-row key={variant.variantId}>
                <s-table-cell>
                  <s-stack direction="block" gap="small-300">
                    <s-text-field
                      label={`Square variation name for ${variantName(
                        variant.sourceTitle,
                      )}`}
                      labelAccessibilityVisibility="exclusive"
                      value={variant.name}
                      onInput={(event) =>
                        onVariantChange(
                          variant.variantId,
                          "name",
                          event.currentTarget.value,
                        )
                      }
                    />
                    <s-text color="subdued">
                      Shopify: {variantName(variant.sourceTitle)}
                    </s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <s-text-field
                    label={`SKU for ${variantName(variant.sourceTitle)}`}
                    labelAccessibilityVisibility="exclusive"
                    value={variant.sku}
                    onInput={(event) =>
                      onVariantChange(
                        variant.variantId,
                        "sku",
                        event.currentTarget.value,
                      )
                    }
                  />
                </s-table-cell>
                <s-table-cell>
                  <s-text-field
                    label={`Price for ${variantName(variant.sourceTitle)}`}
                    labelAccessibilityVisibility="exclusive"
                    value={variant.price}
                    onInput={(event) =>
                      onVariantChange(
                        variant.variantId,
                        "price",
                        event.currentTarget.value,
                      )
                    }
                  />
                </s-table-cell>
                <s-table-cell>
                  <s-stack direction="block" gap="small-300">
                    {check ? (
                      statusBadge(check.status)
                    ) : (
                      <s-badge tone="caution" icon="incomplete">
                        Review
                      </s-badge>
                    )}
                    {check && check.status !== "ready" && (
                      <s-text color="subdued">{check.message}</s-text>
                    )}
                  </s-stack>
                </s-table-cell>
              </s-table-row>
            );
          })}
        </s-table-body>
      </s-table>
    </s-section>
  );
}

export function PublishSquareProductModal({
  modalId,
  product,
  requestKey,
}: Props) {
  const [preview, setPreview] = useState<PublishPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [itemName, setItemName] = useState("");
  const [itemType, setItemType] = useState(DEFAULT_ITEM_TYPE);
  const [description, setDescription] = useState("");
  const [chineseName, setChineseName] = useState("");
  const [flavorNotes, setFlavorNotes] = useState("");
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [taxIds, setTaxIds] = useState<string[]>([]);
  const [uploadImage, setUploadImage] = useState(false);
  const [variants, setVariants] = useState<VariantDraft[]>([]);
  const [needsReview, setNeedsReview] = useState(false);

  const markNeedsReview = () => setNeedsReview(true);

  function currentOverrides() {
    return {
      itemName,
      description,
      productType: itemType,
      chineseName,
      flavorNotes,
      uploadImage,
      variants: variants.map((variant) => ({
        variantId: variant.variantId,
        name: variant.name,
        sku: variant.sku,
        price: variant.price,
      })),
    };
  }

  function applyInitialPreview(data: PublishPreview) {
    setPreview(data);
    setItemName(data.product.title);
    setItemType(data.suggestedProductType || DEFAULT_ITEM_TYPE);
    setDescription(data.product.description || "");
    setChineseName(data.product.chineseName || "");
    setFlavorNotes(data.product.flavorNotes || "");
    setCategoryIds(data.suggestedCategoryIds || []);
    setNewCategoryName(
      data.suggestedCategoryIds?.length ? "" : data.suggestedCategoryName || "",
    );
    setTaxIds(data.suggestedTaxIds || []);
    setUploadImage(Boolean(data.product.imageUrl));
    setVariants(variantDraftsFromPreview(data));
    setNeedsReview(false);
  }

  useEffect(() => {
    if (!product) return;
    let active = true;
    setPreview(null);
    setResult(null);
    setError(null);
    setLoading(true);

    apiPost<PublishPreview>("/api/publish-square/preview", {
      productId: product.id,
    })
      .then((data) => {
        if (active) applyInitialPreview(data);
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : "Preview failed");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [product, requestKey]);

  const blockers = useMemo(() => {
    if (!preview) return [];
    const withoutCategory = preview.blockers.filter(
      (blocker) => blocker !== CATEGORY_BLOCKER,
    );
    const categoryReady =
      categoryIds.length > 0 || newCategoryName.trim().length > 0;
    return categoryReady
      ? withoutCategory
      : [...withoutCategory, CATEGORY_BLOCKER];
  }, [preview, categoryIds, newCategoryName]);

  const publishBlockers = useMemo(
    () =>
      needsReview
        ? Array.from(
            new Set([...blockers, "Review edited fields before publishing"]),
          )
        : blockers,
    [blockers, needsReview],
  );

  async function handleReviewFields() {
    if (!product) return;
    setError(null);
    setReviewing(true);
    try {
      const data = await apiPost<PublishPreview>("/api/publish-square/preview", {
        productId: product.id,
        overrides: currentOverrides(),
      });
      setPreview(data);
      setNeedsReview(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setReviewing(false);
    }
  }

  async function handlePublish() {
    if (!product) return;
    setError(null);
    setPublishing(true);
    try {
      const data = await apiPost<{ result: PublishResult }>(
        "/api/publish-square/publish",
        {
          productId: product.id,
          categoryIds,
          createCategoryName: newCategoryName.trim() || null,
          taxIds,
          productType: itemType,
          overrides: currentOverrides(),
        },
      );
      setResult(data.result);
      shopify.toast.show("Published on Square");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setPublishing(false);
    }
  }

  function updateVariant(variantId: string, field: string, value: string) {
    setVariants((current) =>
      current.map((variant) =>
        variant.variantId === variantId
          ? { ...variant, [field]: value }
          : variant,
      ),
    );
    setNeedsReview(true);
  }

  return (
    <s-modal id={modalId} heading="Publish on Square" size="large-100">
      {loading && (
        <s-section>
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-spinner />
            <s-text>Loading product and Square catalog</s-text>
          </s-stack>
        </s-section>
      )}

      {error && (
        <s-banner tone="critical" dismissible={false}>
          {error}
        </s-banner>
      )}

      {result && (
        <s-stack gap="base">
          <s-banner tone="success" dismissible={false}>
            {result.itemName} was published to Square as{" "}
            {itemTypeLabel(result.productType)} in{" "}
            {result.categoryNames?.join(", ") || result.categoryName} with{" "}
            {result.variationCount}{" "}
            {result.variationCount === 1 ? "variation" : "variations"}.
          </s-banner>
          <s-banner tone="info" dismissible={false}>
            Taxes:{" "}
            {result.taxNames && result.taxNames.length > 0
              ? result.taxNames.join(", ")
              : "no taxes"}
          </s-banner>
          {result.image.warning && (
            <s-banner tone="warning" dismissible={false}>
              {result.image.warning}
            </s-banner>
          )}
        </s-stack>
      )}

      {preview && !result && (
        <s-stack gap="base">
          <ProductSummary preview={preview} />

          <s-section heading="Square item fields">
            <s-stack gap="base">
              <s-text-field
                label="Item name"
                value={itemName}
                onInput={(event) => {
                  setItemName(event.currentTarget.value);
                  markNeedsReview();
                }}
              />
              <s-select
                label="Item type"
                value={itemType}
                onChange={(event) => setItemType(event.currentTarget.value)}
              >
                {ITEM_TYPES.map((item) => (
                  <s-option key={item.value} value={item.value}>
                    {item.label}
                  </s-option>
                ))}
              </s-select>
              <s-text-area
                label="Customer-facing description"
                value={description}
                rows={4}
                onInput={(event) => {
                  setDescription(event.currentTarget.value);
                  markNeedsReview();
                }}
              />
              <s-text-field
                label="Chinese name"
                value={chineseName}
                onInput={(event) => {
                  setChineseName(event.currentTarget.value);
                  markNeedsReview();
                }}
              />
              <s-text-area
                label="Flavor notes"
                value={flavorNotes}
                rows={3}
                onInput={(event) => {
                  setFlavorNotes(event.currentTarget.value);
                  markNeedsReview();
                }}
              />
              {preview.product.imageUrl && (
                <s-checkbox
                  label="Upload featured image to Square"
                  checked={uploadImage}
                  onChange={(event) =>
                    setUploadImage(event.currentTarget.checked)
                  }
                />
              )}
            </s-stack>
          </s-section>

          <s-section heading="Square categories">
            <s-stack gap="base">
              <s-choice-list
                label="Categories"
                multiple
                values={categoryIds}
                onChange={(event) => setCategoryIds(choiceValues(event))}
              >
                {preview.categories.map((category) => (
                  <s-choice key={category.id} value={category.id}>
                    {category.name}
                  </s-choice>
                ))}
              </s-choice-list>
              <s-text-field
                label="New category name"
                value={newCategoryName}
                onInput={(event) =>
                  setNewCategoryName(event.currentTarget.value)
                }
              />
            </s-stack>
          </s-section>

          <s-section heading="Square taxes">
            {preview.taxes.length > 0 ? (
              <s-choice-list
                label="Taxes"
                multiple
                values={taxIds}
                onChange={(event) => setTaxIds(choiceValues(event))}
              >
                {preview.taxes.map((tax) => (
                  <s-choice key={tax.id} value={tax.id}>
                    {tax.percentage
                      ? `${tax.name} (${tax.percentage}%)`
                      : tax.name}
                  </s-choice>
                ))}
              </s-choice-list>
            ) : (
              <s-banner tone="warning" dismissible={false}>
                No Square taxes were found.
              </s-banner>
            )}
          </s-section>

          <SkuTable
            checks={preview.skuChecks}
            variants={variants}
            onVariantChange={updateVariant}
          />

          {needsReview && (
            <s-banner tone="info" dismissible={false}>
              <s-stack gap="base">
                <s-text>
                  Edited fields need to be checked against Square before
                  publishing.
                </s-text>
                <s-button
                  variant="secondary"
                  loading={reviewing}
                  disabled={reviewing}
                  onClick={handleReviewFields}
                >
                  Review fields
                </s-button>
              </s-stack>
            </s-banner>
          )}

          {preview.notices.length > 0 && (
            <s-banner tone="info" dismissible={false}>
              <s-unordered-list>
                {preview.notices.map((notice) => (
                  <s-list-item key={notice}>{notice}</s-list-item>
                ))}
              </s-unordered-list>
            </s-banner>
          )}

          {publishBlockers.length > 0 && (
            <s-banner tone="warning" dismissible={false}>
              <s-unordered-list>
                {publishBlockers.map((blocker) => (
                  <s-list-item key={blocker}>{blocker}</s-list-item>
                ))}
              </s-unordered-list>
            </s-banner>
          )}
        </s-stack>
      )}

      {result ? (
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor={modalId}
          command="--hide"
        >
          Done
        </s-button>
      ) : (
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={!preview || publishBlockers.length > 0 || publishing}
          loading={publishing}
          onClick={handlePublish}
        >
          Publish
        </s-button>
      )}
      <s-button slot="secondary-actions" commandFor={modalId} command="--hide">
        Cancel
      </s-button>
    </s-modal>
  );
}
