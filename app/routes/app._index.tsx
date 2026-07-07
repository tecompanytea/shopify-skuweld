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
import {
  getSquareConnection,
  hasSquareScopes,
} from "../.server/square/client";
import { squareConnectionAction } from "../.server/square/connection-action";

const PUBLISH_SCOPES = ["ITEMS_WRITE"] as const;

// Dashboard reads only the local DB so it stays fast; the Products and
// SKU Mapping pages do the live channel fetches.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const connection = await getSquareConnection(session.shop);

  return {
    square: connection
      ? {
          connected: true as const,
          merchantName: connection.merchantName ?? connection.merchantId,
          merchantId: connection.merchantId,
          needsReconnect: !hasSquareScopes(connection.scopes, PUBLISH_SCOPES),
          // Formatted server-side so SSR and hydration agree on the locale.
          connectedSince: connection.createdAt.toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
            timeZone: "UTC",
          }),
        }
      : { connected: false as const },
  };
};

export const action = squareConnectionAction;

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

const DISCONNECT_MODAL_ID = "square-disconnect-modal";

export default function Index() {
  const { square } = useLoaderData<typeof loader>();
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
            gridTemplateColumns="1fr auto"
            gap="base"
            alignItems="center"
          >
            <s-grid-item>
              <s-stack direction="block" gap="small-200">
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-heading>Square</s-heading>
                  {square.connected ? (
                    square.needsReconnect ? (
                      <s-badge tone="warning">Reconnect needed</s-badge>
                    ) : (
                      <s-badge tone="success">Connected</s-badge>
                    )
                  ) : (
                    <s-badge tone="warning">Not connected</s-badge>
                  )}
                </s-stack>
                {square.connected && (
                  <s-text color="subdued">
                    {`Connected as ${square.merchantName}`}
                  </s-text>
                )}
              </s-stack>
            </s-grid-item>
            <s-grid-item>
              {square.connected ? (
                <s-stack direction="inline" gap="small">
                  {square.needsReconnect && (
                    <s-button
                      variant="primary"
                      disabled={busy}
                      loading={busy}
                      onClick={() =>
                        fetcher.submit(
                          { intent: "connect" },
                          { method: "post" },
                        )
                      }
                    >
                      Reconnect
                    </s-button>
                  )}
                  <s-button
                    variant="secondary"
                    tone="critical"
                    disabled={busy}
                    commandFor={DISCONNECT_MODAL_ID}
                    command="--show"
                  >
                    Disconnect
                  </s-button>
                </s-stack>
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
            </s-grid-item>
          </s-grid>

          <s-text color="subdued">
            {square.connected
              ? `Merchant ID ${square.merchantId} · Connected since ${square.connectedSince}`
              : "Connect to compare your Square catalog with Shopify and publish approved products into Square."}
          </s-text>
          {square.connected && square.needsReconnect && (
            <s-banner tone="warning">
              Publish on Square needs catalog write access. Reconnect Square
              once to approve the new scope.
            </s-banner>
          )}
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
    </s-page>
  );
}
