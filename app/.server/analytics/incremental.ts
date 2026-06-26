import prisma from "../../db.server";
import { computeIncrementalSince } from "../../lib/incremental-window";

// Server-side helpers for the incremental sync. The pure window math lives in
// app/lib/incremental-window.ts (no Prisma) so it stays unit-testable and the
// route loader can import the constants without pulling in server-only code.

// Watermark = the newest row we've written for this source. Every write stamps
// syncedAt, so max(syncedAt) is effectively "when we last synced up to" — a
// usable high-water mark without a dedicated column.
export async function resolveIncrementalSince(
  shop: string,
  source: string,
  nowMs: number,
): Promise<Date> {
  const agg = await prisma.salesLine.aggregate({
    _max: { syncedAt: true },
    where: { shop, source },
  });
  return computeIncrementalSince(agg._max.syncedAt, nowMs);
}

// Per-order replace: drop every line belonging to the touched orders, so the
// caller can re-insert each order's current lines without double-counting and
// while clearing lines that disappeared from an order (a removed item, a
// fully-reversed order). Chunked to stay under Postgres' bind-parameter limit.
export async function deleteLinesForOrders(
  shop: string,
  source: string,
  orderIds: Iterable<string>,
): Promise<void> {
  const ids = [...orderIds];
  for (let i = 0; i < ids.length; i += 1000) {
    await prisma.salesLine.deleteMany({
      where: { shop, source, orderId: { in: ids.slice(i, i + 1000) } },
    });
  }
}
