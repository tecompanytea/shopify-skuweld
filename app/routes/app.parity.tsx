import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { listShopifyProducts } from "../.server/shopify/products";
import { listSquareProducts } from "../.server/square/catalog";
import { getInventoryCounts } from "../.server/square/inventory";
import {
  getSquareConnection,
  SquareNotConnectedError,
} from "../.server/square/client";
import {
  computeParity,
  type ParityResult,
  type ParityRow,
} from "../.server/parity";
import { hasSku } from "../lib/sku-normalize";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  let squareConnected = Boolean(await getSquareConnection(session.shop));
  let parity: ParityResult = {
    both: [],
    shopifyOnly: [],
    squareOnly: [],
    duplicates: [],
  };

  const shopifyRows = await listShopifyProducts(admin);
  const shopifyEntries = shopifyRows.filter((row) => hasSku(row.sku)).map(
    (row) => ({
      sku: row.sku as string,
      productTitle: row.productTitle,
      variantTitle: row.variantTitle,
      variantGid: row.variantGid,
      inventoryQuantity: row.inventoryQuantity,
    }),
  );

  if (squareConnected) {
    try {
      const catalog = await listSquareProducts(session.shop);
      const counts = await getInventoryCounts(
        session.shop,
        catalog.map((row) => row.variationId),
      );
      const squareEntries = catalog.filter((row) => hasSku(row.sku)).map(
        (row) => ({
          sku: row.sku as string,
          itemName: row.itemName,
          variationName: row.variationName,
          variationId: row.variationId,
          inventoryQuantity: counts.get(row.variationId) ?? 0,
        }),
      );
      parity = computeParity(shopifyEntries, squareEntries);
    } catch (error) {
      if (error instanceof SquareNotConnectedError) {
        squareConnected = false;
      } else {
        throw error;
      }
    }
  }

  if (!squareConnected) {
    parity = computeParity(shopifyEntries, []);
  }

  return { parity, squareConnected };
};

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

const VIEWS = [
  { key: "both", label: "In both" },
  { key: "shopify", label: "Shopify only" },
  { key: "square", label: "Square only" },
] as const;

function rowName(row: ParityRow): string {
  if (row.shopify) {
    return row.shopify.variantTitle &&
      row.shopify.variantTitle !== "Default Title"
      ? `${row.shopify.productTitle} — ${row.shopify.variantTitle}`
      : row.shopify.productTitle;
  }
  if (row.square) {
    return row.square.variationName && row.square.variationName !== "Regular"
      ? `${row.square.itemName} — ${row.square.variationName}`
      : row.square.itemName;
  }
  return row.sku;
}

export default function Parity() {
  const { parity, squareConnected } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get("view") ?? "both";

  const rows =
    view === "shopify"
      ? parity.shopifyOnly
      : view === "square"
        ? parity.squareOnly
        : parity.both;

  return (
    <s-page heading="SKU parity">
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

      <s-section padding="none">
        <s-box padding="base">
          <s-stack direction="inline" gap="small-200">
            {VIEWS.map(({ key, label }) => {
              const count =
                key === "both"
                  ? parity.both.length
                  : key === "shopify"
                    ? parity.shopifyOnly.length
                    : parity.squareOnly.length;
              return (
                <s-button
                  key={key}
                  variant={view === key ? "primary" : "secondary"}
                  onClick={() => setSearchParams({ view: key })}
                >
                  {`${label} (${count})`}
                </s-button>
              );
            })}
          </s-stack>
        </s-box>

        {rows.length === 0 ? (
          <s-box padding="base">
            <s-paragraph>No SKUs in this bucket.</s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">SKU</s-table-header>
              <s-table-header listSlot="secondary">Product</s-table-header>
              <s-table-header format="numeric" listSlot="labeled">
                Shopify inventory
              </s-table-header>
              <s-table-header format="numeric" listSlot="labeled">
                Square inventory
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((row) => (
                <s-table-row key={row.sku}>
                  <s-table-cell>{row.sku}</s-table-cell>
                  <s-table-cell>{rowName(row)}</s-table-cell>
                  <s-table-cell>
                    {row.shopify ? row.shopify.inventoryQuantity : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    {row.square ? row.square.inventoryQuantity : "—"}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
