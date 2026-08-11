// Kitchen-unit conversions shared with the Stores PAR workflow. A sold box or
// assortment is expanded into the number of individual snacks the kitchens
// need to make. Keep this list aligned with kitchen-stores-par/src/config.js.

export interface SnackAllocation {
  key: string;
  name: string;
  category: string;
  multiplier: number;
}

interface SnackItem {
  key: string;
  name: string;
  category: string;
  skus: Array<string | { sku: string; multiplier: number }>;
  aliases: Array<string | { name: string; multiplier: number }>;
}

interface SnackBundle {
  sku: string;
  components: Array<{ key: string; multiplier: number }>;
}

const item = (
  key: string,
  name: string,
  category: string,
  skus: SnackItem["skus"],
  aliases: SnackItem["aliases"] = [name],
): SnackItem => ({ key, name, category, skus, aliases });

const ITEMS: SnackItem[] = [
  item(
    "pineapple_linzer",
    "Pineapple Linzer",
    "Cookies",
    [
      "200120",
      { sku: "200101", multiplier: 6 },
      { sku: "200102", multiplier: 12 },
    ],
    ["Pineapple Linzer", { name: "Pineapple Linzer Box", multiplier: 6 }],
  ),
  item(
    "pineapple_linzer_mini",
    "Pineapple Linzer - Mini",
    "Cookies",
    [],
    [
      "Pineapple Linzer - Mini",
      "Pineapple Linzer Mini",
      "Mini Pineapple Linzer",
    ],
  ),
  item(
    "seasonal_linzer",
    "Seasonal Linzer",
    "Cookies",
    [
      "202320",
      "202701",
      "203520",
      "202820",
      { sku: "202301", multiplier: 6 },
      { sku: "203501", multiplier: 6 },
      { sku: "202801", multiplier: 6 },
    ],
    [
      "Seasonal Linzer",
      "Strawberry Rhubarb",
      "Cherry Linzer",
      { name: "Seasonal Linzer Box", multiplier: 6 },
      { name: "Cherry Linzer Box", multiplier: 6 },
    ],
  ),
  item(
    "seasonal_linzer_mini",
    "Seasonal Linzer - Mini",
    "Cookies",
    [],
    ["Seasonal Linzer - Mini", "Seasonal Linzer Mini", "Mini Seasonal Linzer"],
  ),
  item("button_shortbread", "Button Shortbread", "Cookies", []),
  item(
    "button_chocolate",
    "Button Chocolate",
    "Cookies",
    [{ sku: "210301", multiplier: 12 }],
    ["Button Chocolate", "Chocolate Button"],
  ),
  item(
    "button_walnut",
    "Button Walnut",
    "Cookies",
    [{ sku: "210201", multiplier: 12 }],
    ["Button Walnut", "Walnut Button"],
  ),
  item(
    "button_almond",
    "Button Almond",
    "Cookies",
    [{ sku: "210101", multiplier: 12 }],
    ["Button Almond", "Almond Button"],
  ),
  item(
    "tinybar_almond",
    "tinybar Almond",
    "Bars & Nougat",
    [{ sku: "220301", multiplier: 12 }],
    ["tinybar Almond", "Tinybar Almond", "Tiny Bar Almond"],
  ),
  item(
    "tinybar_peanut_millet",
    "tinybar Peanut & Millet",
    "Bars & Nougat",
    [{ sku: "220401", multiplier: 12 }],
    [
      "tinybar Peanut & Millet",
      "Tinybar Peanut & Millet",
      "Tiny Bar Peanut & Millet",
      "tinybar Peanut and Millet",
    ],
  ),
  item(
    "tinybar_black_sesame",
    "tinybar Black Sesame",
    "Bars & Nougat",
    [{ sku: "220101", multiplier: 12 }],
    ["tinybar Black Sesame", "Tinybar Black Sesame", "Tiny Bar Black Sesame"],
  ),
  item(
    "tinybar_pumpkin_seed",
    "tinybar Pumpkin Seed",
    "Bars & Nougat",
    [{ sku: "220201", multiplier: 12 }],
    ["tinybar Pumpkin Seed", "Tinybar Pumpkin Seed", "Tiny Bar Pumpkin Seed"],
  ),
  item(
    "date_walnuts",
    "Date & Walnuts",
    "Others",
    [
      { sku: "261100", multiplier: 2 },
      { sku: "250311", multiplier: 2 },
    ],
    [
      { name: "Date & Walnuts", multiplier: 2 },
      { name: "Date and Walnuts", multiplier: 2 },
      { name: "Dates & Walnuts", multiplier: 2 },
      { name: "Dates and Walnuts", multiplier: 2 },
    ],
  ),
  item(
    "tea_egg",
    "Tea Egg (2 EA)",
    "Others",
    [{ sku: "263000", multiplier: 2 }],
    [
      { name: "Tea Egg", multiplier: 2 },
      { name: "Tea Egg 2", multiplier: 2 },
      { name: "Tea Egg 2 (BTS)", multiplier: 2 },
    ],
  ),
  item("soy_sauce", "Soy Sauce", "Others", []),
  item("parchment_paper", "Parchment Paper", "Others", []),
  item("pineapple_cake", "Pineapple Cake", "Traditional Pastries", [
    "203020",
    { sku: "203001", multiplier: 8 },
    { sku: "203002", multiplier: 16 },
  ]),
  item(
    "pineapple_cake_yolk",
    "Pineapple Cake w/ Yolk",
    "Traditional Pastries",
    [
      "203220",
      { sku: "203201", multiplier: 5 },
      { sku: "203202", multiplier: 10 },
    ],
    [
      "Pineapple Cake w/ Yolk",
      "Pineapple Cake with Yolk",
      "Pineapple Cake Yolk",
      "Salt yolk pineapple cake",
    ],
  ),
  item("black_sesame_cake", "Black Sesame Cake", "Traditional Pastries", [
    "203120",
    { sku: "203101", multiplier: 8 },
  ]),
  item(
    "mung_bean_sesame",
    "Mung Bean Sesame",
    "Traditional Pastries",
    [{ sku: "250211", multiplier: 2 }],
    [
      { name: "Mung Bean Sesame", multiplier: 2 },
      { name: "Mung Bean Sesame (2 EA)", multiplier: 2 },
      { name: "Mung bean sesame cake", multiplier: 2 },
    ],
  ),
  item(
    "mung_bean_moon",
    "Mung Bean Moon",
    "Laminated",
    ["206020", "230111"],
    ["Mung Bean Moon", "Mung Bean Mooncake", "Mooncake"],
  ),
  item(
    "red_bean_moon_yolk",
    "Red Bean Moon w/ Yolk",
    "Laminated",
    ["230211"],
    [
      "Red Bean Moon w/ Yolk",
      "Red Bean Moon with Yolk",
      "Red Bean Mooncake w/ Yolk",
      "Red Bean Mooncake with Yolk",
      "Red bean mooncake",
    ],
  ),
  item(
    "biscuit_scallion_pork",
    "Biscuit Scallion and Pork",
    "Laminated",
    ["260200", "250121"],
    [
      "Biscuit Scallion and Pork",
      "Scallion and Pork Biscuit",
      "Scallion Pork Biscuit",
      "Scallion Biscuit",
      "Scallion & Pork",
    ],
  ),
  item(
    "biscuit_shredded_daikon",
    "Biscuit Shredded Daikon",
    "Laminated",
    ["260300", "250122"],
    [
      "Biscuit Shredded Daikon",
      "Shredded Daikon Biscuit",
      "Daikon Biscuit",
      "Daikon (veg)",
    ],
  ),
  item(
    "biscuit_chicken",
    "Biscuit Chicken",
    "Laminated",
    ["260400", "250124"],
    ["Biscuit Chicken", "Chicken Biscuit", "Chicken Biscuit & Mustard Green"],
  ),
  item(
    "seasonal_cake_almond",
    "Seasonal Cake - Almond",
    "Seasonal",
    [
      { sku: "250010", multiplier: 0.125 },
      { sku: "260100", multiplier: 0.125 },
    ],
    [
      { name: "Seasonal Cake - Almond", multiplier: 0.125 },
      { name: "Seasonal Cake Almond", multiplier: 0.125 },
      { name: "Almond cake", multiplier: 0.125 },
      { name: "Seasonal Cake", multiplier: 0.125 },
    ],
  ),
  item(
    "cheesecake_sandwiches",
    "Cheesecake Sandwiches (2 / EA)",
    "Seasonal",
    [{ sku: "200304", multiplier: 2 }],
    [
      { name: "Cheesecake Sandwiches", multiplier: 2 },
      { name: "Cheesecake Sandwich", multiplier: 2 },
      { name: "Cheesecake Sandwiches (2 / EA)", multiplier: 2 },
    ],
  ),
  item(
    "jam_to_serve",
    "Jam (to Serve) S. Rhubarb",
    "Seasonal",
    [],
    [
      "Jam (to Serve) Lemon",
      "Lemon Jam (to Serve)",
      "Jam to Serve Lemon",
      "Jam (to Serve) S. Rhubarb",
      "Jam (to Serve) Strawberry Rhubarb",
    ],
  ),
  item(
    "jam_to_sell",
    "Jam (to Sell) S. Rhubarb",
    "Seasonal",
    ["240102"],
    [
      "Jam (to Sell)",
      "Jam to Sell",
      "Jam (to Sell) S. Rhubarb",
      "Strawberry Rhubarb Jar",
    ],
  ),
  item("hibiscus", "Hibiscus", "Drinks", [], ["Hibiscus", "Hibiscus (4)"]),
  item(
    "watermelon_oolong",
    "Watermelon Oolong",
    "Drinks",
    [],
    ["Watermelon Oolong", "Watermelon Oolong (6)"],
  ),
  item(
    "watermelon_to_serve",
    "Watermelon (To Serve)",
    "Drinks",
    [],
    ["Watermelon (To Serve)", "Watermelon To Serve"],
  ),
  item(
    "ginger_beer",
    "Ginger Beer",
    "Drinks",
    ["110611", "110621"],
    ["Ginger Beer", "Ginger Beer (8 EA)"],
  ),
  item("lemonade", "Lemonade", "Drinks", [], ["Lemonade", "Lemonade (4)"]),
];

const BUNDLES: SnackBundle[] = [
  {
    sku: "210401",
    components: [
      { key: "button_shortbread", multiplier: 3 },
      { key: "button_almond", multiplier: 3 },
      { key: "button_walnut", multiplier: 3 },
      { key: "button_chocolate", multiplier: 3 },
    ],
  },
  {
    sku: "440201",
    components: [
      { key: "pineapple_cake", multiplier: 9 },
      { key: "pineapple_linzer", multiplier: 9 },
    ],
  },
  { sku: "400301", components: [{ key: "pineapple_linzer", multiplier: 6 }] },
  { sku: "400303", components: [{ key: "pineapple_linzer", multiplier: 6 }] },
  {
    sku: "440101",
    components: [
      { key: "button_chocolate", multiplier: 4 },
      { key: "button_almond", multiplier: 3 },
      { key: "button_walnut", multiplier: 3 },
      { key: "button_shortbread", multiplier: 4 },
      { key: "pineapple_cake", multiplier: 3 },
      { key: "pineapple_linzer", multiplier: 3 },
    ],
  },
  {
    sku: "210421",
    components: [
      { key: "button_shortbread", multiplier: 1 },
      { key: "button_almond", multiplier: 1 },
      { key: "button_chocolate", multiplier: 1 },
      { key: "button_walnut", multiplier: 1 },
    ],
  },
  ...["220600", "220522", "220511", "220604"].map((sku) => ({
    sku,
    components: [
      { key: "tinybar_almond", multiplier: 1 },
      { key: "tinybar_peanut_millet", multiplier: 1 },
      { key: "tinybar_black_sesame", multiplier: 1 },
      { key: "tinybar_pumpkin_seed", multiplier: 1 },
    ],
  })),
  ...["220602", "220501"].map((sku) => ({
    sku,
    components: [
      { key: "tinybar_almond", multiplier: 3 },
      { key: "tinybar_peanut_millet", multiplier: 3 },
      { key: "tinybar_black_sesame", multiplier: 3 },
      { key: "tinybar_pumpkin_seed", multiplier: 3 },
    ],
  })),
  { sku: "230101", components: [{ key: "mung_bean_moon", multiplier: 6 }] },
  { sku: "230201", components: [{ key: "red_bean_moon_yolk", multiplier: 6 }] },
  {
    sku: "230301",
    components: [
      { key: "mung_bean_moon", multiplier: 3 },
      { key: "red_bean_moon_yolk", multiplier: 3 },
    ],
  },
  { sku: "262500", components: [{ key: "tea_egg", multiplier: 2 }] },
];

export const IGNORED_SNACK_SKUS = new Set([
  "206021",
  "261400",
  "261200",
  "261500",
  "200220",
  "200201",
  "250221",
  "203402",
  "203401",
  "263100",
]);

export const SNACK_BUNDLE_SKUS = BUNDLES.map((bundle) => bundle.sku);

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\bw\/\b/g, "with")
    .replace(/[()]/g, " ")
    .replace(/[-_/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const byKey = new Map(ITEMS.map((entry) => [entry.key, entry]));
const bySku = new Map<string, SnackAllocation[]>();
const byName = new Map<string, SnackAllocation[]>();

const allocation = (entry: SnackItem, multiplier: number): SnackAllocation => ({
  key: entry.key,
  name: entry.name,
  category: entry.category,
  multiplier,
});

for (const entry of ITEMS) {
  for (const configured of entry.skus) {
    const sku = typeof configured === "string" ? configured : configured.sku;
    const multiplier =
      typeof configured === "string" ? 1 : configured.multiplier;
    bySku.set(sku, [allocation(entry, multiplier)]);
  }
  for (const configured of entry.aliases) {
    const name = typeof configured === "string" ? configured : configured.name;
    const multiplier =
      typeof configured === "string" ? 1 : configured.multiplier;
    byName.set(normalize(name), [allocation(entry, multiplier)]);
  }
}

for (const bundle of BUNDLES) {
  bySku.set(
    bundle.sku,
    bundle.components.map((component) => {
      const entry = byKey.get(component.key);
      if (!entry) throw new Error(`Unknown snack component: ${component.key}`);
      return allocation(entry, component.multiplier);
    }),
  );
}

export function snackAllocations(
  sku: string | null,
  name: string,
): SnackAllocation[] | null {
  const cleanSku = sku?.trim() ?? "";
  return bySku.get(cleanSku) ?? byName.get(normalize(name)) ?? null;
}
