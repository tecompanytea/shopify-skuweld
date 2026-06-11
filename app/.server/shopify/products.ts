// One row per product variant — the level at which SKUs live in Shopify.
export interface ShopifyProductRow {
  productGid: string;
  productTitle: string;
  productCreatedAt: string;
  productImageUrl: string | null;
  productType: string;
  status: string;
  variantGid: string;
  variantTitle: string;
  sku: string | null;
  inventoryQuantity: number;
}

interface ProductsQueryResult {
  data?: {
    products: {
      nodes: Array<{
        id: string;
        title: string;
        createdAt: string;
        featuredMedia: {
          preview: { image: { url: string } | null } | null;
        } | null;
        productType: string;
        status: string;
        variants: {
          nodes: Array<{
            id: string;
            title: string;
            sku: string | null;
            inventoryQuantity: number | null;
          }>;
        };
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

// AdminApiContext from authenticate.admin(request); typed structurally so
// server modules don't import route-level types.
interface AdminClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

const PRODUCTS_QUERY = `#graphql
  query SkuweldProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: TITLE) {
      nodes {
        id
        title
        createdAt
        featuredMedia {
          preview {
            image {
              url(transform: { maxWidth: 120, maxHeight: 120 })
            }
          }
        }
        productType
        status
        variants(first: 100) {
          nodes {
            id
            title
            sku
            inventoryQuantity
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export async function listShopifyProducts(
  admin: AdminClient,
): Promise<ShopifyProductRow[]> {
  const rows: ShopifyProductRow[] = [];
  let after: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(PRODUCTS_QUERY, {
      variables: { first: 50, after },
    });
    const json = (await response.json()) as ProductsQueryResult;
    const products = json.data?.products;
    if (!products) break;

    for (const product of products.nodes) {
      for (const variant of product.variants.nodes) {
        rows.push({
          productGid: product.id,
          productTitle: product.title,
          productCreatedAt: product.createdAt,
          productImageUrl: product.featuredMedia?.preview?.image?.url ?? null,
          productType: product.productType,
          status: product.status,
          variantGid: variant.id,
          variantTitle: variant.title,
          sku: variant.sku,
          inventoryQuantity: variant.inventoryQuantity ?? 0,
        });
      }
    }

    hasNextPage = products.pageInfo.hasNextPage;
    after = products.pageInfo.endCursor;
  }

  return rows;
}
