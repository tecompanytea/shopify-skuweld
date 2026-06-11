// Date handling for analytics. Two rules from the manual reports:
// 1. Days are bucketed in America/New_York, stored as "YYYY-MM-DD".
// 2. Last-year comparisons are weekday-aligned: LY window = TY window
//    shifted back exactly 364 days (52 weeks), so Mon..Sun lines up with
//    Mon..Sun ("previous_year_match_day_of_week" in Shopify's exports).

const REPORT_TIME_ZONE = "America/New_York";

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: REPORT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// Instant -> "YYYY-MM-DD" in the report timezone.
export function toReportDay(instant: Date): string {
  return dayFormatter.format(instant);
}

export interface DayRange {
  // Inclusive "YYYY-MM-DD" bounds in report-local time.
  start: string;
  end: string;
}

function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  // Noon UTC keeps the calendar date stable under any +-13h zone offset.
  return new Date(Date.UTC(y, m - 1, d, 12));
}

export function shiftDay(day: string, days: number): string {
  const date = parseDay(day);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function weekdayAlignedLastYear(range: DayRange): DayRange {
  return { start: shiftDay(range.start, -364), end: shiftDay(range.end, -364) };
}

// Same calendar dates one year earlier (the product-selling reports' LY
// mode: "May 2026 vs May 2025"). Feb 29 clamps to Feb 28.
export function calendarLastYear(range: DayRange): DayRange {
  const shift = (day: string): string => {
    const [y, m, d] = day.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
    return `${y - 1}-${String(m).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
  };
  return { start: shift(range.start), end: shift(range.end) };
}

// The local-day range covers these UTC instants (for API date filters):
// from start-day 00:00 ET to the instant after end-day 23:59:59.999 ET.
// New York offset is -05:00 (EST) or -04:00 (EDT); using the wider bound on
// each side and bucketing precisely via toReportDay keeps filters correct.
export function rangeToInstants(range: DayRange): { startAt: Date; endAt: Date } {
  const start = parseDay(range.start);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCHours(start.getUTCHours() + 4); // earliest possible 00:00 ET
  const end = parseDay(range.end);
  end.setUTCDate(end.getUTCDate() + 1);
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCHours(end.getUTCHours() + 5); // latest possible midnight ET
  return { startAt: start, endAt: end };
}

export function dayInRange(day: string, range: DayRange): boolean {
  return day >= range.start && day <= range.end;
}
