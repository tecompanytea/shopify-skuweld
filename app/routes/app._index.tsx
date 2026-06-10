import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSquareConnection } from "../.server/square/client";

// Dashboard reads only the local DB so it stays fast; the Products and
// Parity pages do the live channel fetches.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [connection, total, inBoth, shopifyOnly, squareOnly, clean] =
    await Promise.all([
      getSquareConnection(shop),
      prisma.sku.count({ where: { shop } }),
      prisma.sku.count({
        where: { shop, presentInShopify: true, presentInSquare: true },
      }),
      prisma.sku.count({
        where: { shop, presentInShopify: true, presentInSquare: false },
      }),
      prisma.sku.count({
        where: { shop, presentInShopify: false, presentInSquare: true },
      }),
      prisma.sku.count({ where: { shop, isClean: true } }),
    ]);

  return {
    square: connection
      ? {
          connected: true as const,
          merchantName: connection.merchantName ?? connection.merchantId,
        }
      : { connected: false as const },
    stats: { total, inBoth, shopifyOnly, squareOnly, clean },
  };
};

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{String(value)}</s-heading>
      </s-stack>
    </s-box>
  );
}

export default function Index() {
  const { square, stats } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Skuweld">
      <s-section heading="Connections">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-badge tone="success">Shopify connected</s-badge>
            {square.connected ? (
              <s-badge tone="success">
                {`Square: ${square.merchantName}`}
              </s-badge>
            ) : (
              <s-badge tone="warning">Square not connected</s-badge>
            )}
          </s-stack>
          {!square.connected && (
            <s-paragraph>
              <s-link href="/app/settings">Connect Square in Settings</s-link>{" "}
              to start comparing catalogs.
            </s-paragraph>
          )}
        </s-stack>
      </s-section>

      <s-section heading="SKU parity at a glance">
        {stats.total === 0 ? (
          <s-paragraph>
            No SKUs in the master list yet. Visit{" "}
            <s-link href="/app/skus">SKUs</s-link> and run “Sync SKUs”, or
            browse <s-link href="/app/products">Products</s-link> and{" "}
            <s-link href="/app/parity">Parity</s-link> for live views.
          </s-paragraph>
        ) : (
          <s-grid
            gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))"
            gap="base"
          >
            <Stat label="Total SKUs" value={stats.total} />
            <Stat label="In both channels" value={stats.inBoth} />
            <Stat label="Shopify only" value={stats.shopifyOnly} />
            <Stat label="Square only" value={stats.squareOnly} />
            <Stat label="Clean" value={stats.clean} />
          </s-grid>
        )}
      </s-section>
    </s-page>
  );
}
