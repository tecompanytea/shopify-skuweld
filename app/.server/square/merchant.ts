import { squareFetch } from "./client";

interface MerchantResponse {
  merchant?: {
    id: string;
    business_name?: string;
    main_location_id?: string;
  };
}

export interface SquareMerchant {
  merchantId: string;
  businessName: string | null;
  mainLocationId: string | null;
}

export async function getMerchant(shop: string): Promise<SquareMerchant> {
  const data = await squareFetch<MerchantResponse>(shop, "/v2/merchants/me");
  return {
    merchantId: data.merchant?.id ?? "",
    businessName: data.merchant?.business_name ?? null,
    mainLocationId: data.merchant?.main_location_id ?? null,
  };
}

interface LocationsResponse {
  locations?: Array<{
    id: string;
    name?: string;
    status?: string;
  }>;
}

export interface SquareLocation {
  id: string;
  name: string;
  status: string;
}

export async function listLocations(shop: string): Promise<SquareLocation[]> {
  const data = await squareFetch<LocationsResponse>(shop, "/v2/locations");
  return (data.locations ?? []).map((location) => ({
    id: location.id,
    name: location.name ?? location.id,
    status: location.status ?? "UNKNOWN",
  }));
}
