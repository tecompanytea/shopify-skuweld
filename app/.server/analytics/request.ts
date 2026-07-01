import {
  COMPARISON_OPTIONS,
  toReportDay,
  rangeForPreset,
  type ComparisonMode,
  type DayRange,
} from "../../lib/periods";

// Shared request-level helpers for the analytics routes.

// Local development can read another shop's already-synced data (the real
// store's fact table in the shared DB) without being installed there.
// Dev-only; sync actions must stay blocked under the override.
export function analyticsShopOverride(): string | null {
  return process.env.NODE_ENV === "development"
    ? (process.env.ANALYTICS_SHOP_OVERRIDE ?? null)
    : null;
}

export function resolveAnalyticsShop(sessionShop: string): string {
  return analyticsShopOverride() ?? sessionShop;
}

// Last full Mon-Sun week before today (report timezone).
export function defaultRange(): DayRange {
  return rangeForPreset("last-week", toReportDay(new Date()))!;
}

// Resolve a range from ?preset= (quick pick) or ?start=&end= (custom).
export function resolveRange(params: URLSearchParams): DayRange {
  const preset = params.get("preset");
  if (preset === "custom" || !preset) {
    const start = params.get("start");
    const end = params.get("end");
    if (
      start &&
      end &&
      /^\d{4}-\d{2}-\d{2}$/.test(start) &&
      /^\d{4}-\d{2}-\d{2}$/.test(end) &&
      start <= end
    ) {
      return { start, end };
    }
    return defaultRange();
  }
  return rangeForPreset(preset, toReportDay(new Date())) ?? defaultRange();
}

// Comparison window for the LY columns. An explicit ?compare= wins; otherwise
// each report keeps its historical default: product selling compares calendar
// dates ("May vs last May"), everything else weekday-aligns (Mon..Sun).
export function resolveComparison(
  params: URLSearchParams,
  type: string,
): ComparisonMode {
  const value = params.get("compare");
  const match = COMPARISON_OPTIONS.find((option) => option.value === value);
  if (match) return match.value;
  return type.startsWith("product-") ? "previous-year" : "previous-year-dow";
}
