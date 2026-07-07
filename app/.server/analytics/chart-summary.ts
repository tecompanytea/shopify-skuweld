import prisma from "../../db.server";
import {
  comparisonRange,
  dayInRange,
  shiftDay,
  type ComparisonMode,
  type DayRange,
} from "../../lib/periods";
import { productName } from "../../lib/sku-scheme";

export interface MetricValue {
  ty: number;
  ly: number;
  changePct: number | null;
}

export interface ChartPoint {
  day: string;
  comparisonDay: string;
  label: string;
  ty: number;
  ly: number;
}

export interface ChannelChartRow extends MetricValue {
  channel: string;
  label: string;
}

export interface ProductChartRow extends MetricValue {
  name: string;
  category: string | null;
}

export interface AnalyticsChartSummary {
  range: DayRange;
  comparisonRange: DayRange;
  totalSales: MetricValue;
  averageOrderValue: MetricValue;
  salesOverTime: ChartPoint[];
  averageOrderValueOverTime: ChartPoint[];
  salesByChannel: ChannelChartRow[];
  topProducts: ProductChartRow[];
}

interface SalesLineForCharts {
  day: string;
  source: string;
  channel: string;
  kind: string;
  orderId: string;
  itemName: string;
  variationName: string | null;
  category: string | null;
  netCents: number;
}

interface ProductAccumulator {
  name: string;
  category: string | null;
  net: number;
}

interface WindowAccumulator {
  days: string[];
  netByDay: Map<string, number>;
  aovByDay: Map<string, number>;
  netByChannel: Map<string, number>;
  netByProduct: Map<string, ProductAccumulator>;
  totalNet: number;
  averageOrderValue: number;
}

const CHANNEL_LABELS: Record<string, string> = {
  ECOM: "Online Store",
  WV: "West Village",
  EV: "East Village",
  INVOICED: "Invoiced",
};

const TOP_PRODUCT_LIMIT = 4;

function percentChange(ty: number, ly: number): number | null {
  if (ly === 0) return null;
  return (ty - ly) / Math.abs(ly);
}

function metric(ty: number, ly: number): MetricValue {
  return { ty, ly, changePct: percentChange(ty, ly) };
}

function daysInRange(range: DayRange): string[] {
  const days: string[] = [];
  for (let day = range.start; day <= range.end; day = shiftDay(day, 1)) {
    days.push(day);
  }
  return days;
}

function shortDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function average(values: Iterable<number>, count: number): number {
  if (count === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / count;
}

function aggregateWindow(
  rows: SalesLineForCharts[],
  range: DayRange,
): WindowAccumulator {
  const days = daysInRange(range);
  const netByDay = new Map(days.map((day) => [day, 0]));
  const saleOrderNetByDay = new Map<string, Map<string, number>>();
  const saleOrderNet = new Map<string, number>();
  const netByChannel = new Map<string, number>();
  const netByProduct = new Map<string, ProductAccumulator>();

  for (const row of rows) {
    if (!dayInRange(row.day, range)) continue;

    netByDay.set(row.day, (netByDay.get(row.day) ?? 0) + row.netCents);
    netByChannel.set(
      row.channel,
      (netByChannel.get(row.channel) ?? 0) + row.netCents,
    );

    const name = productName(row.itemName, row.variationName);
    const productKey = name.trim().toLowerCase();
    const product = netByProduct.get(productKey) ?? {
      name,
      category: row.category,
      net: 0,
    };
    product.net += row.netCents;
    if (!product.category && row.category) product.category = row.category;
    netByProduct.set(productKey, product);

    // AOV is order-level, so multiple lines on the same order count once.
    // Return rows are not new orders; they affect net-sales charts, not order
    // counts for AOV.
    if (row.kind === "sale") {
      const orderKey = `${row.source}:${row.orderId}`;
      let dayOrders = saleOrderNetByDay.get(row.day);
      if (!dayOrders) {
        dayOrders = new Map();
        saleOrderNetByDay.set(row.day, dayOrders);
      }
      dayOrders.set(orderKey, (dayOrders.get(orderKey) ?? 0) + row.netCents);
      saleOrderNet.set(
        orderKey,
        (saleOrderNet.get(orderKey) ?? 0) + row.netCents,
      );
    }
  }

  const aovByDay = new Map(
    days.map((day) => {
      const orders = saleOrderNetByDay.get(day);
      return [day, orders ? average(orders.values(), orders.size) : 0];
    }),
  );

  return {
    days,
    netByDay,
    aovByDay,
    netByChannel,
    netByProduct,
    totalNet: [...netByDay.values()].reduce((sum, value) => sum + value, 0),
    averageOrderValue: average(saleOrderNet.values(), saleOrderNet.size),
  };
}

function alignedPoints(
  ty: WindowAccumulator,
  ly: WindowAccumulator,
  valueFor: (window: WindowAccumulator, day: string) => number,
): ChartPoint[] {
  return ty.days.map((day, index) => {
    const comparisonDay = ly.days[index] ?? ly.days[ly.days.length - 1] ?? day;
    return {
      day,
      comparisonDay,
      label: shortDay(day),
      ty: valueFor(ty, day),
      ly: valueFor(ly, comparisonDay),
    };
  });
}

export async function computeAnalyticsChartSummary(
  shop: string,
  range: DayRange,
  compare: ComparisonMode,
): Promise<AnalyticsChartSummary> {
  const lyRange = comparisonRange(compare, range);
  const rows = await prisma.salesLine.findMany({
    where: {
      shop,
      OR: [
        { day: { gte: range.start, lte: range.end } },
        { day: { gte: lyRange.start, lte: lyRange.end } },
      ],
    },
    select: {
      day: true,
      source: true,
      channel: true,
      kind: true,
      orderId: true,
      itemName: true,
      variationName: true,
      category: true,
      netCents: true,
    },
  });

  const ty = aggregateWindow(rows, range);
  const ly = aggregateWindow(rows, lyRange);

  const salesByChannel = [...ty.netByChannel.entries()]
    .map(([channel, tyNet]) => {
      const lyNet = ly.netByChannel.get(channel) ?? 0;
      return {
        channel,
        label: CHANNEL_LABELS[channel] ?? channel,
        ...metric(tyNet, lyNet),
      };
    })
    .sort((a, b) => b.ty - a.ty);

  const topProducts = [...ty.netByProduct.entries()]
    .sort(([, a], [, b]) => b.net - a.net)
    .slice(0, TOP_PRODUCT_LIMIT)
    .map(([key, product]) => {
      const lyNet = ly.netByProduct.get(key)?.net ?? 0;
      return {
        name: product.name,
        category: product.category,
        ...metric(product.net, lyNet),
      };
    });

  return {
    range,
    comparisonRange: lyRange,
    totalSales: metric(ty.totalNet, ly.totalNet),
    averageOrderValue: metric(ty.averageOrderValue, ly.averageOrderValue),
    salesOverTime: alignedPoints(
      ty,
      ly,
      (window, day) => window.netByDay.get(day) ?? 0,
    ),
    averageOrderValueOverTime: alignedPoints(
      ty,
      ly,
      (window, day) => window.aovByDay.get(day) ?? 0,
    ),
    salesByChannel,
    topProducts,
  };
}
