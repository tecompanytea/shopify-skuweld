import { beforeEach, describe, expect, it, vi } from "vitest";

const { groupBy } = vi.hoisted(() => ({ groupBy: vi.fn() }));
vi.mock("../app/db.server", () => ({
  default: { salesLine: { groupBy } },
}));

import { computeWeeklyReport } from "../app/.server/analytics/weekly-report";

type GroupedRow = {
  channel: string;
  category: string | null;
  _sum: { netCents: number | null };
};

const RANGE = { start: "2026-06-22", end: "2026-06-28" }; // Mon–Sun

// Synthetic grouped sums, all in cents. Includes lines the report must
// ignore: a Square category outside the bridge and an uncategorized EV line.
const TY_ROWS: GroupedRow[] = [
  { channel: "WV", category: "Retail Loose Leaf Tea", _sum: { netCents: 10000 } },
  { channel: "WV", category: "Service To Stay", _sum: { netCents: 4000 } },
  { channel: "EV", category: "Retail Snacks", _sum: { netCents: 5000 } },
  { channel: "ECOM", category: "Loose Leaf", _sum: { netCents: 3000 } },
  // Shopify "Teaware" folds into the Retail Accessories row.
  { channel: "ECOM", category: "Teaware", _sum: { netCents: 2000 } },
  { channel: "INVOICED", category: null, _sum: { netCents: 7000 } },
  // Not in the category bridge: must not leak into any block.
  { channel: "WV", category: "Random New Category", _sum: { netCents: 999 } },
  { channel: "EV", category: null, _sum: { netCents: 500 } },
];
const LY_ROWS: GroupedRow[] = [
  { channel: "WV", category: "Retail Loose Leaf Tea", _sum: { netCents: 8000 } },
  { channel: "INVOICED", category: null, _sum: { netCents: 1000 } },
];

beforeEach(() => {
  groupBy.mockReset();
  groupBy.mockImplementation(({ where }) =>
    Promise.resolve(where.day.gte === RANGE.start ? TY_ROWS : LY_ROWS),
  );
});

describe("computeWeeklyReport", () => {
  it("weekday-aligns the LY window (364 days back)", async () => {
    const report = await computeWeeklyReport("s", RANGE, "previous-year-dow");
    expect(report.lyRange).toEqual({ start: "2025-06-23", end: "2025-06-29" });
  });

  it("maps Square categories and bridged Shopify types onto category rows", async () => {
    const report = await computeWeeklyReport("s", RANGE, "previous-year-dow");
    const tea = report.categories.find(
      (c) => c.row.key === "Retail Loose Leaf Tea",
    )!;
    expect(tea.wv).toEqual({ ty: 10000, ly: 8000 });
    expect(tea.ecom).toEqual({ ty: 3000, ly: 0 });
    expect(tea.total).toEqual({ ty: 13000, ly: 8000 });
    // Web teaware lands in Retail Accessories, not Others.
    const accessories = report.categories.find(
      (c) => c.row.key === "Retail Accessories",
    )!;
    expect(accessories.ecom.ty).toBe(2000);
  });

  it("foots grand, invoiced, and the combined totals from the category rows only", async () => {
    const report = await computeWeeklyReport("s", RANGE, "previous-year-dow");
    // Unbridged / uncategorized store lines are excluded, so grand agrees
    // with the category table (WV 10000+4000, EV 5000, Ecom 3000+2000).
    expect(report.grand.wv).toEqual({ ty: 14000, ly: 8000 });
    expect(report.grand.ev).toEqual({ ty: 5000, ly: 0 });
    expect(report.grand.ecom).toEqual({ ty: 5000, ly: 0 });
    expect(report.grand.total).toEqual({ ty: 24000, ly: 8000 });
    expect(report.invoiced).toEqual({ ty: 7000, ly: 1000 });
    expect(report.totals.woEcom).toEqual({ ty: 26000, ly: 9000 });
    expect(report.totals.all).toEqual({ ty: 31000, ly: 9000 });
  });

  it("sections and groups each partition the categories to the same grand total", async () => {
    const report = await computeWeeklyReport("s", RANGE, "previous-year-dow");
    const { retail, service, others } = report.sections;
    expect(retail.total.ty + service.total.ty + others.total.ty).toBe(
      report.grand.total.ty,
    );
    expect(service.total.ty).toBe(4000);
    expect(
      report.groups.reduce((sum, group) => sum + group.total.ty, 0),
    ).toBe(report.grand.total.ty);
    const teaGroup = report.groups.find((g) => g.group === "Tea")!;
    expect(teaGroup.total.ty).toBe(17000); // Loose Leaf 13000 + Service To Stay 4000
  });
});
