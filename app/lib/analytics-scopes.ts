// Category scopes for the product-selling report family: which Square
// category and which Shopify product types make up each report. The Teaware
// report intentionally combines Shopify "Teaware" + "Accessories" to match
// Square's single "Retail Accessories" category (per the manual reports'
// own methodology notes).
//
// Pure data, shared by server (report engines) and client (report picker) —
// must stay free of server-only imports.

// Size columns for the units-by-size report (the SKU variant codes).
export const SIZE_COLUMNS = ["1 oz", "2 oz", "4 oz", "8 oz", "10g", "Other"] as const;
export type SizeColumn = (typeof SIZE_COLUMNS)[number];

export interface ProductReportScope {
  key: string;
  label: string;
  squareCategory: string | null;
  shopifyProductTypes: string[];
}

export const PRODUCT_REPORT_SCOPES: ProductReportScope[] = [
  {
    key: "tea",
    label: "Loose Leaf Tea",
    squareCategory: "Retail Loose Leaf Tea",
    shopifyProductTypes: ["Loose Leaf"],
  },
  {
    key: "snacks",
    label: "Snacks",
    squareCategory: "Retail Snacks",
    shopifyProductTypes: ["Snacks"],
  },
  {
    key: "teaware",
    label: "Teaware",
    squareCategory: "Retail Accessories",
    shopifyProductTypes: ["Teaware", "Accessories"],
  },
  {
    key: "gifts",
    label: "Gifts",
    squareCategory: "Retail Gifts",
    shopifyProductTypes: ["Gift"],
  },
  {
    key: "sachets",
    label: "Sachets",
    squareCategory: "Retail Sachets",
    shopifyProductTypes: ["Sachets"],
  },
  {
    key: "service-to-stay",
    label: "Service To Stay",
    squareCategory: "Service To Stay",
    shopifyProductTypes: [],
  },
  {
    key: "service-snacks",
    label: "Service Snacks",
    squareCategory: "Service Snacks",
    shopifyProductTypes: [],
  },
  {
    key: "service-to-go",
    label: "Service To Go",
    squareCategory: "Service To Go",
    shopifyProductTypes: [],
  },
];
