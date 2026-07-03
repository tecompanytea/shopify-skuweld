import { squareFetch } from "./client";

interface BatchRetrieveCountsResponse {
  cursor?: string;
  counts?: Array<{
    catalog_object_id?: string;
    state?: string;
    quantity?: string;
  }>;
}

const CHUNK_SIZE = 250;

// Returns total IN_STOCK quantity per variation id, summed across locations.
// (Per-location breakdown is a future feature; the API already returns
// location_id per count when we need it.)
export async function getInventoryCounts(
  shop: string,
  variationIds: string[],
): Promise<Map<string, number>> {
  const totals = new Map<string, number>();

  const chunks: string[][] = [];
  for (let i = 0; i < variationIds.length; i += CHUNK_SIZE) {
    chunks.push(variationIds.slice(i, i + CHUNK_SIZE));
  }
  // Chunks are independent — fetch them concurrently; only each chunk's
  // cursor pages are serial.
  await Promise.all(
    chunks.map(async (chunk) => {
      let cursor: string | undefined;
      do {
        const data = await squareFetch<BatchRetrieveCountsResponse>(
          shop,
          "/v2/inventory/counts/batch-retrieve",
          {
            method: "POST",
            body: JSON.stringify({
              catalog_object_ids: chunk,
              ...(cursor ? { cursor } : {}),
            }),
          },
        );

        for (const count of data.counts ?? []) {
          if (count.state !== "IN_STOCK" || !count.catalog_object_id) continue;
          const quantity = Number(count.quantity ?? "0");
          if (!Number.isFinite(quantity)) continue;
          totals.set(
            count.catalog_object_id,
            (totals.get(count.catalog_object_id) ?? 0) + quantity,
          );
        }
        cursor = data.cursor;
      } while (cursor);
    }),
  );

  return totals;
}
