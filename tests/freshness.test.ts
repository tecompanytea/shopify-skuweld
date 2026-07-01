import type { SyncState } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { evaluateFreshness } from "../app/.server/analytics/freshness";

const NOW = Date.UTC(2026, 5, 30, 12, 0, 0);
const hour = 60 * 60 * 1000;
const shop = "tea.example";

function state(
  source: "square" | "shopify",
  watermark: Date | null,
  status = "done",
): SyncState {
  return {
    id: `${shop}:${source}-orders`,
    shop,
    status,
    progress: null,
    error: null,
    watermark,
    updatedAt: new Date(NOW),
  };
}

describe("evaluateFreshness", () => {
  it("marks live ranges fresh when both source watermarks are recent", () => {
    const result = evaluateFreshness(
      shop,
      [
        state("square", new Date(NOW - hour)),
        state("shopify", new Date(NOW - 2 * hour)),
      ],
      { start: "2026-06-29", end: "2026-06-30" },
      NOW,
    );

    expect(result.stale).toBe(false);
    expect(result.historical).toBe(false);
    expect(result.lastSyncedAt?.getTime()).toBe(NOW - 2 * hour);
  });

  it("marks live ranges stale when a source has never synced", () => {
    const result = evaluateFreshness(
      shop,
      [state("square", new Date(NOW - hour))],
      { start: "2026-06-29", end: "2026-06-30" },
      NOW,
    );

    expect(result.stale).toBe(true);
    expect(result.lastSyncedAt).toBeNull();
  });

  it("marks live ranges stale when any source is in error", () => {
    const result = evaluateFreshness(
      shop,
      [
        state("square", new Date(NOW - hour)),
        state("shopify", new Date(NOW - hour), "error"),
      ],
      { start: "2026-06-29", end: "2026-06-30" },
      NOW,
    );

    expect(result.stale).toBe(true);
  });

  it("does not mark historical ranges stale under the incremental freshness model", () => {
    const result = evaluateFreshness(
      shop,
      [],
      { start: "2026-04-01", end: "2026-04-30" },
      NOW,
    );

    expect(result.stale).toBe(false);
    expect(result.historical).toBe(true);
  });
});
