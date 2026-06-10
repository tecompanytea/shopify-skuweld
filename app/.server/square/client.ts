import type { SquareConnection } from "@prisma/client";
import prisma from "../../db.server";
import { decryptToken, encryptToken } from "./crypto";
import {
  SQUARE_BASE_URL,
  refreshAccessToken,
  type SquareTokenResponse,
} from "./oauth";

// Refresh-on-use window: Square access tokens live ~30 days; refresh whenever
// we're within 7 days of expiry so a token can never go stale between visits.
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export class SquareNotConnectedError extends Error {
  constructor(message = "Square is not connected for this shop") {
    super(message);
    this.name = "SquareNotConnectedError";
  }
}

export class SquareApiError extends Error {
  status: number;
  errors: unknown;

  constructor(status: number, errors: unknown) {
    super(`Square API error (${status}): ${JSON.stringify(errors)}`);
    this.name = "SquareApiError";
    this.status = status;
    this.errors = errors;
  }
}

export function getSquareConnection(shop: string) {
  return prisma.squareConnection.findUnique({ where: { shop } });
}

export async function persistTokens(
  shop: string,
  tokens: SquareTokenResponse,
  extra: { merchantName?: string | null; mainLocationId?: string | null } = {},
): Promise<SquareConnection> {
  const data = {
    merchantId: tokens.merchant_id,
    accessToken: encryptToken(tokens.access_token),
    refreshToken: encryptToken(tokens.refresh_token),
    expiresAt: new Date(tokens.expires_at),
    scopes: "ITEMS_READ INVENTORY_READ MERCHANT_PROFILE_READ",
    ...extra,
  };
  return prisma.squareConnection.upsert({
    where: { shop },
    create: { shop, ...data },
    update: data,
  });
}

async function refreshConnection(
  connection: SquareConnection,
): Promise<SquareConnection> {
  const tokens = await refreshAccessToken(decryptToken(connection.refreshToken));
  return persistTokens(connection.shop, tokens);
}

export async function getSquareAccessToken(shop: string): Promise<string> {
  let connection = await getSquareConnection(shop);
  if (!connection) throw new SquareNotConnectedError();

  if (connection.expiresAt.getTime() < Date.now() + REFRESH_WINDOW_MS) {
    connection = await refreshConnection(connection);
  }
  return decryptToken(connection.accessToken);
}

function defaultHeaders(accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  // Optional pin; when unset, Square uses the app's dashboard API version.
  if (process.env.SQUARE_API_VERSION) {
    headers["Square-Version"] = process.env.SQUARE_API_VERSION;
  }
  return headers;
}

export async function squareFetch<T>(
  shop: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const accessToken = await getSquareAccessToken(shop);

  const doFetch = (token: string) =>
    fetch(`${SQUARE_BASE_URL}${path}`, {
      ...init,
      headers: { ...defaultHeaders(token), ...init.headers },
    });

  let response = await doFetch(accessToken);

  // A 401 with an unexpired-looking token means it was revoked or rotated
  // out from under us — force one refresh and retry before giving up.
  if (response.status === 401) {
    const connection = await getSquareConnection(shop);
    if (!connection) throw new SquareNotConnectedError();
    try {
      const refreshed = await refreshConnection(connection);
      response = await doFetch(decryptToken(refreshed.accessToken));
    } catch {
      throw new SquareNotConnectedError(
        "Square rejected our credentials — please reconnect Square",
      );
    }
  }

  if (!response.ok) {
    let errors: unknown;
    try {
      errors = (await response.json()) as { errors?: unknown };
    } catch {
      errors = await response.text();
    }
    if (response.status === 401) {
      throw new SquareNotConnectedError(
        "Square rejected our credentials — please reconnect Square",
      );
    }
    throw new SquareApiError(response.status, errors);
  }

  return (await response.json()) as T;
}
