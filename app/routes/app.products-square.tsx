import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { listSquareProducts } from "../.server/square/catalog";
import {
  getSquareConnection,
  SquareNotConnectedError,
} from "../.server/square/client";
import {
  groupProducts,
  GroupedProductTable,
  type ProductGroup,
} from "../components/grouped-product-table";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  let products: ProductGroup[] = [];
  let squareConnected = Boolean(await getSquareConnection(session.shop));
  if (squareConnected) {
    try {
      const catalog = await listSquareProducts(session.shop);
      products = groupProducts(
        catalog.map((row) => ({
          productId: row.itemId,
          productTitle: row.itemName,
          productCreatedAt: row.itemCreatedAt,
          productImageUrl: row.itemImageUrl,
          productType: row.categoryName,
          variant: {
            id: row.variationId,
            name:
              row.variationName && row.variationName !== "Regular"
                ? row.variationName
                : null,
            sku: row.sku,
          },
        })),
      );
    } catch (error) {
      if (error instanceof SquareNotConnectedError) {
        squareConnected = false;
      } else {
        throw error;
      }
    }
  }

  return { products, squareConnected };
};

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function SquareProducts() {
  const { products, squareConnected } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Square Products">
      <s-section accessibilityLabel="Square products" padding="none">
        {!squareConnected ? (
          <s-box padding="base">
            <s-banner tone="warning">
              Square is not connected.{" "}
              <s-link href="/app/settings">Connect Square in Settings</s-link>{" "}
              to see your Square catalog here.
            </s-banner>
          </s-box>
        ) : products.length > 0 ? (
          <GroupedProductTable products={products} />
        ) : (
          <s-box padding="base">
            <s-paragraph>No Square catalog items found.</s-paragraph>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}
