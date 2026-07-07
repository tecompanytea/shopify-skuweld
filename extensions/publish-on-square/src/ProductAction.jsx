import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

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

export default async () => {
  render(<Extension />, document.body);
};

function productId() {
  return shopify.data.selected[0]?.id ?? null;
}

async function apiPost(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.message || `Request failed (${response.status})`);
  }
  return json;
}

function choiceValues(event) {
  const values = event.currentTarget.values;
  if (Array.isArray(values)) return values;
  if (values && typeof values[Symbol.iterator] === "function") {
    return Array.from(values);
  }
  return [];
}

function itemTypeLabel(value) {
  return ITEM_TYPES.find((item) => item.value === value)?.label || value;
}

function statusBadge(status) {
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

function checkStatus(check) {
  return check && typeof check.status === "string" ? check.status : "";
}

function checkMessage(check) {
  return check && typeof check.message === "string" ? check.message : "";
}

function variantName(title) {
  return title && title !== "Default Title" ? title : "Default";
}

function squareVariationName(title) {
  return title && title !== "Default Title" ? title : "Regular";
}

function variantDraftsFromPreview(preview) {
  return preview.skuChecks.map((check) => ({
    variantId: check.variantId,
    sourceTitle: check.variantTitle,
    name: squareVariationName(check.variantTitle),
    sku: check.sku || "",
    price: check.price,
  }));
}

function ProductSummary({ product }) {
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
          <s-stack direction="inline" gap="small-200">
            <s-badge {...(product.chineseName ? { tone: "success" } : {})}>
              Chinese name
            </s-badge>
            <s-badge {...(product.flavorNotes ? { tone: "success" } : {})}>
              Flavor notes
            </s-badge>
          </s-stack>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

function EditableProductFields({
  product,
  itemName,
  setItemName,
  itemType,
  setItemType,
  description,
  setDescription,
  chineseName,
  setChineseName,
  flavorNotes,
  setFlavorNotes,
  uploadImage,
  setUploadImage,
  markNeedsReview,
}) {
  return (
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
        {product.imageUrl && (
          <s-checkbox
            label="Upload featured image to Square"
            checked={uploadImage}
            onChange={(event) => setUploadImage(event.currentTarget.checked)}
          />
        )}
      </s-stack>
    </s-section>
  );
}

function CategoryChooser({
  preview,
  categoryIds,
  setCategoryIds,
  newCategoryName,
  setNewCategoryName,
}) {
  return (
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
          onInput={(event) => setNewCategoryName(event.currentTarget.value)}
        />
      </s-stack>
    </s-section>
  );
}

function TaxChooser({ taxes, taxIds, setTaxIds }) {
  if (!taxes.length) {
    return (
      <s-section heading="Square taxes">
        <s-banner tone="warning" dismissible={false}>
          No Square taxes were found.
        </s-banner>
      </s-section>
    );
  }

  return (
    <s-section heading="Square taxes">
      <s-choice-list
        label="Taxes"
        multiple
        values={taxIds}
        onChange={(event) => setTaxIds(choiceValues(event))}
      >
        {taxes.map((tax) => (
          <s-choice key={tax.id} value={tax.id}>
            {tax.percentage ? `${tax.name} (${tax.percentage}%)` : tax.name}
          </s-choice>
        ))}
      </s-choice-list>
    </s-section>
  );
}

/**
 * @param {{
 *   checks: Array<any>;
 *   variants: Array<any>;
 *   onVariantChange: (variantId: string, field: string, value: string) => void;
 * }} props
 */
function SkuTable({ checks, variants, onVariantChange }) {
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
            const check = /** @type {any} */ (checksById.get(variant.variantId));
            const status = checkStatus(check);
            const message = checkMessage(check);
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
                    statusBadge(status)
                  ) : (
                    <s-badge tone="caution" icon="incomplete">
                      Review
                    </s-badge>
                  )}
                  {check && status !== "ready" && (
                    <s-text color="subdued">{message}</s-text>
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

function NoticeList({ notices }) {
  if (!notices.length) return null;

  return (
    <s-banner tone="info" dismissible={false}>
      <s-unordered-list>
        {notices.map((notice) => (
          <s-list-item key={notice}>{notice}</s-list-item>
        ))}
      </s-unordered-list>
    </s-banner>
  );
}

function Success({ result }) {
  const categories =
    result.categoryNames?.length > 0
      ? result.categoryNames.join(", ")
      : result.categoryName;
  const taxes =
    result.taxNames?.length > 0 ? result.taxNames.join(", ") : "no taxes";

  return (
    <s-admin-action heading="Publish on Square">
      <s-banner tone="success" dismissible={false}>
        {result.itemName} was published to Square as{" "}
        {itemTypeLabel(result.productType)} in {categories} with{" "}
        {result.variationCount}{" "}
        {result.variationCount === 1 ? "variation" : "variations"}.
      </s-banner>
      <s-banner tone="info" dismissible={false}>
        Taxes: {taxes}
      </s-banner>
      {result.image.warning && (
        <s-banner tone="warning" dismissible={false}>
          {result.image.warning}
        </s-banner>
      )}
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => shopify.close()}
      >
        Done
      </s-button>
    </s-admin-action>
  );
}

function Extension() {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState(null);
  const [categoryIds, setCategoryIds] = useState([]);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [itemName, setItemName] = useState("");
  const [itemType, setItemType] = useState(DEFAULT_ITEM_TYPE);
  const [description, setDescription] = useState("");
  const [chineseName, setChineseName] = useState("");
  const [flavorNotes, setFlavorNotes] = useState("");
  const [taxIds, setTaxIds] = useState([]);
  const [uploadImage, setUploadImage] = useState(false);
  const [variants, setVariants] = useState([]);
  const [needsReview, setNeedsReview] = useState(false);
  const [reviewing, setReviewing] = useState(false);

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

  function applyInitialPreview(data) {
    setPreview(data);
    setItemName(data.product.title);
    setItemType(data.suggestedProductType || DEFAULT_ITEM_TYPE);
    setDescription(data.product.description || "");
    setChineseName(data.product.chineseName || "");
    setFlavorNotes(data.product.flavorNotes || "");
    setTaxIds(data.suggestedTaxIds || []);
    setUploadImage(Boolean(data.product.imageUrl));
    setVariants(variantDraftsFromPreview(data));
    setNeedsReview(false);

    if (data.suggestedCategoryIds?.length) {
      setCategoryIds(data.suggestedCategoryIds);
      setNewCategoryName("");
    } else if (data.suggestedCategoryName) {
      setCategoryIds([]);
      setNewCategoryName(data.suggestedCategoryName);
    }
  }

  function updateVariant(variantId, field, value) {
    setVariants((current) =>
      current.map((variant) =>
        variant.variantId === variantId ? { ...variant, [field]: value } : variant,
      ),
    );
    setNeedsReview(true);
  }

  useEffect(() => {
    let active = true;
    const id = productId();
    if (!id) {
      setError("Shopify did not provide a product ID for this action.");
      setLoading(false);
      return () => {
        active = false;
      };
    }

    apiPost("/api/publish-square/preview", { productId: id })
      .then((data) => {
        if (!active) return;
        applyInitialPreview(data);
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
  }, []);

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
    const id = productId();
    if (!id || !preview) return;
    setError(null);
    setReviewing(true);
    try {
      const data = await apiPost("/api/publish-square/preview", {
        productId: id,
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
    const id = productId();
    if (!id || !preview) return;
    setError(null);
    setPublishing(true);
    try {
      const data = await apiPost("/api/publish-square/publish", {
        productId: id,
        categoryIds,
        createCategoryName: newCategoryName.trim() || null,
        taxIds,
        productType: itemType,
        overrides: currentOverrides(),
      });
      setResult(data.result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setPublishing(false);
    }
  }

  if (result) return <Success result={result} />;

  return (
    <s-admin-action heading="Publish on Square">
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

      {preview && (
        <s-stack gap="base">
          <ProductSummary product={preview.product} />
          <EditableProductFields
            product={preview.product}
            itemName={itemName}
            setItemName={setItemName}
            itemType={itemType}
            setItemType={setItemType}
            description={description}
            setDescription={setDescription}
            chineseName={chineseName}
            setChineseName={setChineseName}
            flavorNotes={flavorNotes}
            setFlavorNotes={setFlavorNotes}
            uploadImage={uploadImage}
            setUploadImage={setUploadImage}
            markNeedsReview={markNeedsReview}
          />
          <CategoryChooser
            preview={preview}
            categoryIds={categoryIds}
            setCategoryIds={setCategoryIds}
            newCategoryName={newCategoryName}
            setNewCategoryName={setNewCategoryName}
          />
          <TaxChooser
            taxes={preview.taxes || []}
            taxIds={taxIds}
            setTaxIds={setTaxIds}
          />
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
          <NoticeList notices={preview.notices} />
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

      <s-button
        slot="primary-action"
        variant="primary"
        disabled={!preview || publishBlockers.length > 0 || publishing}
        onClick={handlePublish}
      >
        {publishing ? "Publishing..." : "Publish"}
      </s-button>
      <s-button slot="secondary-actions" onClick={() => shopify.close()}>
        Cancel
      </s-button>
    </s-admin-action>
  );
}
