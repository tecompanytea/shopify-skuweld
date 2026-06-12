// Date handling for analytics. Two rules from the manual reports:
// 1. Days are bucketed in America/New_York, stored as "YYYY-MM-DD".
// 2. Last-year comparisons are weekday-aligned: LY window = TY window
//    shifted back exactly 364 days (52 weeks), so Mon..Sun lines up with
//    Mon..Sun ("previous_year_match_day_of_week" in Shopify's exports).
//
// Pure date math only — imported by both server engines and client
// components (the period picker), so nothing here may touch process.env,
// Prisma, or other server-only modules.

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

// ---- Period presets (the date-picker sidebar quick picks) ----

export interface PeriodPresetDef {
  value: string;
  label: string;
}

// Grouped as rendered in the picker sidebar (a divider between groups).
export const PERIOD_PRESET_GROUPS: PeriodPresetDef[][] = [
  [
    { value: "today", label: "Today" },
    { value: "yesterday", label: "Yesterday" },
  ],
  [{ value: "last-week", label: "Last Week" }],
  [
    { value: "wtd", label: "Week to date" },
    { value: "mtd", label: "Month to date" },
    { value: "qtd", label: "Quarter to date" },
    { value: "ytd", label: "Year to date" },
  ],
];

export function presetLabel(preset: string): string | null {
  for (const group of PERIOD_PRESET_GROUPS) {
    for (const def of group) {
      if (def.value === preset) return def.label;
    }
  }
  return null;
}

// Monday of the week containing `day` (report weeks are Mon–Sun).
export function mondayOf(day: string): string {
  const dayOfWeek = new Date(`${day}T12:00:00Z`).getUTCDay(); // 0=Sun
  return shiftDay(day, -((dayOfWeek + 6) % 7));
}

// Range for a quick-pick preset relative to `today` (report-local).
// Returns null for "custom" or unknown presets.
export function rangeForPreset(preset: string, today: string): DayRange | null {
  switch (preset) {
    case "today":
      return { start: today, end: today };
    case "yesterday": {
      const yesterday = shiftDay(today, -1);
      return { start: yesterday, end: yesterday };
    }
    case "last-week": {
      const thisMonday = mondayOf(today);
      return { start: shiftDay(thisMonday, -7), end: shiftDay(thisMonday, -1) };
    }
    case "wtd":
      return { start: mondayOf(today), end: today };
    case "mtd":
      return { start: `${today.slice(0, 7)}-01`, end: today };
    case "qtd": {
      const month = Number(today.slice(5, 7));
      const quarterStartMonth = month - ((month - 1) % 3);
      return {
        start: `${today.slice(0, 4)}-${String(quarterStartMonth).padStart(2, "0")}-01`,
        end: today,
      };
    }
    case "ytd":
      return { start: `${today.slice(0, 4)}-01-01`, end: today };
    default:
      return null;
  }
}
