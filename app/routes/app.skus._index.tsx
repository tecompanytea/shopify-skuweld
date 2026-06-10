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
import { syncSkus } from "../.server/skus.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const filter = url.searchParams.get("filter") ?? "all";

  const where = {
    shop: session.shop,
    ...(filter === "clean" ? { isClean: true } : {}),
    ...(filter === "dirty" ? { isClean: false } : {}),
  };

  const [skus, total, cleanCount, ruleCount] = await Promise.all([
    prisma.sku.findMany({ where, orderBy: { value: "asc" } }),
    prisma.sku.count({ where: { shop: session.shop } }),
    prisma.sku.count({ where: { shop: session.shop, isClean: true } }),
    prisma.skuRule.count({ where: { shop: session.shop, enabled: true } }),
  ]);

  return {
    skus: skus.map((sku) => ({
      id: sku.id,
      value: sku.value,
      rawValue: sku.rawValue,
      productName: sku.productName,
      presentInShopify: sku.presentInShopify,
      presentInSquare: sku.presentInSquare,
      isClean: sku.isClean,
      lastSeenAt: sku.lastSeenAt.toISOString(),
    })),
    total,
    cleanCount,
    ruleCount,
    filter,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const result = await syncSkus(session.shop, admin);
  return { sync: result };
};

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

const FILTERS = [
  { key: "all", label: "All" },
  { key: "clean", label: "Clean" },
  { key: "dirty", label: "Needs attention" },
] as const;

export default function SkusIndex() {
  const { skus, total, cleanCount, ruleCount, filter } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [, setSearchParams] = useSearchParams();

  const syncing = fetcher.state !== "idle";
  const syncResult =
    fetcher.data && "sync" in fetcher.data ? fetcher.data.sync : null;

  return (
    <s-page heading="SKU master list">
      <fetcher.Form method="post">
        <s-button
          slot="primary-action"
          type="submit"
          variant="primary"
          disabled={syncing}
        >
          {syncing ? "Syncing…" : "Sync SKUs"}
        </s-button>
      </fetcher.Form>

      {syncResult && (
        <s-banner tone="success">
          Synced {syncResult.seen} SKUs ({syncResult.created} new,{" "}
          {syncResult.updated} updated, {syncResult.disappeared} no longer on
          any channel).
        </s-banner>
      )}

      <s-section padding="none">
        <s-box padding="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-stack direction="inline" gap="small-200">
              {FILTERS.map(({ key, label }) => (
                <s-button
                  key={key}
                  variant={filter === key ? "primary" : "secondary"}
                  onClick={() => setSearchParams({ filter: key })}
                >
                  {label}
                </s-button>
              ))}
            </s-stack>
            <s-text color="subdued">
              {cleanCount}/{total} clean · {ruleCount} active rule
              {ruleCount === 1 ? "" : "s"} ·{" "}
            </s-text>
            <s-link href="/app/skus/rules">Manage rules</s-link>
          </s-stack>
        </s-box>

        {skus.length === 0 ? (
          <s-box padding="base">
            <s-paragraph>
              {total === 0
                ? "No SKUs yet. Click “Sync SKUs” to pull every SKU from Shopify and Square into the master list."
                : "No SKUs match this filter."}
            </s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">SKU</s-table-header>
              <s-table-header listSlot="secondary">Product</s-table-header>
              <s-table-header listSlot="inline">Channels</s-table-header>
              <s-table-header listSlot="labeled">Clean</s-table-header>
              <s-table-header listSlot="labeled">Last seen</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {skus.map((sku) => (
                <s-table-row key={sku.id}>
                  <s-table-cell>{sku.rawValue}</s-table-cell>
                  <s-table-cell>{sku.productName ?? "—"}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      {sku.presentInShopify && (
                        <s-badge tone="success">Shopify</s-badge>
                      )}
                      {sku.presentInSquare && (
                        <s-badge tone="info">Square</s-badge>
                      )}
                      {!sku.presentInShopify && !sku.presentInSquare && (
                        <s-badge>Historical</s-badge>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={sku.isClean ? "success" : "warning"}>
                      {sku.isClean ? "Clean" : "Check"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {new Date(sku.lastSeenAt).toLocaleDateString()}
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
