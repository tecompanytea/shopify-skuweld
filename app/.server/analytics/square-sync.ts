import prisma from "../../db.server";
import { squareFetch } from "../square/client";
import { toReportDay, rangeToInstants, dayInRange, type DayRange } from "../../lib/periods";

// Pulls Square orders (sales + itemized returns) into the SalesLine fact
// table. Channel rules from the manual reports: each store location is its
// own channel (WV / EV); orders created from Square Invoices are the
// INVOICED channel regardless of location, and are excluded from stores.

interface Money {
  amount?: number; // cents
  currency?: string;
}

interface SquareLineItem {
  uid?: string;
  catalog_object_id?: string;
  item_type?: string;
  name?: string;
  variation_name?: string;
  quantity?: string;
  gross_sales_money?: Money;
  total_discount_money?: Money;
  total_tax_money?: Money;
}

interface SquareReturnLineItem extends SquareLineItem {
  gross_return_money?: Money;
}

interface SquareOrder {
  id: string;
  location_id?: string;
  state?: string;
  created_at?: string;
  closed_at?: string;
  line_items?: SquareLineItem[];
  returns?: Array<{ return_line_items?: SquareReturnLineItem[] }>;
}

interface CatalogVariationInfo {
  sku: string | null;
  itemName: string | null;
  categoryName: string | null;
}

function cents(money: Money | undefined): number {
  return money?.amount ?? 0;
}

async function listLocations(
  shop: string,
): Promise<Map<string, string /* channel */>> {
  const data = await squareFetch<{
    locations?: Array<{ id: string; name?: string }>;
  }>(shop, "/v2/locations");
  const channels = new Map<string, string>();
  for (const location of data.locations ?? []) {
    const name = location.name ?? "";
    const channel = /west/i.test(name)
      ? "WV"
      : /east/i.test(name)
        ? "EV"
        : location.id;
    channels.set(location.id, channel);
  }
  return channels;
}

async function listInvoiceOrderIds(
  shop: string,
  locationIds: string[],
): Promise<Set<string>> {
  const orderIds = new Set<string>();
  for (const locationId of locationIds) {
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ location_id: locationId, limit: "200" });
      if (cursor) params.set("cursor", cursor);
      const data = await squareFetch<{
        invoices?: Array<{ order_id?: string }>;
        cursor?: string;
      }>(shop, `/v2/invoices?${params.toString()}`);
      for (const invoice of data.invoices ?? []) {
        if (invoice.order_id) orderIds.add(invoice.order_id);
      }
      cursor = data.cursor;
    } while (cursor);
  }
  return orderIds;
}

// variationId -> sku/item/category, including deleted catalog objects so
// historical orders still resolve.
async function buildCatalogMap(
  shop: string,
): Promise<Map<string, CatalogVariationInfo>> {
  const categoryNames = new Map<string, string>();
  const variations = new Map<string, CatalogVariationInfo>();
  const itemsPending: Array<{
    variationIds: Array<{ id: string; sku: string | null }>;
    itemName: string | null;
    categoryId: string | null;
  }> = [];

  let cursor: string | undefined;
  do {
    const data = await squareFetch<{
      objects?: Array<{
        type: string;
        id: string;
        category_data?: { name?: string };
        item_data?: {
          name?: string;
          reporting_category?: { id?: string };
          categories?: Array<{ id: string }>;
          variations?: Array<{
            id: string;
            item_variation_data?: { sku?: string };
          }>;
        };
      }>;
      cursor?: string;
    }>(shop, "/v2/catalog/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        object_types: ["ITEM", "CATEGORY"],
        include_deleted_objects: true,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      }),
    });

    for (const object of data.objects ?? []) {
      if (object.type === "CATEGORY" && object.category_data?.name) {
        categoryNames.set(object.id, object.category_data.name);
      } else if (object.type === "ITEM" && object.item_data) {
        itemsPending.push({
          itemName: object.item_data.name ?? null,
          categoryId:
            object.item_data.reporting_category?.id ??
            object.item_data.categories?.[0]?.id ??
            null,
          variationIds: (object.item_data.variations ?? []).map((v) => ({
            id: v.id,
            sku: v.item_variation_data?.sku ?? null,
          })),
        });
      }
    }
    cursor = data.cursor;
  } while (cursor);

  for (const item of itemsPending) {
    const categoryName = item.categoryId
      ? (categoryNames.get(item.categoryId) ?? null)
      : null;
    for (const variation of item.variationIds) {
      variations.set(variation.id, {
        sku: variation.sku,
        itemName: item.itemName,
        categoryName,
      });
    }
  }
  return variations;
}

export async function syncSquareOrders(
  shop: string,
  range: DayRange,
): Promise<{ lines: number; orders: number }> {
  const stateId = `${shop}:square-orders`;
  const setState = (status: string, progress?: string, error?: string) =>
    prisma.syncState.upsert({
      where: { id: stateId },
      create: { id: stateId, shop, status, progress, error },
      update: { status, progress, error: error ?? null },
    });

  await setState("running", `Starting ${range.start} → ${range.end}`);
  try {
    const channels = await listLocations(shop);
    const locationIds = [...channels.keys()];
    const invoiceOrderIds = await listInvoiceOrderIds(shop, locationIds);
    const catalog = await buildCatalogMap(shop);
    const { startAt, endAt } = rangeToInstants(range);

    type Row = {
      id: string;
      shop: string;
      source: string;
      channel: string;
      kind: string;
      orderId: string;
      occurredAt: Date;
      day: string;
      sku: string | null;
      itemName: string;
      variationName: string | null;
      category: string | null;
      quantity: number;
      grossCents: number;
      discountCents: number;
      netCents: number;
      taxCents: number;
    };
    const rows: Row[] = [];
    let orderCount = 0;
    let cursor: string | undefined;

    do {
      const data = await squareFetch<{ orders?: SquareOrder[]; cursor?: string }>(
        shop,
        "/v2/orders/search",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location_ids: locationIds,
            limit: 200,
            return_entries: false,
            query: {
              filter: {
                state_filter: { states: ["COMPLETED"] },
                date_time_filter: {
                  closed_at: {
                    start_at: startAt.toISOString(),
                    end_at: endAt.toISOString(),
                  },
                },
              },
              sort: { sort_field: "CLOSED_AT", sort_order: "ASC" },
            },
            ...(cursor ? { cursor } : {}),
          }),
        },
      );

      for (const order of data.orders ?? []) {
        const occurredAt = new Date(order.closed_at ?? order.created_at ?? 0);
        const day = toReportDay(occurredAt);
        if (!dayInRange(day, range)) continue;
        orderCount += 1;
        const channel = invoiceOrderIds.has(order.id)
          ? "INVOICED"
          : (channels.get(order.location_id ?? "") ?? "UNKNOWN");

        const pushLine = (
          line: SquareReturnLineItem,
          kind: "sale" | "return",
          index: number,
        ) => {
          const info = line.catalog_object_id
            ? catalog.get(line.catalog_object_id)
            : undefined;
          // Gift card sales are liabilities, not sales — Square's own
          // category reports exclude them, so they get their own category
          // that no report row maps to.
          const isGiftCard = line.item_type === "GIFT_CARD";
          const gross =
            kind === "return"
              ? cents(line.gross_return_money ?? line.gross_sales_money)
              : cents(line.gross_sales_money);
          const discount = cents(line.total_discount_money);
          const tax = cents(line.total_tax_money);
          const sign = kind === "return" ? -1 : 1;
          rows.push({
            id: `sq:${order.id}:${kind}:${line.uid ?? index}`,
            shop,
            source: "square",
            channel,
            kind,
            orderId: order.id,
            occurredAt,
            day,
            sku: info?.sku ?? null,
            itemName: line.name ?? info?.itemName ?? "(unknown item)",
            variationName: line.variation_name ?? null,
            category: isGiftCard
              ? "Gift Card"
              : (info?.categoryName ?? "Uncategorized"),
            quantity: sign * parseFloat(line.quantity ?? "1"),
            grossCents: sign * gross,
            discountCents: sign * discount,
            netCents: sign * (gross - discount),
            taxCents: sign * tax,
          });
        };

        (order.line_items ?? []).forEach((line, i) => pushLine(line, "sale", i));
        for (const orderReturn of order.returns ?? []) {
          (orderReturn.return_line_items ?? []).forEach((line, i) =>
            pushLine(line, "return", i),
          );
        }
      }

      cursor = data.cursor;
      await setState("running", `${orderCount} orders, ${rows.length} lines so far`);
    } while (cursor);

    // Idempotent re-sync: replace the window for this source.
    await prisma.salesLine.deleteMany({
      where: {
        shop,
        source: "square",
        day: { gte: range.start, lte: range.end },
      },
    });
    for (let i = 0; i < rows.length; i += 1000) {
      await prisma.salesLine.createMany({
        data: rows.slice(i, i + 1000),
        skipDuplicates: true,
      });
    }

    await setState(
      "done",
      `${range.start} → ${range.end}: ${orderCount} orders, ${rows.length} lines`,
    );
    return { lines: rows.length, orders: orderCount };
  } catch (error) {
    await setState("error", undefined, String(error));
    throw error;
  }
}
