import { useState } from "react";

import styles from "./grouped-product-table.module.css";

// Shared product table for the Shopify/Square product pages. Products are
// shown the way Shopify models them: one parent row per product, with its
// variants collapsed underneath — the variant-count chip toggles them open,
// while clicking the row (delegated to the checkbox) selects the product.
// Single-variant products with a default-named variant ("Default Title" /
// "Regular") collapse to one plain row. Search, sort, selection, and
// pagination are client-side over the full list.

export interface VariantRow {
  id: string;
  // null means the channel's default variant name — not worth displaying.
  name: string | null;
  sku: string | null;
}

export interface ProductGroup {
  id: string;
  title: string;
  imageUrl: string | null;
  // Shopify product type / Square category name; null when unset.
  productType: string | null;
  // Epoch millis; 0 when the channel didn't report a creation date.
  createdAt: number;
  variants: VariantRow[];
}

export function groupProducts(
  rows: Array<{
    productId: string;
    productTitle: string;
    productCreatedAt: string | null;
    productImageUrl: string | null;
    productType: string | null;
    variant: VariantRow;
  }>,
): ProductGroup[] {
  const groups = new Map<string, ProductGroup>();
  for (const row of rows) {
    let group = groups.get(row.productId);
    if (!group) {
      const created = row.productCreatedAt
        ? Date.parse(row.productCreatedAt)
        : 0;
      group = {
        id: row.productId,
        title: row.productTitle,
        imageUrl: row.productImageUrl,
        productType: row.productType,
        createdAt: Number.isNaN(created) ? 0 : created,
        variants: [],
      };
      groups.set(row.productId, group);
    }
    group.variants.push(row.variant);
  }
  return [...groups.values()];
}

// Parent rows summarize their variants' SKUs: the shared prefix with the
// varying tail masked ("1002xx"). null when there's no usable pattern.
function skuPattern(product: ProductGroup): string | null {
  const skus = product.variants
    .map((variant) => variant.sku)
    .filter((sku): sku is string => Boolean(sku));
  if (skus.length === 0) return null;
  const unique = new Set(skus);
  if (unique.size === 1) return skus[0];

  let prefix = skus[0];
  for (const sku of skus) {
    while (prefix && !sku.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  if (prefix.length < 2) return null;
  const maxLength = Math.max(...skus.map((sku) => sku.length));
  return prefix + "x".repeat(maxLength - prefix.length);
}

// IDs are GIDs/Square ids with characters that are unsafe in DOM ids.
function domId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

const PAGE_SIZE = 50;

type SortField = "created" | "name";
type SortDirection = "asc" | "desc";

const SORT_FIELDS: Array<{
  field: SortField;
  label: string;
  // Direction wording adapts to the field: alphabetical fields read A–Z,
  // numeric fields read lowest/highest, dates read oldest/newest.
  directionLabels: Record<SortDirection, string>;
  defaultDirection: SortDirection;
}> = [
  {
    field: "created",
    label: "Created",
    directionLabels: { asc: "Oldest first", desc: "Newest first" },
    defaultDirection: "desc",
  },
  {
    field: "name",
    label: "Product name",
    directionLabels: { asc: "A–Z", desc: "Z–A" },
    defaultDirection: "asc",
  },
];

function sortFieldConfig(field: SortField) {
  return SORT_FIELDS.find((option) => option.field === field) ?? SORT_FIELDS[0];
}

function compareProducts(
  a: ProductGroup,
  b: ProductGroup,
  field: SortField,
  direction: SortDirection,
): number {
  const result =
    field === "created"
      ? a.createdAt - b.createdAt
      : a.title.localeCompare(b.title, undefined, {
          numeric: true,
          sensitivity: "base",
        });
  return direction === "desc" ? -result : result;
}

// 40px bordered image box, per the native table pattern. Products without
// an image keep the box (subdued) so titles stay aligned.
function ProductImage({ product }: { product: ProductGroup }) {
  return (
    <s-box
      border="base"
      borderRadius="base"
      overflow="hidden"
      inlineSize="40px"
      blockSize="40px"
      background="subdued"
    >
      {product.imageUrl ? (
        <s-image objectFit="cover" src={product.imageUrl} alt="" />
      ) : null}
    </s-box>
  );
}

// Native s-table-header is not interactive, so header-click sorting is built
// from s-clickable. Clicking an inactive column applies its default
// direction; clicking again flips it. The arrow is shown when the column is
// the active sort (so the current sort stays visible) or on hover (as a
// preview of what a click would do) — tracked in React state with inline
// styles, since stylesheet rules proved unreliable inside table headers.
function SortableHeaderLabel({
  field,
  sort,
  onSort,
}: {
  field: SortField;
  sort: { field: SortField; direction: SortDirection };
  onSort: (field: SortField, direction: SortDirection) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const config = sortFieldConfig(field);
  const active = sort.field === field;
  // On the active column the arrow shows the current direction; on inactive
  // columns it previews the direction a click would apply.
  const arrowDirection = active ? sort.direction : config.defaultDirection;
  return (
    <button
      type="button"
      onClick={() =>
        onSort(
          field,
          active
            ? sort.direction === "asc"
              ? "desc"
              : "asc"
            : config.defaultDirection,
        )
      }
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={`Sort by ${config.label.toLowerCase()}`}
      style={{
        // A plain zero-box button (no s-clickable): it adds no padding of
        // its own, so the label starts exactly where the cell content does.
        background: "none",
        border: 0,
        margin: 0,
        padding: 0,
        font: "inherit",
        color: "inherit",
        cursor: "pointer",
        alignItems: "center",
        gap: "4px",
        whiteSpace: "nowrap",
        display: "inline-flex",
      }}
    >
      {config.label === "Product name" ? "Product" : config.label}
      <span
        style={{
          display: "inline-flex",
          opacity: active || hovered ? 1 : 0,
          transition: "opacity 120ms ease",
        }}
      >
        <s-icon
          type={arrowDirection === "asc" ? "arrow-up" : "arrow-down"}
          size="small"
        />
      </span>
    </button>
  );
}

export function GroupedProductTable({
  products,
  onPublishProduct,
  publishModalId,
}: {
  products: ProductGroup[];
  onPublishProduct?: (product: ProductGroup) => void;
  publishModalId?: string;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{
    field: SortField;
    direction: SortDirection;
  }>({ field: "created", direction: "desc" });
  const [page, setPage] = useState(0);

  const applySort = (field: SortField, direction: SortDirection) => {
    setSort({ field, direction });
    setPage(0);
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? products.filter((product) =>
        [
          product.title,
          product.productType ?? "",
          ...product.variants.flatMap((variant) => [
            variant.name ?? "",
            variant.sku ?? "",
          ]),
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery),
      )
    : products;
  const sorted = [...filtered].sort((a, b) =>
    compareProducts(a, b, sort.field, sort.direction),
  );

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = sorted.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );

  const setProductSelected = (id: string, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });

  const setVisibleSelected = (checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const product of visible) {
        if (checked) {
          next.add(product.id);
        } else {
          next.delete(product.id);
        }
      }
      return next;
    });

  const allVisibleSelected =
    visible.length > 0 &&
    visible.every((product) => selected.has(product.id));
  const someVisibleSelected =
    !allVisibleSelected && visible.some((product) => selected.has(product.id));
  const selectedProducts = products.filter((product) =>
    selected.has(product.id),
  );

  const directionLabels = sortFieldConfig(sort.field).directionLabels;

  return (
    <s-table
      paginate={sorted.length > PAGE_SIZE}
      hasPreviousPage={currentPage > 0}
      hasNextPage={currentPage < pageCount - 1}
      onPreviousPage={() => setPage(Math.max(0, currentPage - 1))}
      onNextPage={() => setPage(Math.min(pageCount - 1, currentPage + 1))}
    >
      {selected.size > 0 ? (
        <s-box
          slot="filters"
          padding="small"
          background="strong"
          borderRadius="base"
        >
          <s-grid gridTemplateColumns="1fr auto" alignItems="center">
            <s-text type="strong">{`${selected.size} selected`}</s-text>
            <s-stack direction="inline" gap="small" alignItems="center">
              {onPublishProduct && publishModalId && (
                <s-button
                  variant="secondary"
                  disabled={selectedProducts.length !== 1}
                  commandFor={publishModalId}
                  command="--show"
                  onClick={() => {
                    const product = selectedProducts[0];
                    if (product) onPublishProduct(product);
                  }}
                >
                  Publish on Square
                </s-button>
              )}
              <s-button
                variant="secondary"
                onClick={() => setSelected(new Set())}
              >
                Clear
              </s-button>
            </s-stack>
          </s-grid>
        </s-box>
      ) : (
        <s-grid slot="filters" gap="small-200" gridTemplateColumns="1fr auto">
          <s-search-field
            label="Search products"
            labelAccessibilityVisibility="exclusive"
            placeholder="Search by product, variant, or SKU"
            value={query}
            onInput={(event) => {
              setQuery((event.target as HTMLInputElement).value);
              setPage(0);
            }}
          />
          <s-button
            icon="sort"
            variant="secondary"
            accessibilityLabel="Sort"
            commandFor="products-sort-actions"
          />
          <s-popover id="products-sort-actions">
            <s-stack gap="none">
              <s-box padding="small">
                <s-choice-list
                  label="Sort by"
                  name="products-sort-by"
                  values={[sort.field]}
                  onChange={(event) => {
                    const next = event.currentTarget.values[0] as
                      | SortField
                      | undefined;
                    if (next) applySort(next, sort.direction);
                  }}
                >
                  {SORT_FIELDS.map((option) => (
                    <s-choice key={option.field} value={option.field}>
                      {option.label}
                    </s-choice>
                  ))}
                </s-choice-list>
              </s-box>
              <s-divider />
              <s-box padding="small">
                <s-choice-list
                  label="Order by"
                  name="products-order-by"
                  values={[sort.direction]}
                  onChange={(event) => {
                    const next = event.currentTarget.values[0] as
                      | SortDirection
                      | undefined;
                    if (next) applySort(sort.field, next);
                  }}
                >
                  <s-choice value="asc">{directionLabels.asc}</s-choice>
                  <s-choice value="desc">{directionLabels.desc}</s-choice>
                </s-choice-list>
              </s-box>
            </s-stack>
          </s-popover>
        </s-grid>
      )}

      <s-table-header-row>
        <s-table-header listSlot="primary">
          {/* Header and cells share the same stack + gap so the "Product"
              label lines up exactly with the row photos. */}
          <s-stack direction="inline" gap="small" alignItems="center">
            {/* checked/indeterminate are spread only when true: passing
                checked={false} server-renders a checked="false" attribute,
                which a custom element reads as checked — every box would
                flash checked on page load before hydration corrects it. */}
            <s-checkbox
              accessibilityLabel="Select all products"
              {...(allVisibleSelected ? { checked: true } : {})}
              {...(someVisibleSelected ? { indeterminate: true } : {})}
              onChange={(event) =>
                setVisibleSelected(event.currentTarget.checked)
              }
            />
            <SortableHeaderLabel field="name" sort={sort} onSort={applySort} />
          </s-stack>
        </s-table-header>
        <s-table-header listSlot="secondary">SKU</s-table-header>
        <s-table-header listSlot="labeled">Product type</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {visible.length === 0 ? (
          <s-table-row>
            <s-table-cell>No products match your search.</s-table-cell>
            <s-table-cell>—</s-table-cell>
            <s-table-cell>—</s-table-cell>
          </s-table-row>
        ) : (
          visible.flatMap((product) => {
            const isSingleDefault =
              product.variants.length === 1 &&
              product.variants[0].name === null;

            const checkboxId = domId("select", product.id);
            const checkbox = (
              <s-checkbox
                id={checkboxId}
                accessibilityLabel={`Select ${product.title}`}
                {...(selected.has(product.id) ? { checked: true } : {})}
                onChange={(event) =>
                  setProductSelected(product.id, event.currentTarget.checked)
                }
              />
            );

            if (isSingleDefault) {
              const variant = product.variants[0];
              return [
                <s-table-row key={product.id} clickDelegate={checkboxId}>
                  <s-table-cell>
                    <s-stack
                      direction="inline"
                      gap="small"
                      alignItems="center"
                    >
                      {checkbox}
                      <ProductImage product={product} />
                      <span className={styles.productTitle}>
                        {product.title}
                      </span>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{variant.sku ?? "—"}</s-table-cell>
                  <s-table-cell>{product.productType ?? "—"}</s-table-cell>
                </s-table-row>,
              ];
            }

            const open = expanded.has(product.id);
            const chipId = domId("variants", product.id);
            const parentRow = (
              <s-table-row key={product.id} clickDelegate={checkboxId}>
                <s-table-cell>
                  <s-stack direction="inline" gap="small" alignItems="center">
                    {checkbox}
                    <ProductImage product={product} />
                    <span className={styles.productTitle}>
                      {product.title}
                    </span>
                    <s-clickable-chip
                      id={chipId}
                      accessibilityLabel={`${open ? "Hide" : "Show"} variants of ${product.title}`}
                      onClick={() => toggle(product.id)}
                    >
                      <span className={styles.chipContent}>
                        {`${product.variants.length} ${
                          product.variants.length === 1
                            ? "variant"
                            : "variants"
                        }`}
                        <s-icon
                          type={open ? "chevron-up" : "chevron-down"}
                          size="small"
                        />
                      </span>
                    </s-clickable-chip>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{skuPattern(product) ?? "—"}</s-table-cell>
                <s-table-cell>{product.productType ?? "—"}</s-table-cell>
              </s-table-row>
            );

            if (!open) return [parentRow];
            return [
              parentRow,
              ...product.variants.map((variant) => (
                <s-table-row key={variant.id}>
                  <s-table-cell>
                    <s-box paddingInlineStart="large-300">
                      <s-text color="subdued">
                        {variant.name ?? "Default"}
                      </s-text>
                    </s-box>
                  </s-table-cell>
                  <s-table-cell>{variant.sku ?? "—"}</s-table-cell>
                  <s-table-cell />
                </s-table-row>
              )),
            ];
          })
        )}
      </s-table-body>
    </s-table>
  );
}
