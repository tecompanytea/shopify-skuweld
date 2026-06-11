import { toReportDay, shiftDay, type DayRange } from "./periods";

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
  const today = toReportDay(new Date());
  const dayOfWeek = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0=Sun
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const thisMonday = shiftDay(today, -daysSinceMonday);
  return { start: shiftDay(thisMonday, -7), end: shiftDay(thisMonday, -1) };
}

// Resolve a range from ?preset= or explicit ?start=&end= (custom).
export function resolveRange(params: URLSearchParams): DayRange {
  const today = toReportDay(new Date());
  const preset = params.get("preset");
  if (preset === "last-week" || !preset) {
    const start = params.get("start");
    const end = params.get("end");
    if (
      !preset &&
      start &&
      end &&
      /^\d{4}-\d{2}-\d{2}$/.test(start) &&
      /^\d{4}-\d{2}-\d{2}$/.test(end)
    ) {
      return { start, end };
    }
    return defaultRange();
  }
  if (preset === "mtd") {
    return { start: `${today.slice(0, 7)}-01`, end: today };
  }
  if (preset === "qtd") {
    const month = Number(today.slice(5, 7));
    const quarterStartMonth = month - ((month - 1) % 3);
    return {
      start: `${today.slice(0, 4)}-${String(quarterStartMonth).padStart(2, "0")}-01`,
      end: today,
    };
  }
  if (preset === "ytd") {
    return { start: `${today.slice(0, 4)}-01-01`, end: today };
  }
  if (preset === "rolling-12m") {
    return { start: shiftDay(today, -364), end: today };
  }
  if (preset === "custom") {
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
  }
  return defaultRange();
}
