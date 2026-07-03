import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import { listShopifyProducts } from "../.server/shopify/products";
import { listSquareProducts } from "../.server/square/catalog";
import { getInventoryCounts } from "../.server/square/inventory";
import {
  getSquareConnection,
  SquareNotConnectedError,
} from "../.server/square/client";
import { computeParity, type ParityRow } from "../.server/parity";
import { hasSku } from "../lib/sku-normalize";
import { buildSkuCsv, rowCategory, rowName, rowSku } from "../lib/sku-csv";
import { toReportDay } from "../lib/periods";
import styles from "../sku-mapping-table.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  // The two catalogs don't depend on each other — fetch them in parallel
  // (each still pages serially through its own API). `square` is null when
  // Square isn't connected.
  const [shopifyRows, square] = await Promise.all([
    listShopifyProducts(admin),
    (async () => {
      if (!(await getSquareConnection(session.shop))) return null;
      try {
        const catalog = await listSquareProducts(session.shop);
        const counts = await getInventoryCounts(
          session.shop,
          catalog.map((row) => row.variationId),
        );
        return { catalog, counts };
      } catch (error) {
        if (error instanceof SquareNotConnectedError) return null;
        throw error;
      }
    })(),
  ]);

  const shopifyEntries = shopifyRows.filter((row) => hasSku(row.sku)).map(
    (row) => ({
      sku: row.sku as string,
      productTitle: row.productTitle,
      variantTitle: row.variantTitle,
      variantGid: row.variantGid,
      inventoryQuantity: row.inventoryQuantity,
      category: row.productType || null,
      price: row.price,
      chineseName: row.chineseName,
      flavorNotes: row.flavorNotes,
    }),
  );
  const squareEntries = square
    ? square.catalog.filter((row) => hasSku(row.sku)).map((row) => ({
        sku: row.sku as string,
        itemName: row.itemName,
        variationName: row.variationName,
        variationId: row.variationId,
        inventoryQuantity: square.counts.get(row.variationId) ?? 0,
        category: row.categoryName,
        priceCents: row.priceCents,
      }))
    : [];

  return {
    parity: computeParity(shopifyEntries, squareEntries),
    squareConnected: square !== null,
  };
};

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

type Scope = "all" | "both" | "shopify" | "square" | "review";

const SCOPE_OPTIONS: { label: string; scope: Scope }[] = [
  { label: "All", scope: "all" },
  { label: "Both channels", scope: "both" },
  { label: "Shopify only", scope: "shopify" },
  { label: "Square only", scope: "square" },
  { label: "Review", scope: "review" },
];

const DEFAULT_SCOPE: Scope = "all";

type SortField = "name" | "sku" | "category";
type SortDir = "asc" | "desc";

const SORT_OPTIONS: { label: string; field: SortField }[] = [
  { label: "SKU Name", field: "name" },
  { label: "SKU", field: "sku" },
  { label: "Category", field: "category" },
];

// Client-side page size: all rows are in memory, so paging is instant —
// this only caps how many web-component rows mount at once.
const PAGE_SIZE = 50;

function rowChannel(row: ParityRow): string {
  if (row.shopify && row.square) return "Both";
  return row.shopify ? "Shopify" : "Square";
}

export default function SkuMapping() {
  const { parity, squareConnected } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const [scope, setScope] = useState<Scope>(DEFAULT_SCOPE);
  const [scopeMenuReady, setScopeMenuReady] = useState(false);
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const activeLabel = SCOPE_OPTIONS.find((o) => o.scope === scope)!.label;

  // A SKU is matched when it lives on both channels and the code is not
  // reused inside a channel; everything else deserves a look.
  const duplicateSkus = new Set(
    parity.duplicates.map((duplicate) => duplicate.sku),
  );
  const isMatched = (row: ParityRow) =>
    Boolean(row.shopify && row.square) && !duplicateSkus.has(row.sku);

  const allRows = [
    ...parity.both,
    ...parity.shopifyOnly,
    ...parity.squareOnly,
  ];

  // Filter + sort client-side so switching scope/search/sort is instant
  // (the loader already fetched both full catalogs).
  const compareRows = (a: ParityRow, b: ParityRow) => {
    const dir = sortDir === "asc" ? 1 : -1;
    const pick = (row: ParityRow) =>
      sortField === "sku"
        ? rowSku(row)
        : sortField === "category"
          ? rowCategory(row)
          : rowName(row);
    return dir * pick(a).localeCompare(pick(b));
  };
  const q = query.trim().toLowerCase();
  const filteredRows = allRows
    .filter((row) => {
      if (scope === "both") return Boolean(row.shopify && row.square);
      if (scope === "shopify") return Boolean(row.shopify && !row.square);
      if (scope === "square") return Boolean(!row.shopify && row.square);
      if (scope === "review") return !isMatched(row);
      return true;
    })
    .filter((row) =>
      q
        ? [rowName(row), rowSku(row), rowCategory(row)].some((value) =>
            value.toLowerCase().includes(q),
          )
        : true,
    )
    .sort(compareRows);

  // Clamp instead of resetting in every filter handler; handlers still snap
  // to page 0 so a narrowed filter starts from the top.
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = filteredRows.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );

  // Header checkbox works on the current page (like the admin Orders list);
  // the "N selected" menu offers the whole filtered set.
  const pageRowIds = pageRows.map((row) => row.sku);
  const selectedOnPage = pageRowIds.filter((id) =>
    selectedIds.includes(id),
  ).length;
  const allPageSelected =
    pageRowIds.length > 0 && selectedOnPage === pageRowIds.length;
  const somePageSelected = selectedOnPage > 0 && !allPageSelected;
  const allFilteredSelected =
    filteredRows.length > 0 &&
    filteredRows.every((row) => selectedIds.includes(row.sku));
  const selectAllFiltered = () => {
    setSelectedIds((current) =>
      Array.from(new Set([...current, ...filteredRows.map((row) => row.sku)])),
    );
  };
  const clearSelectedRows = () => setSelectedIds([]);
  const togglePageRows = () => {
    setSelectedIds((current) => {
      const pageIds = new Set(pageRowIds);
      if (allPageSelected) return current.filter((id) => !pageIds.has(id));
      return Array.from(new Set([...current, ...pageRowIds]));
    });
  };
  const toggleRow = (id: string) => {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((selectedId) => selectedId !== id)
        : [...current, id],
    );
  };
  const copySelectedSkus = async () => {
    const rowBySku = new Map(allRows.map((row) => [row.sku, row]));
    const skus = selectedIds
      .map((id) => rowBySku.get(id))
      .filter((row): row is ParityRow => Boolean(row))
      .map((row) => rowSku(row));
    await navigator.clipboard.writeText(skus.join("\n"));
    shopify.toast.show(
      `Copied ${skus.length} ${skus.length === 1 ? "SKU" : "SKUs"}`,
    );
  };
  // The CSV orders itself by SKU (buildSkuCsv's contract) regardless of the
  // on-screen sort — the scheme clusters families and their channel twins.
  const exportSelectedCsv = () => {
    const selected = new Set(selectedIds);
    const rows = allRows.filter((row) => selected.has(row.sku));
    const blob = new Blob([buildSkuCsv(rows)], {
      type: "text/csv;charset=utf-8",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `SKU Export ${toReportDay(new Date())}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    shopify.toast.show(
      `Exported ${rows.length} ${rows.length === 1 ? "SKU" : "SKUs"}`,
    );
  };

  return (
    <s-page heading="SKU Mapping">
      {!squareConnected && (
        <s-banner tone="warning">
          Square is not connected, so everything shows as Shopify only.{" "}
          <s-link href="/app/settings">Connect Square in Settings</s-link>.
        </s-banner>
      )}

      {parity.duplicates.length > 0 && (
        <s-banner tone="warning" heading="Duplicate SKUs detected">
          <s-paragraph>
            {parity.duplicates
              .map(
                (duplicate) =>
                  `${duplicate.sku} appears ${duplicate.count}× in ${duplicate.channel}`,
              )
              .join("; ")}
          </s-paragraph>
        </s-banner>
      )}

      {allRows.length === 0 ? (
        <s-section>
          <s-paragraph>
            No SKUs found on either channel yet. Add SKUs to your products in
            Shopify or Square and they will be mapped here.
          </s-paragraph>
        </s-section>
      ) : (
        <s-section padding="none">
          <s-table
            paginate
            hasPreviousPage={currentPage > 0}
            hasNextPage={currentPage < pageCount - 1}
            onPreviousPage={() => setPage(Math.max(0, currentPage - 1))}
            onNextPage={() => setPage(Math.min(pageCount - 1, currentPage + 1))}
          >
            {selectedIds.length > 0 ? (
              <s-box
                slot="filters"
                padding="small"
                background="strong"
                borderRadius="base"
              >
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-button
                    variant="tertiary"
                    commandFor="mapping-selection-menu"
                  >
                    {`${selectedIds.length} selected`}
                  </s-button>
                  <s-menu
                    id="mapping-selection-menu"
                    accessibilityLabel="Selection actions"
                  >
                    {!allFilteredSelected ? (
                      <s-button onClick={selectAllFiltered}>
                        {scope === "all" && !q
                          ? `Select all ${filteredRows.length} in this store`
                          : `Select all ${filteredRows.length} in this view`}
                      </s-button>
                    ) : null}
                    <s-button onClick={clearSelectedRows}>Unselect all</s-button>
                  </s-menu>
                  <s-button variant="secondary" onClick={copySelectedSkus}>
                    Copy SKUs
                  </s-button>
                  <s-button variant="secondary" onClick={exportSelectedCsv}>
                    Export CSV
                  </s-button>
                </s-stack>
              </s-box>
            ) : (
            <s-stack slot="filters" direction="block" gap="small-200">
              <s-grid
                gap="small-200"
                gridTemplateColumns="auto auto"
                justifyContent="space-between"
                alignItems="center"
              >
                <s-stack direction="inline" alignItems="center">
                  <s-clickable
                    commandFor="mapping-scope-popover"
                    paddingInline="small-200"
                    paddingBlock="small-400"
                    borderRadius="base"
                  >
                    <s-stack
                      direction="inline"
                      gap="small-400"
                      alignItems="center"
                    >
                      <s-text>{activeLabel}</s-text>
                      <s-icon type="select" />
                    </s-stack>
                  </s-clickable>
                  <s-popover
                    id="mapping-scope-popover"
                    onAfterShow={() => setScopeMenuReady(true)}
                    onAfterHide={() => setScopeMenuReady(false)}
                  >
                    <s-box padding="small-400">
                      <div style={{ opacity: scopeMenuReady ? 1 : 0 }}>
                        <s-stack direction="block" gap="small-500">
                          {SCOPE_OPTIONS.map((option) => {
                            const selected = option.scope === scope;
                            return (
                              <s-clickable
                                key={option.scope}
                                commandFor="mapping-scope-popover"
                                command="--hide"
                                onClick={() => {
                                  setScope(option.scope);
                                  setPage(0);
                                }}
                                paddingInline="small-200"
                                paddingBlock="small-400"
                                borderRadius="base"
                              >
                                <span className={styles.scopeOption}>
                                  <span
                                    className={`${styles.scopeCheck}${
                                      selected
                                        ? ` ${styles.scopeCheckSelected}`
                                        : ""
                                    }`}
                                  >
                                    <s-icon
                                      type="check"
                                      color={selected ? undefined : "subdued"}
                                    />
                                  </span>
                                  <span
                                    className={
                                      selected
                                        ? styles.scopeLabelSelected
                                        : undefined
                                    }
                                  >
                                    {option.label}
                                  </span>
                                </span>
                              </s-clickable>
                            );
                          })}
                        </s-stack>
                      </div>
                    </s-box>
                  </s-popover>
                </s-stack>
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-button
                    icon="search"
                    variant="tertiary"
                    accessibilityLabel="Search"
                    onClick={() => {
                      setSearchOpen((open) => !open);
                      setQuery("");
                      setPage(0);
                    }}
                  />
                  <s-button
                    icon="sort"
                    variant="tertiary"
                    accessibilityLabel="Sort"
                    commandFor="mapping-sort-popover"
                  />
                  <s-popover id="mapping-sort-popover">
                    <s-stack direction="block" gap="none">
                      <s-box padding="small">
                        <s-choice-list
                          label="Sort by"
                          name="mapping-sort-by"
                          values={[sortField]}
                          onChange={(event) => {
                            const next = event.currentTarget.values[0];
                            if (next) {
                              setSortField(next as SortField);
                              setPage(0);
                            }
                          }}
                        >
                          {SORT_OPTIONS.map((option) => (
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
                          name="mapping-order-by"
                          values={[sortDir]}
                          onChange={(event) => {
                            const next = event.currentTarget.values[0];
                            if (next === "asc" || next === "desc") {
                              setSortDir(next);
                              setPage(0);
                            }
                          }}
                        >
                          <s-choice value="asc">A–Z</s-choice>
                          <s-choice value="desc">Z–A</s-choice>
                        </s-choice-list>
                      </s-box>
                    </s-stack>
                  </s-popover>
                </s-stack>
              </s-grid>
              {searchOpen ? (
                <s-search-field
                  label="Search SKUs"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="Search by product, SKU, or category"
                  value={query}
                  onInput={(event) => {
                    setQuery((event.target as HTMLInputElement).value);
                    setPage(0);
                  }}
                />
              ) : null}
            </s-stack>
            )}
            <s-table-header-row>
              <s-table-header listSlot="inline">
                <s-checkbox
                  {...(allPageSelected ? { checked: true } : {})}
                  {...(somePageSelected ? { indeterminate: true } : {})}
                  {...(pageRowIds.length === 0 ? { disabled: true } : {})}
                  accessibilityLabel="Select all SKUs on this page"
                  onChange={togglePageRows}
                />
              </s-table-header>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header listSlot="secondary">Category</s-table-header>
              <s-table-header listSlot="labeled">Channel</s-table-header>
              <s-table-header listSlot="labeled">Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {pageRows.map((row, i) => {
                const selected = selectedIds.includes(row.sku);
                return (
                  <s-table-row key={row.sku}>
                    <s-table-cell>
                      <s-checkbox
                        id={`mapping-row-${i}-checkbox`}
                        {...(selected ? { checked: true } : {})}
                        accessibilityLabel={`Select ${rowName(row)}`}
                        onChange={() => toggleRow(row.sku)}
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="block" gap="small-300">
                        <s-text type="strong">{rowName(row)}</s-text>
                        <s-text color="subdued">{rowSku(row)}</s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{rowCategory(row) || "—"}</s-table-cell>
                    <s-table-cell>
                      <s-badge>{rowChannel(row)}</s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      {isMatched(row) ? (
                        <s-badge icon="enabled">Matched</s-badge>
                      ) : (
                        <s-badge tone="caution" icon="incomplete">
                          Review
                        </s-badge>
                      )}
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}
