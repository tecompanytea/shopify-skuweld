import { Prisma } from "@prisma/client";
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

// Per-order replace, run inside a transaction by the caller: drop every line
// belonging to the touched orders, then insert their current lines. Atomicity
// matters — if this were delete-then-insert as separate commits and the insert
// failed partway, the successful inserts would advance max(syncedAt) to now,
// collapsing the next run's lookback to the safety overlap and permanently
// skipping the deleted-but-not-reinserted orders. A transaction means a partial
// failure rolls back both, so the watermark never moves on a half-write and the
// next run safely re-pulls the same window. Chunked to stay under Postgres'
// bind-parameter limit.
export async function replaceSourceOrders(
  tx: Prisma.TransactionClient,
  shop: string,
  source: string,
  orderIds: Iterable<string>,
  rows: unknown[],
): Promise<void> {
  const ids = [...orderIds];
  for (let i = 0; i < ids.length; i += 1000) {
    await tx.salesLine.deleteMany({
      where: { shop, source, orderId: { in: ids.slice(i, i + 1000) } },
    });
  }
  for (let i = 0; i < rows.length; i += 1000) {
    await tx.salesLine.createMany({
      data: rows.slice(i, i + 1000) as never,
      skipDuplicates: true,
    });
  }
}
