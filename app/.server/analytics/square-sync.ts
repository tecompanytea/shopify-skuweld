import prisma from "../../db.server";
import { squareFetch } from "../square/client";
import { toReportDay, rangeToInstants, dayInRange, type DayRange } from "../../lib/periods";
import {
  resolveIncrementalSince,
  deleteLinesForOrders,
} from "./incremental";

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

interface SquareContext {
  channels: Map<string, string>;
  locationIds: string[];
  invoiceOrderIds: Set<string>;
  catalog: Map<string, CatalogVariationInfo>;
}

// Square's order search takes exactly one date_time_filter field, and the sort
// field must match it. Range mode buckets by closed_at (the business date);
// incremental mode finds orders changed since the watermark via updated_at.
type SquareDateFilter =
  | { field: "closed_at"; startAt: string; endAt: string }
  | { field: "updated_at"; startAt: string };

function cents(money: Money | undefined): number {
  return money?.amount ?? 0;
}

function makeSetState(stateId: string, shop: string) {
  return (status: string, progress?: string, error?: string) =>
    prisma.syncState.upsert({
      where: { id: stateId },
      create: { id: stateId, shop, status, progress, error },
      update: { status, progress, error: error ?? null },
    });
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

async function loadSquareContext(shop: string): Promise<SquareContext> {
  const channels = await listLocations(shop);
  const locationIds = [...channels.keys()];
  const invoiceOrderIds = await listInvoiceOrderIds(shop, locationIds);
  const catalog = await buildCatalogMap(shop);
  return { channels, locationIds, invoiceOrderIds, catalog };
}

interface SquareCollectResult {
  rows: Row[];
  seenOrderIds: Set<string>;
}

// Paginate the order search and turn each order's line items + returns into
// fact rows. `dayFilter` (range mode) skips orders whose business day falls
// outside the window; null (incremental mode) keeps every touched order.
async function collectSquareRows(
  shop: string,
  ctx: SquareContext,
  filter: SquareDateFilter,
  dayFilter: DayRange | null,
  onProgress: (orders: number, lines: number) => Promise<unknown>,
): Promise<SquareCollectResult> {
  const rows: Row[] = [];
  const seenOrderIds = new Set<string>();
  let cursor: string | undefined;

  const dateTimeFilter =
    filter.field === "closed_at"
      ? { closed_at: { start_at: filter.startAt, end_at: filter.endAt } }
      : { updated_at: { start_at: filter.startAt } };
  const sortField = filter.field === "closed_at" ? "CLOSED_AT" : "UPDATED_AT";

  do {
    const data = await squareFetch<{ orders?: SquareOrder[]; cursor?: string }>(
      shop,
      "/v2/orders/search",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location_ids: ctx.locationIds,
          limit: 200,
          return_entries: false,
          query: {
            filter: {
              state_filter: { states: ["COMPLETED"] },
              date_time_filter: dateTimeFilter,
            },
            sort: { sort_field: sortField, sort_order: "ASC" },
          },
          ...(cursor ? { cursor } : {}),
        }),
      },
    );

    for (const order of data.orders ?? []) {
      const occurredAt = new Date(order.closed_at ?? order.created_at ?? 0);
      const day = toReportDay(occurredAt);
      if (dayFilter && !dayInRange(day, dayFilter)) continue;
      seenOrderIds.add(order.id);
      const channel = ctx.invoiceOrderIds.has(order.id)
        ? "INVOICED"
        : (ctx.channels.get(order.location_id ?? "") ?? "UNKNOWN");

      const pushLine = (
        line: SquareReturnLineItem,
        kind: "sale" | "return",
        index: number,
      ) => {
        const info = line.catalog_object_id
          ? ctx.catalog.get(line.catalog_object_id)
          : undefined;
        // Gift card sales are liabilities, not sales — Square's own category
        // reports exclude them, so they get their own category that no report
        // row maps to.
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
    await onProgress(seenOrderIds.size, rows.length);
  } while (cursor);

  return { rows, seenOrderIds };
}

async function insertRows(rows: Row[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 1000) {
    await prisma.salesLine.createMany({
      data: rows.slice(i, i + 1000),
      skipDuplicates: true,
    });
  }
}

// Range mode (full/explicit windows — used by the backfill script). Searches
// orders by closed_at across the window and replaces the day-window wholesale.
export async function syncSquareOrders(
  shop: string,
  range: DayRange,
): Promise<{ lines: number; orders: number }> {
  const stateId = `${shop}:square-orders`;
  const setState = makeSetState(stateId, shop);

  await setState("running", `Starting ${range.start} → ${range.end}`);
  try {
    const ctx = await loadSquareContext(shop);
    const { startAt, endAt } = rangeToInstants(range);

    const { rows, seenOrderIds } = await collectSquareRows(
      shop,
      ctx,
      { field: "closed_at", startAt: startAt.toISOString(), endAt: endAt.toISOString() },
      range,
      (orders, lines) =>
        setState("running", `${orders} orders, ${lines} lines so far`),
    );

    await prisma.salesLine.deleteMany({
      where: {
        shop,
        source: "square",
        day: { gte: range.start, lte: range.end },
      },
    });
    await insertRows(rows);

    await setState(
      "done",
      `${range.start} → ${range.end}: ${seenOrderIds.size} orders, ${rows.length} lines`,
    );
    return { lines: rows.length, orders: seenOrderIds.size };
  } catch (error) {
    await setState("error", undefined, String(error));
    throw error;
  }
}

// Incremental mode (the app's Refresh). Pulls only orders updated since the
// watermark and replaces those orders' lines in place — so a return added to
// an older order is picked up (its updatedAt bumps) without rescanning history.
export async function syncSquareOrdersIncremental(
  shop: string,
): Promise<{ lines: number; orders: number }> {
  const stateId = `${shop}:square-orders`;
  const setState = makeSetState(stateId, shop);

  const since = await resolveIncrementalSince(shop, "square", Date.now());
  const sinceLabel = since.toISOString().slice(0, 10);
  await setState("running", `Checking changes since ${sinceLabel}`);
  try {
    const ctx = await loadSquareContext(shop);

    const { rows, seenOrderIds } = await collectSquareRows(
      shop,
      ctx,
      { field: "updated_at", startAt: since.toISOString() },
      null,
      (orders, lines) =>
        setState("running", `${orders} orders, ${lines} lines so far`),
    );

    await deleteLinesForOrders(shop, "square", seenOrderIds);
    await insertRows(rows);

    await setState(
      "done",
      `${seenOrderIds.size} orders, ${rows.length} lines updated since ${sinceLabel}`,
    );
    return { lines: rows.length, orders: seenOrderIds.size };
  } catch (error) {
    await setState("error", undefined, String(error));
    throw error;
  }
}
