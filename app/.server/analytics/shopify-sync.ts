import prisma from "../../db.server";
import { toReportDay, rangeToInstants, dayInRange, type DayRange } from "./periods";

// Pulls Shopify orders into the SalesLine fact table (channel ECOM).
// Mirrors Shopify Analytics sales semantics so the numbers reconcile with
// the manual exports: gross = original unit price x qty (pre-discount,
// pre-tax); discounts = allocated line discounts; returns are separate
// negative rows bucketed on the refund date; net = gross - discounts.

interface AdminClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

interface MoneySet {
  shopMoney: { amount: string };
}

interface OrderLineItem {
  id: string;
  name: string;
  sku: string | null;
  quantity: number;
  variantTitle: string | null;
  product: { productType: string } | null;
  originalUnitPriceSet: MoneySet;
  discountAllocations: Array<{ allocatedAmountSet: MoneySet }>;
  taxLines: Array<{ priceSet: MoneySet }>;
}

interface OrdersQueryResult {
  data?: {
    orders: {
      nodes: Array<{
        id: string;
        processedAt: string;
        test: boolean;
        lineItems: {
          nodes: OrderLineItem[];
          pageInfo: { hasNextPage: boolean };
        };
        refunds: Array<{
          id: string;
          createdAt: string;
          refundLineItems: {
            nodes: Array<{
              quantity: number;
              subtotalSet: MoneySet;
              totalTaxSet: MoneySet;
              lineItem: Pick<
                OrderLineItem,
                "id" | "name" | "sku" | "variantTitle" | "product"
              >;
            }>;
            pageInfo: { hasNextPage: boolean };
          };
        }>;
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

const ORDERS_QUERY = `#graphql
  query SkuweldAnalyticsOrders($first: Int!, $after: String, $search: String!) {
    orders(first: $first, after: $after, query: $search, sortKey: PROCESSED_AT) {
      nodes {
        id
        processedAt
        test
        lineItems(first: 100) {
          nodes {
            id
            name
            sku
            quantity
            variantTitle
            product { productType }
            originalUnitPriceSet { shopMoney { amount } }
            discountAllocations { allocatedAmountSet { shopMoney { amount } } }
            taxLines { priceSet { shopMoney { amount } } }
          }
          pageInfo { hasNextPage }
        }
        refunds {
          id
          createdAt
          refundLineItems(first: 100) {
            nodes {
              quantity
              subtotalSet { shopMoney { amount } }
              totalTaxSet { shopMoney { amount } }
              lineItem { id name sku variantTitle product { productType } }
            }
            pageInfo { hasNextPage }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function toCents(amount: string): number {
  return Math.round(parseFloat(amount) * 100);
}

export async function syncShopifyOrders(
  shop: string,
  admin: AdminClient,
  range: DayRange,
): Promise<{ lines: number; orders: number }> {
  const stateId = `${shop}:shopify-orders`;
  const setState = (status: string, progress?: string, error?: string) =>
    prisma.syncState.upsert({
      where: { id: stateId },
      create: { id: stateId, shop, status, progress, error },
      update: { status, progress, error: error ?? null },
    });

  await setState("running", `Starting ${range.start} → ${range.end}`);
  try {
    const { startAt, endAt } = rangeToInstants(range);
    // Refund-only activity in range can live on orders processed earlier;
    // widen the order window a year back and bucket rows by their own day.
    const searchStart = new Date(startAt);
    searchStart.setUTCFullYear(searchStart.getUTCFullYear() - 1);
    const search = `processed_at:>='${searchStart.toISOString()}' AND processed_at:<='${endAt.toISOString()}'`;

    const rows: Array<Record<string, unknown>> = [];
    let orderCount = 0;
    let truncated = 0;
    let after: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const response = await admin.graphql(ORDERS_QUERY, {
        variables: { first: 100, after, search },
      });
      const json = (await response.json()) as OrdersQueryResult;
      const orders = json.data?.orders;
      if (!orders) break;

      for (const order of orders.nodes) {
        if (order.test) continue;
        if (order.lineItems.pageInfo.hasNextPage) truncated += 1;

        const occurredAt = new Date(order.processedAt);
        const saleDay = toReportDay(occurredAt);
        if (dayInRange(saleDay, range)) {
          orderCount += 1;
          for (const line of order.lineItems.nodes) {
            const gross = toCents(line.originalUnitPriceSet.shopMoney.amount) *
              line.quantity;
            const discount = line.discountAllocations.reduce(
              (sum, a) => sum + toCents(a.allocatedAmountSet.shopMoney.amount),
              0,
            );
            const tax = line.taxLines.reduce(
              (sum, t) => sum + toCents(t.priceSet.shopMoney.amount),
              0,
            );
            rows.push({
              id: `sh:${order.id}:${line.id}`,
              shop,
              source: "shopify",
              channel: "ECOM",
              kind: "sale",
              orderId: order.id,
              occurredAt,
              day: saleDay,
              sku: line.sku,
              itemName: line.name,
              variationName: line.variantTitle,
              category: line.product?.productType || null,
              quantity: line.quantity,
              grossCents: gross,
              discountCents: discount,
              netCents: gross - discount,
              taxCents: tax,
            });
          }
        }

        for (const refund of order.refunds) {
          const refundAt = new Date(refund.createdAt);
          const refundDay = toReportDay(refundAt);
          if (!dayInRange(refundDay, range)) continue;
          if (refund.refundLineItems.pageInfo.hasNextPage) truncated += 1;
          for (const [index, rli] of refund.refundLineItems.nodes.entries()) {
            const subtotal = toCents(rli.subtotalSet.shopMoney.amount);
            const tax = toCents(rli.totalTaxSet.shopMoney.amount);
            rows.push({
              id: `sh:${order.id}:refund:${refund.id}:${index}`,
              shop,
              source: "shopify",
              channel: "ECOM",
              kind: "return",
              orderId: order.id,
              occurredAt: refundAt,
              day: refundDay,
              sku: rli.lineItem.sku,
              itemName: rli.lineItem.name,
              variationName: rli.lineItem.variantTitle,
              category: rli.lineItem.product?.productType || null,
              quantity: -rli.quantity,
              grossCents: -subtotal,
              discountCents: 0,
              netCents: -subtotal,
              taxCents: -tax,
            });
          }
        }
      }

      hasNextPage = orders.pageInfo.hasNextPage;
      after = orders.pageInfo.endCursor;
      await setState("running", `${orderCount} orders, ${rows.length} lines so far`);
    }

    await prisma.salesLine.deleteMany({
      where: {
        shop,
        source: "shopify",
        day: { gte: range.start, lte: range.end },
      },
    });
    for (let i = 0; i < rows.length; i += 1000) {
      await prisma.salesLine.createMany({
        data: rows.slice(i, i + 1000) as never,
        skipDuplicates: true,
      });
    }

    const note = truncated > 0 ? ` (warning: ${truncated} truncated pages)` : "";
    await setState(
      "done",
      `${range.start} → ${range.end}: ${orderCount} orders, ${rows.length} lines${note}`,
    );
    return { lines: rows.length, orders: orderCount };
  } catch (error) {
    await setState("error", undefined, String(error));
    throw error;
  }
}
