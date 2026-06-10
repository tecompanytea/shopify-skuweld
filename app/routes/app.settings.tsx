import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useFetcher,
  useLoaderData,
  useRouteError,
  useSearchParams,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { buildAuthorizeUrl, revokeAccess } from "../.server/square/oauth";
import { getSquareConnection } from "../.server/square/client";

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
        }
      : null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "connect") {
    return { authorizeUrl: buildAuthorizeUrl(session.shop) };
  }

  if (intent === "disconnect") {
    const connection = await getSquareConnection(session.shop);
    if (connection) {
      try {
        await revokeAccess(connection.merchantId);
      } catch (error) {
        // Revoke failing (network, already revoked) shouldn't strand the
        // merchant with a connection row they can't remove.
        console.error("Square revoke failed", error);
      }
      await prisma.squareConnection.delete({ where: { shop: session.shop } });
    }
    return { disconnected: true };
  }

  return { ok: false };
};

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function Settings() {
  const { connection } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
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

  const busy = fetcher.state !== "idle";

  return (
    <s-page heading="Settings">
      <s-section heading="Square connection">
        {squareStatus === "connected" && (
          <s-banner tone="success">Square account connected.</s-banner>
        )}
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

        {connection ? (
          <s-stack direction="block" gap="base">
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
        ) : (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Connect your Square account so Skuweld can compare your Square
              catalog and inventory with Shopify. You will be sent to Square to
              approve read-only access.
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
