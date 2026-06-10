import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { exchangeCode, verifyState } from "../.server/square/oauth";
import { persistTokens } from "../.server/square/client";
import { getMerchant } from "../.server/square/merchant";
import prisma from "../db.server";

// Public, non-embedded route: Square redirects here top-level after the
// merchant approves (or denies) access on the consent page. We then send
// the browser back into the embedded app inside the Shopify admin.
function settingsUrl(shop: string, params: Record<string, string> = {}) {
  const storeHandle = shop.replace(/\.myshopify\.com$/i, "");
  const appHandle = process.env.SHOPIFY_APP_HANDLE || "skuweld";
  const search = new URLSearchParams(params).toString();
  return (
    `https://admin.shopify.com/store/${encodeURIComponent(storeHandle)}` +
    `/apps/${encodeURIComponent(appHandle)}/app/settings` +
    (search ? `?${search}` : "")
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  const verified = state ? verifyState(state) : null;
  if (!verified) {
    throw new Response("Invalid or expired state parameter", { status: 400 });
  }
  const { shop } = verified;

  if (error || !code) {
    return redirect(
      settingsUrl(shop, { square: error === "access_denied" ? "denied" : "error" }),
    );
  }

  const tokens = await exchangeCode(code);
  await persistTokens(shop, tokens);

  // Enrich the connection with merchant profile data; non-fatal if it fails.
  try {
    const merchant = await getMerchant(shop);
    await prisma.squareConnection.update({
      where: { shop },
      data: {
        merchantName: merchant.businessName,
        mainLocationId: merchant.mainLocationId,
      },
    });
  } catch (enrichError) {
    console.error("Failed to fetch Square merchant profile", enrichError);
  }

  return redirect(settingsUrl(shop, { square: "connected" }));
};
