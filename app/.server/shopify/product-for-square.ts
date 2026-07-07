export interface ShopifyVariantForSquare {
  id: string;
  title: string;
  sku: string | null;
  price: string;
}

export interface ShopifyProductForSquare {
  id: string;
  title: string;
  description: string | null;
  productType: string;
  status: string;
  currencyCode: string;
  featuredImageUrl: string | null;
  chineseName: string | null;
  flavorNotes: string | null;
  variants: ShopifyVariantForSquare[];
}

interface ProductForSquareQueryResult {
  data?: {
    shop: { currencyCode: string };
    product: {
      id: string;
      title: string;
      description: string | null;
      productType: string;
      status: string;
      featuredMedia: {
        preview: { image: { url: string } | null } | null;
      } | null;
      chineseName: { value: string } | null;
      flavorNotes: { value: string } | null;
      variants: {
        nodes: ShopifyVariantForSquare[];
        pageInfo: { hasNextPage: boolean };
      };
    } | null;
  };
  errors?: Array<{ message: string }>;
}

interface AdminClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

const PRODUCT_FOR_SQUARE_QUERY = `#graphql
  query ProductForSquare($id: ID!) {
    shop {
      currencyCode
    }
    product(id: $id) {
      id
      title
      description
      productType
      status
      featuredMedia {
        preview {
          image {
            url(transform: { maxWidth: 1200, maxHeight: 1200 })
          }
        }
      }
      chineseName: metafield(namespace: "custom", key: "chinese_name") {
        value
      }
      flavorNotes: metafield(namespace: "custom", key: "product_flavor") {
        value
      }
      variants(first: 250) {
        nodes {
          id
          title
          sku
          price
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }
`;

function productGid(id: string): string {
  const trimmed = id.trim();
  if (/^\d+$/.test(trimmed)) return `gid://shopify/Product/${trimmed}`;
  return trimmed;
}

export async function getShopifyProductForSquare(
  admin: AdminClient,
  productId: string,
): Promise<ShopifyProductForSquare> {
  const response = await admin.graphql(PRODUCT_FOR_SQUARE_QUERY, {
    variables: { id: productGid(productId) },
  });
  if (!response.ok) {
    throw new Error(`Shopify product lookup failed (${response.status})`);
  }

  const json = (await response.json()) as ProductForSquareQueryResult;
  if (json.errors?.length) {
    throw new Error(
      `Shopify product lookup failed: ${json.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }

  const product = json.data?.product;
  if (!product) {
    throw new Response("Product not found", { status: 404 });
  }
  if (product.variants.pageInfo.hasNextPage) {
    throw new Response("Square items support up to 250 variations", {
      status: 422,
    });
  }

  return {
    id: product.id,
    title: product.title,
    description: product.description ?? null,
    productType: product.productType,
    status: product.status,
    currencyCode: json.data?.shop.currencyCode ?? "USD",
    featuredImageUrl: product.featuredMedia?.preview?.image?.url ?? null,
    chineseName: product.chineseName?.value ?? null,
    flavorNotes: product.flavorNotes?.value ?? null,
    variants: product.variants.nodes,
  };
}
