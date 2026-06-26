import { describe, expect, it } from "vitest";
import {
  computeIncrementalSince,
  INCREMENTAL_SAFETY_MS,
  INCREMENTAL_MAX_WINDOW_MS,
} from "../app/lib/incremental-window";

// Synthetic-input logic tests: inputs and expectations are derived from first
// principles here, not copied from any real data or report.

const NOW = Date.UTC(2026, 5, 26, 12, 0, 0); // fixed "now" for determinism
const day = 24 * 60 * 60 * 1000;

describe("computeIncrementalSince", () => {
  it("with no watermark, reaches back exactly the max window", () => {
    const since = computeIncrementalSince(null, NOW);
    expect(since.getTime()).toBe(NOW - INCREMENTAL_MAX_WINDOW_MS);
  });

  it("steps back from a recent watermark by the safety overlap", () => {
    const watermark = new Date(NOW - 1 * day); // synced yesterday
    const since = computeIncrementalSince(watermark, NOW);
    expect(since.getTime()).toBe(watermark.getTime() - INCREMENTAL_SAFETY_MS);
  });

  it("auto-widens when syncs were missed for a while", () => {
    const watermark = new Date(NOW - 10 * day); // last sync 10 days ago
    const since = computeIncrementalSince(watermark, NOW);
    // back 10 days + the 2-day safety overlap = 12 days, still under the floor
    expect(since.getTime()).toBe(NOW - 10 * day - INCREMENTAL_SAFETY_MS);
    expect(since.getTime()).toBeGreaterThan(NOW - INCREMENTAL_MAX_WINDOW_MS);
  });

  it("never reaches further back than the max window after a long gap", () => {
    const watermark = new Date(NOW - 200 * day); // huge gap
    const since = computeIncrementalSince(watermark, NOW);
    expect(since.getTime()).toBe(NOW - INCREMENTAL_MAX_WINDOW_MS);
  });

  it("treats a future watermark as a small backward step, not forward", () => {
    const watermark = new Date(NOW + 1 * day); // clock skew safety net
    const since = computeIncrementalSince(watermark, NOW);
    expect(since.getTime()).toBe(NOW + day - INCREMENTAL_SAFETY_MS);
    expect(since.getTime()).toBeLessThanOrEqual(NOW);
  });
});
