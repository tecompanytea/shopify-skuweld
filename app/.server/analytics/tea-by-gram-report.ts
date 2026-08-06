import prisma from "../../db.server";
import type { DayRange } from "../../lib/periods";
import { productName, skuFamily } from "../../lib/sku-scheme";

// Tea usage report: translate positive tea sales into dry-leaf weight and
// decompose known gift SKUs into their component teas. Tea bags remain a count
// (never an inferred gram weight) and are reported separately.

export type GramBasis =
  | "1 oz"
  | "2 oz"
  | "4 oz"
  | "8 oz"
  | "10 g"
  | "TO GO"
  | "TO STAY"
  | "ICED TO STAY"
  | "TASTING FLIGHT"
  | "OOLONG PALMER"
  | "GIFT";

export interface GramConversion {
  grams: number;
  basis: GramBasis;
}

interface ConvertibleLine {
  category: string | null;
  itemName: string;
  variationName: string | null;
  productTitle?: string | null;
  sku: string | null;
}

const OZ_GRAMS: Record<string, GramConversion> = {
  "01": { grams: 30, basis: "1 oz" },
  "02": { grams: 60, basis: "2 oz" },
  "04": { grams: 120, basis: "4 oz" },
  "08": { grams: 240, basis: "8 oz" },
};

function compact(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function productText(line: ConvertibleLine): string {
  return compact(`${line.productTitle ?? ""} ${line.itemName}`);
}

function isExcludedGramLine(line: ConvertibleLine): boolean {
  const product = productText(line);
  return (
    /\bsharing pot\b/.test(product) ||
    /\bshopping bags?\b/.test(product) ||
    /\btasting flight\b/.test(product)
  );
}

function isOolongPalmerLine(line: ConvertibleLine): boolean {
  return /\boolong palmer\b/.test(productText(line));
}

// Category is authoritative for prepared tea because its six-digit SKU suffix
// identifies the service variant, not an ounce size. Variant text handles
// historical/category-drift rows and distinguishes iced TO STAY.
export function gramConversionOf(line: ConvertibleLine): GramConversion | null {
  const category = compact(line.category);
  if (isExcludedGramLine(line)) return null;
  if (category === "tasting flight tea") {
    return { grams: 4, basis: "TASTING FLIGHT" };
  }
  const text = compact(`${line.variationName ?? ""} ${line.itemName}`);
  const isToGo = category === "service to go" || /\bto go\b/.test(text);
  const isToStay = category === "service to stay" || /\bto stay\b/.test(text);

  if (isToGo) return { grams: 4, basis: "TO GO" };
  if (isToStay) {
    return /\biced?\b/.test(text)
      ? { grams: 4, basis: "ICED TO STAY" }
      : { grams: 6, basis: "TO STAY" };
  }

  const variant = compact(line.variationName);
  if (/\b10\s*g(?:rams?)?\b/.test(variant)) {
    return { grams: 10, basis: "10 g" };
  }
  for (const [ounces, conversion] of [
    ["1", OZ_GRAMS["01"]],
    ["2", OZ_GRAMS["02"]],
    ["4", OZ_GRAMS["04"]],
    ["8", OZ_GRAMS["08"]],
  ] as const) {
    if (new RegExp(`\\b${ounces}\\s*oz\\b`).test(variant)) return conversion;
  }

  const sku = line.sku?.trim() ?? "";
  if (/^\d{6}$/.test(sku)) return OZ_GRAMS[sku.slice(4)] ?? null;
  return null;
}

interface GiftTeaDefinition {
  tea: string;
  aliases?: string[];
  // Seasonal teas intentionally report as named rows, without a SKU family.
  reportByName?: boolean;
}

const GIFT_TEAS = {
  "baozhong-experts-pick": { tea: "Baozhong Expert's Pick" },
  "valley-dragon-phoenix": { tea: "Valley of Dragon & Phoenix" },
  "oriental-beauty": { tea: "Oriental Beauty" },
  "frozen-summit": { tea: "Frozen Summit" },
  "jade-rouge": { tea: "Jade Rouge" },
  "iron-goddess": { tea: "Iron Goddess" },
  "da-yu-ling": { tea: "Da Yu Ling" },
  "frozen-summit-grand": { tea: "Frozen Summit Grand" },
  "canyon-green": { tea: "Canyon Green" },
  "white-peony": { tea: "White Peony" },
  "mount-qilai": { tea: "Mount Qilai" },
  "oriental-beauty-grand": { tea: "Oriental Beauty Grand" },
  "iron-goddess-archetype": { tea: "Iron Goddess Archetype" },
  "baozhong-vintage": { tea: "Baozhong Vintage" },
  "royal-courtesan": { tea: "Royal Courtesan" },
  "mount-pyrus": { tea: "Mount Pyrus" },
  "mount-ali": { tea: "Mount A-Li", aliases: ["Mount Ali"] },
  "crimson-white": { tea: "Crimson White", reportByName: true },
  "jaipuri-assam-white": {
    tea: "Jaipuri Assam White",
    reportByName: true,
  },
  "jaipuri-assam-black": {
    tea: "Jaipuri Assam Black",
    reportByName: true,
  },
  "sun-moon-lake-mountain-black": {
    tea: "Sun Moon Lake Mountain Black",
    reportByName: true,
  },
  "lugu-medium-roast": { tea: "Lugu Medium Roast", reportByName: true },
  "lugu-dark-roast": { tea: "Lugu Dark Roast", reportByName: true },
  "high-mountain-90-vintage": {
    tea: "High Mountain '90 Vintage",
    reportByName: true,
  },
  "golden-lily": { tea: "Golden Lily", reportByName: true },
  "muzha-tieguanyin": { tea: "Muzha Tieguanyin", reportByName: true },
} satisfies Record<string, GiftTeaDefinition>;

type GiftTeaKey = keyof typeof GIFT_TEAS;

export interface GiftGramComponent {
  teaKey: GiftTeaKey;
  tea: string;
  grams: number;
}

export interface GiftGramRecipe {
  gift: string;
  components: GiftGramComponent[];
}

function component(teaKey: GiftTeaKey, grams: number): GiftGramComponent {
  return { teaKey, tea: GIFT_TEAS[teaKey].tea, grams };
}

const BOUNTY_26_COMPONENTS: GiftGramComponent[] = [
  component("crimson-white", 4),
  component("jaipuri-assam-white", 4),
  component("jaipuri-assam-black", 8),
  component("sun-moon-lake-mountain-black", 8),
  component("lugu-medium-roast", 8),
  component("lugu-dark-roast", 8),
];

const GIFT_GRAM_RECIPES: Record<string, GiftGramRecipe> = {
  "400101": {
    gift: "Iconic Taiwanese Tea Set",
    components: [
      component("baozhong-experts-pick", 10),
      component("valley-dragon-phoenix", 10),
      component("oriental-beauty", 10),
      component("frozen-summit", 10),
      component("jade-rouge", 10),
      component("iron-goddess", 10),
    ],
  },
  "400301": {
    gift: "Choicest Tea & Biscuits — Loose Leaf",
    components: [component("oriental-beauty", 60)],
  },
  "400801": {
    gift: "Teatime Spectacular",
    components: [
      component("da-yu-ling", 30),
      component("frozen-summit-grand", 30),
    ],
  },
  "400201": {
    gift: "Formosa Collection",
    components: [
      component("canyon-green", 10),
      component("white-peony", 3.5),
      component("mount-qilai", 10),
      component("oriental-beauty-grand", 10),
      component("frozen-summit-grand", 10),
      component("iron-goddess-archetype", 10),
      component("baozhong-vintage", 10),
    ],
  },
  "400601": {
    gift: "Superb Iced Tea Duo",
    components: [
      component("royal-courtesan", 60),
      component("iron-goddess", 60),
    ],
  },
  "400501": {
    gift: "High Mountain Tea Set",
    components: [
      component("mount-pyrus", 60),
      component("valley-dragon-phoenix", 60),
      component("mount-ali", 60),
    ],
  },
  "400401": {
    gift: "Classic Taiwanese Oolong Set",
    components: [
      component("frozen-summit", 60),
      component("mount-pyrus", 60),
      component("oriental-beauty", 60),
    ],
  },
  "402405": {
    gift: "Bounty Box '26",
    components: BOUNTY_26_COMPONENTS,
  },
  "402406": {
    gift: "Big Bounty Extravaganza '26",
    components: [
      ...BOUNTY_26_COMPONENTS,
      component("high-mountain-90-vintage", 10),
      component("golden-lily", 30),
      component("muzha-tieguanyin", 30),
    ],
  },
};

export interface TeaBagRecipe {
  gift: string;
  teaBagsPerUnit: number;
}

const TEA_BAG_RECIPES: Record<string, TeaBagRecipe> = {
  "400303": {
    gift: "Choicest Tea & Biscuits — Tea Sachets",
    teaBagsPerUnit: 12,
  },
};

export function giftGramRecipe(sku: string): GiftGramRecipe | null {
  return GIFT_GRAM_RECIPES[sku.trim()] ?? null;
}

export function teaBagRecipe(sku: string): TeaBagRecipe | null {
  return TEA_BAG_RECIPES[sku.trim()] ?? null;
}

const GIFT_SKUS = [
  ...Object.keys(GIFT_GRAM_RECIPES),
  ...Object.keys(TEA_BAG_RECIPES),
];

export interface TeaGramRow {
  key: string;
  skuFamily: string | null;
  name: string;
  byChannel: Record<string, number>;
  totalGrams: number;
  totalKilograms: number;
}

export interface TeaGramSkuRow {
  skuFamily: string | null;
  tea: string;
  sku: string;
  variant: string;
  channel: string;
  basis: GramBasis;
  gramsPerUnit: number;
  units: number;
  totalGrams: number;
}

export interface TeaBagCountRow {
  sku: string;
  gift: string;
  teaBagsPerUnit: number;
  byChannel: Record<string, number>;
  totalTeaBags: number;
}

export interface UnmappedGramRow {
  sku: string;
  item: string;
  variant: string;
  category: string;
  channel: string;
  units: number;
  reason: string;
}

export interface TeaByGramReport {
  range: DayRange;
  channels: string[];
  rows: TeaGramRow[];
  skuRows: TeaGramSkuRow[];
  teaBagRows: TeaBagCountRow[];
  unmapped: UnmappedGramRow[];
  totalGrams: number;
  totalKilograms: number;
  totalTeaBags: number;
}

type SalesLine = {
  channel: string;
  category: string | null;
  itemName: string;
  variationName: string | null;
  productTitle: string | null;
  sku: string | null;
  quantity: number;
};

function teaName(line: SalesLine): string {
  const title = productName(
    line.productTitle ?? line.itemName,
    line.variationName,
  );
  return title
    .replace(/\s*[-–—]?\s*(?:iced\s+)?to\s+(?:go|stay)\s*$/i, "")
    .trim();
}

function normalizedTeaName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface TeaAcc {
  key: string;
  skuFamily: string | null;
  byChannel: Map<string, number>;
  names: Map<string, number>;
}

interface DetailAcc extends TeaGramSkuRow {
  aggregationKey: string;
}

interface TeaBagAcc {
  sku: string;
  recipe: TeaBagRecipe;
  byChannel: Map<string, number>;
}

export async function computeTeaByGramReport(
  shop: string,
  range: DayRange,
): Promise<TeaByGramReport> {
  // Returns/refunds are deliberately ignored: this report measures dry tea
  // prepared or packed at the time of the positive sale, not net sales.
  const [lines, catalogSkus] = await Promise.all([
    prisma.salesLine.findMany({
      where: {
        shop,
        day: { gte: range.start, lte: range.end },
        kind: { in: ["sale", "usage"] },
        quantity: { gt: 0 },
        OR: [
          {
            source: "square",
            category: {
              in: [
                "Retail Loose Leaf Tea",
                "Service To Go",
                "Service To Stay",
                "Tasting Flight Tea",
              ],
            },
          },
          { source: "shopify", category: "Loose Leaf" },
          { sku: { in: GIFT_SKUS } },
        ],
      },
      select: {
        channel: true,
        category: true,
        itemName: true,
        variationName: true,
        productTitle: true,
        sku: true,
        quantity: true,
      },
    }),
    prisma.sku.findMany({
      where: { shop },
      select: { value: true, productName: true },
    }),
  ]);

  // Resolve a gift component's catalog family by its current product title.
  // Recipes retain a stable tea key, so off-menu seasonal teas still aggregate
  // correctly even when no permanent six-digit product SKU exists.
  const familyByTeaName = new Map<string, string>();
  for (const row of catalogSkus) {
    const family = skuFamily(row.value);
    if (family && row.productName) {
      familyByTeaName.set(normalizedTeaName(row.productName), family);
    }
  }
  for (const line of lines) {
    const sku = line.sku?.trim() ?? "";
    if (giftGramRecipe(sku) || teaBagRecipe(sku)) continue;
    const family = skuFamily(sku);
    if (family) familyByTeaName.set(normalizedTeaName(teaName(line)), family);
  }

  const teas = new Map<string, TeaAcc>();
  const details = new Map<string, DetailAcc>();
  const teaBags = new Map<string, TeaBagAcc>();
  const unmapped = new Map<string, UnmappedGramRow>();
  const channels = new Set<string>();

  const addUnmapped = (
    line: SalesLine,
    reason: string,
    variant = line.variationName ?? "",
  ) => {
    const row: UnmappedGramRow = {
      sku: line.sku?.trim() || "(missing)",
      item: line.productTitle ?? line.itemName,
      variant,
      category: line.category ?? "",
      channel: line.channel,
      units: line.quantity,
      reason,
    };
    const key = [
      row.sku,
      row.item,
      row.variant,
      row.category,
      row.channel,
      row.reason,
    ].join("\u0000");
    const prior = unmapped.get(key);
    if (prior) prior.units += row.units;
    else unmapped.set(key, row);
  };

  const addTea = (
    key: string,
    family: string | null,
    name: string,
    channel: string,
    grams: number,
    nameWeight: number,
  ) => {
    let acc = teas.get(key);
    if (!acc) {
      acc = {
        key,
        skuFamily: family,
        byChannel: new Map(),
        names: new Map(),
      };
      teas.set(key, acc);
    }
    acc.byChannel.set(channel, (acc.byChannel.get(channel) ?? 0) + grams);
    acc.names.set(name, (acc.names.get(name) ?? 0) + nameWeight);
  };

  const addDetail = (
    aggregationKey: string,
    row: Omit<TeaGramSkuRow, "units" | "totalGrams">,
    units: number,
    totalGrams: number,
  ) => {
    const key = [
      aggregationKey,
      row.sku,
      row.variant,
      row.channel,
      row.basis,
    ].join("\u0000");
    const prior = details.get(key);
    if (prior) {
      prior.units += units;
      prior.totalGrams += totalGrams;
    } else {
      details.set(key, {
        aggregationKey,
        ...row,
        units,
        totalGrams,
      });
    }
  };

  const componentFamily = (teaKey: GiftTeaKey): string | null => {
    const definition: GiftTeaDefinition = GIFT_TEAS[teaKey];
    if (definition.reportByName) return null;
    for (const candidate of [definition.tea, ...(definition.aliases ?? [])]) {
      const family = familyByTeaName.get(normalizedTeaName(candidate));
      if (family) return family;
    }
    return null;
  };

  for (const line of lines) {
    channels.add(line.channel);
    const sku = line.sku?.trim() ?? "";
    const bagRecipe = teaBagRecipe(sku);
    if (bagRecipe) {
      let acc = teaBags.get(sku);
      if (!acc) {
        acc = { sku, recipe: bagRecipe, byChannel: new Map() };
        teaBags.set(sku, acc);
      }
      const count = line.quantity * bagRecipe.teaBagsPerUnit;
      acc.byChannel.set(
        line.channel,
        (acc.byChannel.get(line.channel) ?? 0) + count,
      );
      continue;
    }

    const giftRecipe = giftGramRecipe(sku);
    if (giftRecipe) {
      for (const recipeComponent of giftRecipe.components) {
        const definition: GiftTeaDefinition = GIFT_TEAS[recipeComponent.teaKey];
        const family = componentFamily(recipeComponent.teaKey);
        const aggregationKey = family
          ? `family:${family}`
          : `gift-tea:${recipeComponent.teaKey}`;
        const grams = line.quantity * recipeComponent.grams;
        addTea(
          aggregationKey,
          family,
          recipeComponent.tea,
          line.channel,
          grams,
          line.quantity,
        );
        addDetail(
          aggregationKey,
          {
            skuFamily: family,
            tea: recipeComponent.tea,
            sku,
            variant: giftRecipe.gift,
            channel: line.channel,
            basis: "GIFT",
            gramsPerUnit: recipeComponent.grams,
          },
          line.quantity,
          grams,
        );
        if (!family && !definition.reportByName) {
          addUnmapped(
            line,
            "Gift tea could not be matched to a six-digit tea SKU family",
            recipeComponent.tea,
          );
        }
      }
      continue;
    }

    if (isExcludedGramLine(line)) continue;

    const conversion = gramConversionOf(line);
    if (!conversion) {
      addUnmapped(line, "Variant has no gram conversion");
      continue;
    }

    if (isOolongPalmerLine(line)) {
      const rubyBrewName = "Ruby Brew";
      const family =
        familyByTeaName.get(normalizedTeaName(rubyBrewName)) ?? null;
      const aggregationKey = family
        ? `family:${family}`
        : "recipe:oolong-palmer";
      const gramsPerUnit = conversion.grams / 2;
      const grams = line.quantity * gramsPerUnit;
      addTea(
        aggregationKey,
        family,
        rubyBrewName,
        line.channel,
        grams,
        line.quantity,
      );
      addDetail(
        aggregationKey,
        {
          skuFamily: family,
          tea: rubyBrewName,
          sku,
          variant: line.variationName ?? "",
          channel: line.channel,
          basis: "OOLONG PALMER",
          gramsPerUnit,
        },
        line.quantity,
        grams,
      );
      if (!family) {
        addUnmapped(
          line,
          "Oolong Palmer could not be matched to the Ruby Brew SKU family",
        );
      }
      continue;
    }

    const family = skuFamily(sku);
    if (!family) {
      addUnmapped(line, "Missing or non-standard six-digit tea SKU");
      continue;
    }

    const aggregationKey = `family:${family}`;
    const grams = line.quantity * conversion.grams;
    const name = teaName(line) || family;
    // Prefer the retail loose-leaf catalog title as the family's display name;
    // service buttons and gift components fold into the same family.
    const retailWeight = /loose leaf/i.test(line.category ?? "")
      ? 1_000_000
      : 0;
    addTea(
      aggregationKey,
      family,
      name,
      line.channel,
      grams,
      retailWeight + line.quantity,
    );
    addDetail(
      aggregationKey,
      {
        skuFamily: family,
        tea: name,
        sku,
        variant: line.variationName ?? "",
        channel: line.channel,
        basis: conversion.basis,
        gramsPerUnit: conversion.grams,
      },
      line.quantity,
      grams,
    );
  }

  const channelList = [...channels].sort();
  const namesByKey = new Map<string, string>();
  const rows: TeaGramRow[] = [...teas.values()].map((acc) => {
    const name =
      [...acc.names.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )[0]?.[0] ?? acc.key;
    namesByKey.set(acc.key, name);
    const byChannel: Record<string, number> = {};
    let totalGrams = 0;
    for (const channel of channelList) {
      const grams = acc.byChannel.get(channel) ?? 0;
      byChannel[channel] = grams;
      totalGrams += grams;
    }
    return {
      key: acc.key,
      skuFamily: acc.skuFamily,
      name,
      byChannel,
      totalGrams,
      totalKilograms: totalGrams / 1_000,
    };
  });
  rows.sort(
    (a, b) => b.totalGrams - a.totalGrams || a.name.localeCompare(b.name),
  );

  const skuRows = [...details.values()].map(
    ({ aggregationKey, ...row }): TeaGramSkuRow => ({
      ...row,
      tea: namesByKey.get(aggregationKey) ?? row.tea,
    }),
  );
  skuRows.sort(
    (a, b) =>
      (a.skuFamily ?? "~").localeCompare(b.skuFamily ?? "~") ||
      a.tea.localeCompare(b.tea) ||
      a.sku.localeCompare(b.sku) ||
      a.channel.localeCompare(b.channel) ||
      a.variant.localeCompare(b.variant),
  );

  const teaBagRows: TeaBagCountRow[] = [...teaBags.values()].map((acc) => {
    const byChannel: Record<string, number> = {};
    let totalTeaBags = 0;
    for (const channel of channelList) {
      const count = acc.byChannel.get(channel) ?? 0;
      byChannel[channel] = count;
      totalTeaBags += count;
    }
    return {
      sku: acc.sku,
      gift: acc.recipe.gift,
      teaBagsPerUnit: acc.recipe.teaBagsPerUnit,
      byChannel,
      totalTeaBags,
    };
  });
  teaBagRows.sort((a, b) => b.totalTeaBags - a.totalTeaBags);

  const unmappedRows = [...unmapped.values()].sort(
    (a, b) => b.units - a.units || a.sku.localeCompare(b.sku),
  );
  const totalGrams = rows.reduce((sum, row) => sum + row.totalGrams, 0);
  const totalTeaBags = teaBagRows.reduce(
    (sum, row) => sum + row.totalTeaBags,
    0,
  );

  return {
    range,
    channels: channelList,
    rows,
    skuRows,
    teaBagRows,
    unmapped: unmappedRows,
    totalGrams,
    totalKilograms: totalGrams / 1_000,
    totalTeaBags,
  };
}
