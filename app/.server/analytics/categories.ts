// The category bridge used by the weekly meeting report: each row joins a
// Square category, a Shopify product type, and a rollup group. Taken
// verbatim from the manual report template (Report sheet rows 19-28).
// v1 hardcodes Té Company's mapping; this becomes per-shop data when the
// analytics feature is generalized.

export type ReportSection = "retail" | "service" | "others";
export type RollupGroup = "Tea" | "Snacks" | "Gifts" | "Accessories" | "Others";

export interface CategoryRow {
  key: string; // display label in the report
  squareCategory: string | null; // Square category name in order data
  shopifyProductType: string | null; // Shopify product type in order data
  group: RollupGroup;
  section: ReportSection;
}

export const CATEGORY_ROWS: CategoryRow[] = [
  {
    key: "Retail Loose Leaf Tea",
    squareCategory: "Retail Loose Leaf Tea",
    shopifyProductType: "Loose Leaf",
    group: "Tea",
    section: "retail",
  },
  {
    key: "Retail Snacks",
    squareCategory: "Retail Snacks",
    shopifyProductType: "Snacks",
    group: "Snacks",
    section: "retail",
  },
  {
    key: "Retail Gifts",
    squareCategory: "Retail Gifts",
    shopifyProductType: "Gift",
    group: "Gifts",
    section: "retail",
  },
  {
    key: "Retail Sachets",
    squareCategory: "Retail Sachets",
    shopifyProductType: "Sachets",
    group: "Tea",
    section: "retail",
  },
  {
    key: "Retail Accessories",
    squareCategory: "Retail Accessories",
    shopifyProductType: "Accessories",
    group: "Accessories",
    section: "retail",
  },
  {
    key: "Service To Stay",
    squareCategory: "Service To Stay",
    shopifyProductType: null,
    group: "Tea",
    section: "service",
  },
  {
    key: "Service Snacks",
    squareCategory: "Service Snacks",
    shopifyProductType: null,
    group: "Snacks",
    section: "service",
  },
  {
    key: "Service To Go",
    squareCategory: "Service To Go",
    shopifyProductType: null,
    group: "Tea",
    section: "service",
  },
  {
    key: "Uncategorized",
    squareCategory: "Uncategorized",
    shopifyProductType: "Event",
    group: "Others",
    section: "others",
  },
  {
    key: "Teaware",
    squareCategory: null,
    shopifyProductType: "Teaware",
    group: "Others",
    section: "others",
  },
];
