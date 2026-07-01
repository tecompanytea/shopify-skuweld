import { describe, expect, it } from "vitest";

import {
  calendarLastYear,
  comparisonRange,
  previousPeriod,
  weekdayAlignedLastYear,
} from "../app/lib/periods";

describe("previousPeriod", () => {
  it("shifts back by the window's own length", () => {
    expect(previousPeriod({ start: "2026-06-22", end: "2026-06-29" })).toEqual({
      start: "2026-06-14",
      end: "2026-06-21",
    });
  });

  it("handles a single day", () => {
    expect(previousPeriod({ start: "2026-06-30", end: "2026-06-30" })).toEqual({
      start: "2026-06-29",
      end: "2026-06-29",
    });
  });

  it("crosses month and year boundaries", () => {
    expect(previousPeriod({ start: "2026-01-01", end: "2026-01-31" })).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
  });
});

describe("comparisonRange", () => {
  const range = { start: "2026-06-01", end: "2026-06-30" };

  it("maps previous-period", () => {
    expect(comparisonRange("previous-period", range)).toEqual(
      previousPeriod(range),
    );
  });

  it("maps previous-year to calendar dates", () => {
    expect(comparisonRange("previous-year", range)).toEqual(
      calendarLastYear(range),
    );
    expect(comparisonRange("previous-year", range)).toEqual({
      start: "2025-06-01",
      end: "2025-06-30",
    });
  });

  it("maps previous-year-dow to a 364-day shift", () => {
    expect(comparisonRange("previous-year-dow", range)).toEqual(
      weekdayAlignedLastYear(range),
    );
    expect(comparisonRange("previous-year-dow", range)).toEqual({
      start: "2025-06-02",
      end: "2025-07-01",
    });
  });
});
