import { describe, expect, it, vi } from "vitest";

vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/.server/square/client", () => ({ squareFetch: vi.fn() }));

import { tastingFlightTeaSelections } from "../app/.server/analytics/square-sync";

describe("tastingFlightTeaSelections", () => {
  it("extracts explicit tea SKUs and multiplies line and modifier quantities", () => {
    expect(
      tastingFlightTeaSelections({
        name: "Tasting Flight",
        quantity: "2",
        modifiers: [
          {
            uid: "tea-1",
            catalog_object_id: "modifier-1",
            name: "Oriental Beauty (105620)",
            quantity: "1",
          },
          {
            uid: "tea-2",
            name: "Mt Pyrus (101320)",
            quantity: "2",
          },
        ],
      }),
    ).toEqual([
      {
        uid: "tea-1",
        catalogObjectId: "modifier-1",
        tea: "Oriental Beauty",
        sku: "105620",
        quantity: 2,
      },
      {
        uid: "tea-2",
        catalogObjectId: null,
        tea: "Mt Pyrus",
        sku: "101320",
        quantity: 4,
      },
    ]);
  });

  it("resolves older named modifiers and retains OPEN choices for audit", () => {
    expect(
      tastingFlightTeaSelections(
        {
          name: "3 tea tasting flight",
          modifiers: [
            { name: "Ruby Brew" },
            { name: "Mt. Qilai" },
            { name: "OPEN" },
          ],
        },
        new Map([
          ["ruby brew", "105520"],
          ["mount qilai", "104220"],
        ]),
      ),
    ).toEqual([
      expect.objectContaining({ tea: "Ruby Brew", sku: "105520", quantity: 1 }),
      expect.objectContaining({ tea: "Mt. Qilai", sku: "104220", quantity: 1 }),
      expect.objectContaining({ tea: "OPEN", sku: null, quantity: 1 }),
    ]);
  });

  it("ignores modifiers on ordinary products", () => {
    expect(
      tastingFlightTeaSelections({
        name: "Iron Goddess",
        modifiers: [{ name: "Oriental Beauty (105620)" }],
      }),
    ).toEqual([]);
  });

  it("keeps missing flight slots visible for audit", () => {
    expect(
      tastingFlightTeaSelections({
        name: "Tasting Flight (Iced)",
        modifiers: [
          { name: "Oriental Beauty (105620)" },
          { name: "Royal Courtesan (100220)" },
        ],
      }),
    ).toContainEqual({
      uid: "missing",
      catalogObjectId: null,
      tea: "(missing tasting flight selection)",
      sku: null,
      quantity: 1,
    });
  });
});
