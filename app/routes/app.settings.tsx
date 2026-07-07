import { useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import {
  getSquareConnection,
  hasSquareScopes,
} from "../.server/square/client";
import { squareConnectionAction } from "../.server/square/connection-action";

const PUBLISH_SCOPES = ["ITEMS_WRITE"] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const connection = await getSquareConnection(session.shop);

  return {
    connection: connection
      ? {
          merchantId: connection.merchantId,
          merchantName: connection.merchantName,
          mainLocationId: connection.mainLocationId,
          scopes: connection.scopes,
          expiresAt: connection.expiresAt.toISOString(),
          connectedAt: connection.createdAt.toISOString(),
          needsReconnect: !hasSquareScopes(connection.scopes, PUBLISH_SCOPES),
        }
      : null,
  };
};

export const action = squareConnectionAction;

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function Settings() {
  const { connection } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

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

  const busy = fetcher.state !== "idle";

  return (
    <s-page heading="Settings">
      <s-section heading="Square connection">
        {connection ? (
          <s-stack direction="block" gap="base">
            {connection.needsReconnect && (
              <s-banner tone="warning">
                Reconnect Square to approve catalog write access before using
                Publish on Square.
              </s-banner>
            )}
            <s-paragraph>
              Connected to{" "}
              <s-text type="strong">
                {connection.merchantName ?? connection.merchantId}
              </s-text>{" "}
              since {new Date(connection.connectedAt).toLocaleDateString()}.
            </s-paragraph>
            <s-paragraph color="subdued">
              Scopes: {connection.scopes}. Access token auto-renews; current
              one expires {new Date(connection.expiresAt).toLocaleDateString()}.
            </s-paragraph>
            <s-stack direction="inline" gap="small">
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="connect" />
                <s-button
                  type="submit"
                  variant={connection.needsReconnect ? "primary" : "secondary"}
                  disabled={busy}
                >
                  Reconnect Square
                </s-button>
              </fetcher.Form>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="disconnect" />
                <s-button
                  type="submit"
                  variant="secondary"
                  tone="critical"
                  disabled={busy}
                >
                  Disconnect Square
                </s-button>
              </fetcher.Form>
            </s-stack>
          </s-stack>
        ) : (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Connect your Square account so Skuweld can compare your Square
              catalog and inventory with Shopify, and publish approved Shopify
              products into Square.
            </s-paragraph>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="connect" />
              <s-button type="submit" variant="primary" disabled={busy}>
                Connect Square
              </s-button>
            </fetcher.Form>
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}
