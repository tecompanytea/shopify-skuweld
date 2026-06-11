import { useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  useFetcher,
  useLoaderData,
  useRouteError,
  useSearchParams,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSquareConnection } from "../.server/square/client";
import { squareConnectionAction } from "../.server/square/connection-action";

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
          merchantId: connection.merchantId,
          // Formatted server-side so SSR and hydration agree on the locale.
          connectedSince: connection.createdAt.toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
            timeZone: "UTC",
          }),
        }
      : { connected: false as const },
    stats: { total, inBoth, shopifyOnly, squareOnly, clean },
  };
};

export const action = squareConnectionAction;

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

const DISCONNECT_MODAL_ID = "square-disconnect-modal";

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
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [searchParams] = useSearchParams();
  const squareStatus = searchParams.get("square");

  // The Square consent page can't render inside the admin iframe; App Bridge
  // turns this into a sanctioned top-level redirect.
  useEffect(() => {
    const authorizeUrl =
      fetcher.data && "authorizeUrl" in fetcher.data
        ? fetcher.data.authorizeUrl
        : null;
    if (authorizeUrl) {
      window.open(authorizeUrl, "_top");
    }
  }, [fetcher.data]);

  useEffect(() => {
    if (fetcher.data && "disconnected" in fetcher.data) {
      shopify.toast.show("Square disconnected");
    }
  }, [fetcher.data, shopify]);

  useEffect(() => {
    if (squareStatus === "connected") {
      shopify.toast.show("Square connected");
    }
  }, [squareStatus, shopify]);

  const busy = fetcher.state !== "idle";

  return (
    <s-page heading="Skuweld">
      <s-section accessibilityLabel="Square connection">
        {squareStatus === "denied" && (
          <s-banner tone="warning">
            Square access was denied. Connect again when you are ready.
          </s-banner>
        )}
        {squareStatus === "error" && (
          <s-banner tone="critical">
            Something went wrong connecting Square. Please try again.
          </s-banner>
        )}

        <s-stack direction="block" gap="base">
          <s-grid
            gridTemplateColumns="auto 1fr auto"
            gap="small-200"
            alignItems="center"
          >
            <s-grid-item>
              <s-thumbnail src="/square-logo.png" alt="Square logo" size="small" />
            </s-grid-item>
            <s-grid-item>
              <s-heading>Square</s-heading>
            </s-grid-item>
            <s-grid-item>
              {square.connected ? (
                <s-badge tone="success">Connected</s-badge>
              ) : (
                <s-badge tone="warning">Not connected</s-badge>
              )}
            </s-grid-item>
          </s-grid>

          {square.connected ? (
            <s-stack direction="block" gap="small-300">
              <s-text type="strong">{square.merchantName}</s-text>
              <s-text color="subdued">
                {`Merchant ID ${square.merchantId} · Connected since ${square.connectedSince}`}
              </s-text>
            </s-stack>
          ) : (
            <s-text color="subdued">
              Connect to compare your Square catalog and inventory with
              Shopify. You will approve read-only access on Square.
            </s-text>
          )}

          <s-stack direction="inline" justifyContent="end">
            {square.connected ? (
              <s-button
                tone="critical"
                disabled={busy}
                commandFor={DISCONNECT_MODAL_ID}
                command="--show"
              >
                Disconnect
              </s-button>
            ) : (
              <s-button
                variant="primary"
                disabled={busy}
                loading={busy}
                onClick={() =>
                  fetcher.submit({ intent: "connect" }, { method: "post" })
                }
              >
                Connect
              </s-button>
            )}
          </s-stack>
        </s-stack>

        {square.connected && (
          <s-modal id={DISCONNECT_MODAL_ID} heading="Disconnect Square?">
            <s-paragraph>
              Skuweld will stop comparing catalogs until you reconnect. Your
              saved SKU list is kept.
            </s-paragraph>
            <s-button
              slot="primary-action"
              variant="primary"
              tone="critical"
              commandFor={DISCONNECT_MODAL_ID}
              command="--hide"
              onClick={() =>
                fetcher.submit({ intent: "disconnect" }, { method: "post" })
              }
            >
              Disconnect
            </s-button>
            <s-button
              slot="secondary-actions"
              commandFor={DISCONNECT_MODAL_ID}
              command="--hide"
            >
              Cancel
            </s-button>
          </s-modal>
        )}
      </s-section>

      <s-section heading="SKU parity at a glance">
        {stats.total === 0 ? (
          <s-paragraph>
            No SKUs in the master list yet. Visit{" "}
            <s-link href="/app/skus">SKUs</s-link> and run “Sync SKUs”, or
            browse <s-link href="/app/products-shopify">Shopify Products</s-link>{" "}
            and{" "}
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
