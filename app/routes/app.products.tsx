import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { listShopifyProducts } from "../.server/shopify/products";
import { listSquareProducts } from "../.server/square/catalog";
import { getInventoryCounts } from "../.server/square/inventory";
import {
  getSquareConnection,
  SquareNotConnectedError,
} from "../.server/square/client";

interface ProductRow {
  id: string;
  name: string;
  inventory: number;
  channel: "Shopify" | "Square";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const shopifyRows = await listShopifyProducts(admin);
  const shopifyProducts: ProductRow[] = shopifyRows.map((row) => ({
    id: row.variantGid,
    name:
      row.variantTitle && row.variantTitle !== "Default Title"
        ? `${row.productTitle} — ${row.variantTitle}`
        : row.productTitle,
    inventory: row.inventoryQuantity,
    channel: "Shopify" as const,
  }));

  let squareProducts: ProductRow[] = [];
  let squareConnected = Boolean(await getSquareConnection(session.shop));
  if (squareConnected) {
    try {
      const catalog = await listSquareProducts(session.shop);
      const counts = await getInventoryCounts(
        session.shop,
        catalog.map((row) => row.variationId),
      );
      squareProducts = catalog.map((row) => ({
        id: row.variationId,
        name:
          row.variationName && row.variationName !== "Regular"
            ? `${row.itemName} — ${row.variationName}`
            : row.itemName,
        inventory: counts.get(row.variationId) ?? 0,
        channel: "Square" as const,
      }));
    } catch (error) {
      if (error instanceof SquareNotConnectedError) {
        squareConnected = false;
      } else {
        throw error;
      }
    }
  }

  return { shopifyProducts, squareProducts, squareConnected };
};

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

function ProductTable({ rows }: { rows: ProductRow[] }) {
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Product name</s-table-header>
        <s-table-header format="numeric" listSlot="labeled">
          Inventory
        </s-table-header>
        <s-table-header listSlot="inline">Channel</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {rows.map((row) => (
          <s-table-row key={row.id}>
            <s-table-cell>{row.name}</s-table-cell>
            <s-table-cell>{row.inventory}</s-table-cell>
            <s-table-cell>
              <s-badge tone={row.channel === "Shopify" ? "success" : "info"}>
                {row.channel}
              </s-badge>
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}

export default function Products() {
  const { shopifyProducts, squareProducts, squareConnected } =
    useLoaderData<typeof loader>();

  return (
    <s-page heading="Products">
      <s-section
        heading={`Shopify products (${shopifyProducts.length})`}
        padding="none"
      >
        {shopifyProducts.length > 0 ? (
          <ProductTable rows={shopifyProducts} />
        ) : (
          <s-box padding="base">
            <s-paragraph>No Shopify products found.</s-paragraph>
          </s-box>
        )}
      </s-section>

      <s-section
        heading={`Square products (${squareProducts.length})`}
        padding="none"
      >
        {!squareConnected ? (
          <s-box padding="base">
            <s-banner tone="warning">
              Square is not connected.{" "}
              <s-link href="/app/settings">Connect Square in Settings</s-link>{" "}
              to see your Square catalog here.
            </s-banner>
          </s-box>
        ) : squareProducts.length > 0 ? (
          <ProductTable rows={squareProducts} />
        ) : (
          <s-box padding="base">
            <s-paragraph>No Square catalog items found.</s-paragraph>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}
