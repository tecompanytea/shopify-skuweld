import type { SyncState } from "@prisma/client";

import { INCREMENTAL_MAX_WINDOW_MS } from "../../lib/incremental-window";
import { toReportDay, type DayRange } from "../../lib/periods";

const STALE_MS = 6 * 60 * 60 * 1000; // a source is stale 6h after its last sync
const SYNC_SOURCES = ["square", "shopify"] as const;

// Live freshness in the incremental model, evaluated per source from each
// source's successful-pull watermark and status. This intentionally does not
// prove historical backfill coverage; old ranges need separate coverage state.
export function evaluateFreshness(
  shop: string,
  syncStates: SyncState[],
  range: DayRange,
  now: number,
): { stale: boolean; historical: boolean; lastSyncedAt: Date | null } {
  const liveCutoffDay = toReportDay(new Date(now - INCREMENTAL_MAX_WINDOW_MS));
  const historical = range.end < liveCutoffDay;
  const stateBy = new Map(syncStates.map((s) => [s.id, s] as const));
  const watermarks = SYNC_SOURCES.map(
    (src) => stateBy.get(`${shop}:${src}-orders`)?.watermark ?? null,
  );
  const errored = SYNC_SOURCES.map(
    (src) => stateBy.get(`${shop}:${src}-orders`)?.status === "error",
  );
  const sourceFresh = SYNC_SOURCES.map(
    (_src, i) =>
      !errored[i] &&
      watermarks[i] !== null &&
      now - watermarks[i]!.getTime() <= STALE_MS,
  );
  // Display the laggard source's age; null if any source has never synced.
  const lastSyncedAt = watermarks.some((w) => w === null)
    ? null
    : new Date(Math.min(...watermarks.map((w) => w!.getTime())));
  const stale = historical ? false : sourceFresh.some((fresh) => !fresh);

  return { stale, historical, lastSyncedAt };
}
