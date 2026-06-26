import { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import { computeIncrementalSince } from "../../lib/incremental-window";

// Server-side helpers for the incremental sync. The pure window math lives in
// app/lib/incremental-window.ts (no Prisma) so it stays unit-testable and the
// route loader can import the constants without pulling in server-only code.

// Read the per-source watermark (SyncState.watermark) — the instant the last
// successful pull finished. Advances on every success, including no-op refreshes
// that found zero changed orders, so a quiet source doesn't keep rescanning the
// same window. Null (never succeeded) → computeIncrementalSince reaches back the
// max window.
export async function resolveIncrementalSince(
  stateId: string,
  nowMs: number,
): Promise<Date> {
  const state = await prisma.syncState.findUnique({
    where: { id: stateId },
    select: { watermark: true },
  });
  return computeIncrementalSince(state?.watermark ?? null, nowMs);
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
