// Pure math for the incremental sync window (no Prisma / server deps, so it's
// importable by both the server engines and the route loader, and unit-testable
// in isolation).
//
// Each run pulls only orders CHANGED since the last sync — new orders and old
// orders edited/refunded, since either bumps the source's updatedAt. Two knobs:
// - SAFETY: a small overlap subtracted from the watermark so nothing slips
//   between runs (clock skew, in-flight updates, timezone).
// - MAX_WINDOW: a hard floor on how far back one run reaches, so a first run
//   (no watermark) or a long gap can't balloon into a full-history scan that
//   blows the serverless time budget — that's what the backfill script is for.

export const INCREMENTAL_SAFETY_MS = 2 * 24 * 60 * 60 * 1000; // 2-day overlap
export const INCREMENTAL_MAX_WINDOW_MS = 45 * 24 * 60 * 60 * 1000; // ~6-week floor

// The updatedAt cutoff for the next pull, given the current watermark.
// No watermark (never synced) → reach back the max window. Otherwise step back
// from the watermark by SAFETY, but never further than MAX_WINDOW.
export function computeIncrementalSince(
  watermark: Date | null,
  nowMs: number,
): Date {
  const floorMs = nowMs - INCREMENTAL_MAX_WINDOW_MS;
  if (!watermark) return new Date(floorMs);
  const sinceMs = watermark.getTime() - INCREMENTAL_SAFETY_MS;
  return new Date(Math.max(sinceMs, floorMs));
}
