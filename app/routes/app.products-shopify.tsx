import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useState } from "react";

import { authenticate } from "../shopify.server";
import { listShopifyProducts } from "../.server/shopify/products";
import {
  groupProducts,
  GroupedProductTable,
  type ProductGroup,
} from "../components/grouped-product-table";
import { PublishSquareProductModal } from "../components/publish-square-product-modal";

const PUBLISH_SQUARE_MODAL_ID = "publish-square-product-modal";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const rows = await listShopifyProducts(admin);
  const products = groupProducts(
    rows.map((row) => ({
      productId: row.productGid,
      productTitle: row.productTitle,
      productCreatedAt: row.productCreatedAt,
      productImageUrl: row.productImageUrl,
      productType: row.productType || null,
      variant: {
        id: row.variantGid,
        name: row.variantTitle === "Default Title" ? null : row.variantTitle,
        sku: row.sku,
      },
    })),
  );

  return { products };
};

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function ShopifyProducts() {
  const { products } = useLoaderData<typeof loader>();
  const [publishSelection, setPublishSelection] = useState<{
    product: ProductGroup;
    requestKey: number;
  } | null>(null);

  const openPublishModal = (product: ProductGroup) => {
    setPublishSelection((current) => ({
      product,
      requestKey: (current?.requestKey ?? 0) + 1,
    }));
  };

  return (
    <s-page heading="Shopify Products">
      <s-section accessibilityLabel="Shopify products" padding="none">
        {products.length > 0 ? (
          <GroupedProductTable
            products={products}
            onPublishProduct={openPublishModal}
            publishModalId={PUBLISH_SQUARE_MODAL_ID}
          />
        ) : (
          <s-box padding="base">
            <s-paragraph>No Shopify products found.</s-paragraph>
          </s-box>
        )}
      </s-section>
      <PublishSquareProductModal
        modalId={PUBLISH_SQUARE_MODAL_ID}
        product={publishSelection?.product ?? null}
        requestKey={publishSelection?.requestKey ?? 0}
      />
    </s-page>
  );
}
