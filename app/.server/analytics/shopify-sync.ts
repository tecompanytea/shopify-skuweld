import prisma from "../../db.server";
import { toReportDay, rangeToInstants, dayInRange, type DayRange } from "../../lib/periods";
import {
  resolveIncrementalSince,
  replaceSourceOrders,
} from "./incremental";

// Pulls Shopify sales into the SalesLine fact table (channel ECOM) from the
// order's *sales agreements* — the same event ledger Shopify Analytics
// aggregates. Each agreement (initial order, order edit, refund) carries its
// own timestamp, so exchanges and edits land on the day Shopify books them,
// not the original order date. Sale rows arrive pre-signed (returns are
// negative). PRODUCT lines only: shipping is not part of product net sales,
// and ADJUSTMENT lines have no product to attribute.

interface AdminClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

interface MoneySet {
  shopMoney: { amount: string };
}

interface SaleNode {
  id: string;
  actionType: string;
  lineType: string;
  quantity: number | null;
  totalAmount: MoneySet;
  totalDiscountAmountBeforeTaxes: MoneySet;
  totalTaxAmount: MoneySet;
  lineItem?: {
    id: string;
    name: string;
    sku: string | null;
    variantTitle: string | null;
    product: { productType: string } | null;
  };
}

interface OrdersQueryResult {
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
  data?: {
    orders: {
      nodes: Array<{
        id: string;
        test: boolean;
        agreements: {
          nodes: Array<{
            id: string;
            happenedAt: string;
            sales: {
              nodes: SaleNode[];
              pageInfo: { hasNextPage: boolean };
            };
          }>;
          pageInfo: { hasNextPage: boolean };
        };
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

const ORDERS_QUERY = `#graphql
  query SkuweldAnalyticsAgreements($first: Int!, $after: String, $search: String!, $sortKey: OrderSortKeys!) {
    orders(first: $first, after: $after, query: $search, sortKey: $sortKey) {
      nodes {
        id
        test
        agreements(first: 10) {
          nodes {
            id
            happenedAt
            sales(first: 50) {
              nodes {
                id
                actionType
                lineType
                quantity
                totalAmount { shopMoney { amount } }
                totalDiscountAmountBeforeTaxes { shopMoney { amount } }
                totalTaxAmount { shopMoney { amount } }
                ... on ProductSale {
                  lineItem {
                    id
                    name
                    sku
                    variantTitle
                    product { productType }
                  }
                }
              }
              pageInfo { hasNextPage }
            }
          }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function toCents(amount: string): number {
  return Math.round(parseFloat(amount) * 100);
}

function makeSetState(stateId: string, shop: string) {
  return (status: string, progress?: string, error?: string) =>
    prisma.syncState.upsert({
      where: { id: stateId },
      create: { id: stateId, shop, status, progress, error },
      update: { status, progress, error: error ?? null },
    });
}

interface CollectResult {
  rows: Array<Record<string, unknown>>;
  // Every non-test order the search returned (the delete scope for an
  // incremental, per-order replace).
  seenOrderIds: Set<string>;
  // Orders that actually contributed a product line (the user-facing count).
  countedOrders: Set<string>;
  truncated: number;
}

// Paginate the order search and turn each PRODUCT sale agreement into a fact
// row. `dayFilter` (range mode) keeps only agreements whose bucketed day falls
// in the window; null (incremental mode) keeps every agreement of a touched
// order, so the stored order is always complete.
async function collectAgreementRows(
  admin: AdminClient,
  shop: string,
  search: string,
  sortKey: "PROCESSED_AT" | "UPDATED_AT",
  dayFilter: DayRange | null,
  onProgress: (orders: number, lines: number) => Promise<unknown>,
): Promise<CollectResult> {
  const rows: Array<Record<string, unknown>> = [];
  const seenOrderIds = new Set<string>();
  const countedOrders = new Set<string>();
  let truncated = 0;
  let after: string | null = null;
  let hasNextPage = true;
  let throttleRetries = 0;

  while (hasNextPage) {
    const response = await admin.graphql(ORDERS_QUERY, {
      variables: { first: 100, after, search, sortKey },
    });
    const json = (await response.json()) as OrdersQueryResult;

    // Errors must never read as "no more data" — that would silently truncate
    // the sync (and the delete+insert would wipe orders it never re-fetched).
    if (json.errors?.length) {
      const throttled = json.errors.some(
        (e) => e.extensions?.code === "THROTTLED",
      );
      if (throttled && throttleRetries < 10) {
        throttleRetries += 1;
        await new Promise((resolve) => setTimeout(resolve, 2500));
        continue; // retry the same page
      }
      throw new Error(
        `Shopify GraphQL errors: ${json.errors
          .map((e) => e.message ?? e.extensions?.code)
          .join("; ")}`,
      );
    }
    throttleRetries = 0;
    const orders = json.data?.orders;
    if (!orders) {
      throw new Error("Shopify GraphQL returned no data and no errors");
    }

    for (const order of orders.nodes) {
      if (order.test) continue;
      seenOrderIds.add(order.id);
      if (order.agreements.pageInfo.hasNextPage) truncated += 1;

      for (const agreement of order.agreements.nodes) {
        const occurredAt = new Date(agreement.happenedAt);
        const day = toReportDay(occurredAt);
        if (dayFilter && !dayInRange(day, dayFilter)) continue;
        if (agreement.sales.pageInfo.hasNextPage) truncated += 1;

        for (const sale of agreement.sales.nodes) {
          if (sale.lineType !== "PRODUCT" || !sale.lineItem) continue;
          countedOrders.add(order.id);
          // Signed by Shopify already: returns arrive negative.
          // totalAmount includes taxes; net sales is pre-tax.
          const tax = toCents(sale.totalTaxAmount.shopMoney.amount);
          const net = toCents(sale.totalAmount.shopMoney.amount) - tax;
          const discount = toCents(
            sale.totalDiscountAmountBeforeTaxes.shopMoney.amount,
          );
          rows.push({
            id: `sh:${sale.id}`,
            shop,
            source: "shopify",
            channel: "ECOM",
            kind: sale.actionType === "RETURN" ? "return" : "sale",
            orderId: order.id,
            occurredAt,
            day,
            sku: sale.lineItem.sku,
            itemName: sale.lineItem.name,
            variationName: sale.lineItem.variantTitle,
            category: sale.lineItem.product?.productType || null,
            quantity: sale.quantity ?? 0,
            grossCents: net + discount,
            discountCents: discount,
            netCents: net,
            taxCents: tax,
          });
        }
      }
    }

    hasNextPage = orders.pageInfo.hasNextPage;
    after = orders.pageInfo.endCursor;
    await onProgress(countedOrders.size, rows.length);
  }

  return { rows, seenOrderIds, countedOrders, truncated };
}

async function insertRows(rows: Array<Record<string, unknown>>): Promise<void> {
  for (let i = 0; i < rows.length; i += 1000) {
    await prisma.salesLine.createMany({
      data: rows.slice(i, i + 1000) as never,
      skipDuplicates: true,
    });
  }
}

// Range mode (full/explicit windows — used by the backfill script). Searches
// orders by processed_at across the window plus a lookback for backdated
// edit/refund agreements, then replaces the day-window wholesale.
export async function syncShopifyOrders(
  shop: string,
  admin: AdminClient,
  range: DayRange,
  lookbackDays = 45,
): Promise<{ lines: number; orders: number }> {
  const stateId = `${shop}:shopify-orders`;
  const setState = makeSetState(stateId, shop);

  await setState("running", `Starting ${range.start} → ${range.end}`);
  try {
    const { startAt, endAt } = rangeToInstants(range);
    const searchStart = new Date(startAt);
    searchStart.setUTCDate(searchStart.getUTCDate() - lookbackDays);
    const search = `processed_at:>='${searchStart.toISOString()}' AND processed_at:<='${endAt.toISOString()}'`;

    const { rows, countedOrders, truncated } = await collectAgreementRows(
      admin,
      shop,
      search,
      "PROCESSED_AT",
      range,
      (orders, lines) =>
        setState("running", `${orders} orders, ${lines} lines so far`),
    );

    await prisma.salesLine.deleteMany({
      where: {
        shop,
        source: "shopify",
        day: { gte: range.start, lte: range.end },
      },
    });
    await insertRows(rows);

    const note = truncated > 0 ? ` (warning: ${truncated} truncated pages)` : "";
    await setState(
      "done",
      `${range.start} → ${range.end}: ${countedOrders.size} orders, ${rows.length} lines${note}`,
    );
    return { lines: rows.length, orders: countedOrders.size };
  } catch (error) {
    await setState("error", undefined, String(error));
    throw error;
  }
}

// Incremental mode (the app's Refresh). Pulls only orders updated since the
// watermark, keeps each touched order's full agreement history, and replaces
// those orders' lines in place — so late refunds/edits of older orders are
// caught (the refund bumps updatedAt) without ever rescanning history.
export async function syncShopifyOrdersIncremental(
  shop: string,
  admin: AdminClient,
): Promise<{ lines: number; orders: number }> {
  const stateId = `${shop}:shopify-orders`;
  const setState = makeSetState(stateId, shop);

  const since = await resolveIncrementalSince(stateId, Date.now());
  const sinceLabel = since.toISOString().slice(0, 10);
  await setState("running", `Checking changes since ${sinceLabel}`);
  try {
    const search = `updated_at:>='${since.toISOString()}'`;
    const { rows, seenOrderIds, countedOrders, truncated } =
      await collectAgreementRows(
        admin,
        shop,
        search,
        "UPDATED_AT",
        null,
        (orders, lines) =>
          setState("running", `${orders} orders, ${lines} lines so far`),
      );

    const note = truncated > 0 ? ` (warning: ${truncated} truncated pages)` : "";
    const completedAt = new Date();
    // Atomic: swap the touched orders' rows AND advance the watermark / mark
    // done in one transaction, so a partial failure rolls back everything and
    // the watermark never moves on a half-write. The watermark advances even on
    // a zero-change refresh, so a quiet source doesn't look stale forever.
    await prisma.$transaction(
      async (tx) => {
        await replaceSourceOrders(tx, shop, "shopify", seenOrderIds, rows);
        await tx.syncState.update({
          where: { id: stateId },
          data: {
            status: "done",
            progress: `${countedOrders.size} orders, ${rows.length} lines updated since ${sinceLabel}${note}`,
            error: null,
            watermark: completedAt,
          },
        });
      },
      { timeout: 50_000, maxWait: 15_000 },
    );
    return { lines: rows.length, orders: countedOrders.size };
  } catch (error) {
    await setState("error", undefined, String(error));
    throw error;
  }
}
