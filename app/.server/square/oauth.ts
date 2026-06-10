import crypto from "node:crypto";

export const SQUARE_BASE_URL = "https://connect.squareup.com";

// Read-only v1 scopes; adding write scopes later only requires extending this
// list and sending the merchant through consent again.
export const SQUARE_SCOPES = [
  "ITEMS_READ",
  "INVENTORY_READ",
  "MERCHANT_PROFILE_READ",
];

const STATE_TTL_MS = 10 * 60 * 1000;

function stateSecret(): string {
  const secret = process.env.SQUARE_STATE_SECRET;
  if (!secret) throw new Error("SQUARE_STATE_SECRET is not set");
  return secret;
}

function appCredentials() {
  const clientId = process.env.SQUARE_APPLICATION_ID;
  const clientSecret = process.env.SQUARE_APPLICATION_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("SQUARE_APPLICATION_ID / SQUARE_APPLICATION_SECRET not set");
  }
  return { clientId, clientSecret };
}

function sign(payload: string): string {
  return crypto
    .createHmac("sha256", stateSecret())
    .update(payload)
    .digest("base64url");
}

// Stateless CSRF state: base64url({shop, nonce, exp}).hmac — survives the
// top-level breakout from the Shopify admin iframe without cookies.
export function signState(shop: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      shop,
      nonce: crypto.randomUUID(),
      exp: Date.now() + STATE_TTL_MS,
    }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyState(state: string): { shop: string } | null {
  const dotIndex = state.lastIndexOf(".");
  if (dotIndex < 0) return null;
  const payload = state.slice(0, dotIndex);
  const signature = state.slice(dotIndex + 1);
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof decoded.shop !== "string" || typeof decoded.exp !== "number") {
      return null;
    }
    if (Date.now() > decoded.exp) return null;
    return { shop: decoded.shop };
  } catch {
    return null;
  }
}

export function buildAuthorizeUrl(shop: string): string {
  const { clientId } = appCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    scope: SQUARE_SCOPES.join(" "),
    session: "false",
    state: signState(shop),
  });
  return `${SQUARE_BASE_URL}/oauth2/authorize?${params.toString()}`;
}

export interface SquareTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: string; // ISO 8601
  merchant_id: string;
}

async function tokenRequest(
  body: Record<string, string>,
): Promise<SquareTokenResponse> {
  const { clientId, clientSecret } = appCredentials();
  const response = await fetch(`${SQUARE_BASE_URL}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      ...body,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Square token request failed (${response.status}): ${text}`);
  }
  return (await response.json()) as SquareTokenResponse;
}

export function exchangeCode(code: string): Promise<SquareTokenResponse> {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.SQUARE_REDIRECT_URL || "",
  });
}

export function refreshAccessToken(
  refreshToken: string,
): Promise<SquareTokenResponse> {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

export async function revokeAccess(merchantId: string): Promise<void> {
  const { clientId, clientSecret } = appCredentials();
  const response = await fetch(`${SQUARE_BASE_URL}/oauth2/revoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Client ${clientSecret}`,
    },
    body: JSON.stringify({ client_id: clientId, merchant_id: merchantId }),
  });
  // Treat 404 (already revoked) as success; surface anything else.
  if (!response.ok && response.status !== 404) {
    const text = await response.text();
    throw new Error(`Square revoke failed (${response.status}): ${text}`);
  }
}
