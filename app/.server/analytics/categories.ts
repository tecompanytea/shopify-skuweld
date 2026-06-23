// The category bridge used by the weekly meeting report: each row joins a
// Square category, the Shopify product type(s) that map to it, and a rollup
// group. Taken from the manual report template (Report sheet rows 19-28).
//
// Teaware: Square has no "Teaware" category — teaware items are sold under
// "Retail Accessories" in Square. Shopify exposes a separate "Teaware" product
// type, so we fold it into the Retail Accessories row (matching the manual
// report and the product-selling "teaware" scope). Web teaware therefore lands
// in Accessories, not Others, and the report stays correct even as products
// drift between the Shopify "Accessories" and "Teaware" types.
//
// v1 hardcodes Té Company's mapping; this becomes per-shop data when the
// analytics feature is generalized.

export type ReportSection = "retail" | "service" | "others";
export type RollupGroup = "Tea" | "Snacks" | "Gifts" | "Accessories" | "Others";

export interface CategoryRow {
  key: string; // display label in the report
  squareCategory: string | null; // Square category name in order data
  shopifyProductTypes: string[]; // Shopify product types folded into this row
  group: RollupGroup;
  section: ReportSection;
}

export const CATEGORY_ROWS: CategoryRow[] = [
  {
    key: "Retail Loose Leaf Tea",
    squareCategory: "Retail Loose Leaf Tea",
    shopifyProductTypes: ["Loose Leaf"],
    group: "Tea",
    section: "retail",
  },
  {
    key: "Retail Snacks",
    squareCategory: "Retail Snacks",
    shopifyProductTypes: ["Snacks"],
    group: "Snacks",
    section: "retail",
  },
  {
    key: "Retail Gifts",
    squareCategory: "Retail Gifts",
    shopifyProductTypes: ["Gift"],
    group: "Gifts",
    section: "retail",
  },
  {
    key: "Retail Sachets",
    squareCategory: "Retail Sachets",
    shopifyProductTypes: ["Sachets"],
    group: "Tea",
    section: "retail",
  },
  {
    key: "Retail Accessories",
    squareCategory: "Retail Accessories",
    // Square files teaware under Retail Accessories; Shopify splits it out as
    // a "Teaware" product type. Fold both so web teaware lands here.
    shopifyProductTypes: ["Accessories", "Teaware"],
    group: "Accessories",
    section: "retail",
  },
  {
    key: "Service To Stay",
    squareCategory: "Service To Stay",
    shopifyProductTypes: [],
    group: "Tea",
    section: "service",
  },
  {
    key: "Service Snacks",
    squareCategory: "Service Snacks",
    shopifyProductTypes: [],
    group: "Snacks",
    section: "service",
  },
  {
    key: "Service To Go",
    squareCategory: "Service To Go",
    shopifyProductTypes: [],
    group: "Tea",
    section: "service",
  },
  {
    key: "Uncategorized",
    squareCategory: "Uncategorized",
    shopifyProductTypes: ["Event"],
    group: "Others",
    section: "others",
  },
];
