import type { ActionFunctionArgs } from "react-router";

import { getShopifyProductForSquare } from "../.server/shopify/product-for-square";
import {
  applyPublishOverrides,
  buildPublishPreview,
  normalizePublishOverrides,
} from "../.server/square/publish";
import {
  getSquareConnection,
  hasSquareScopes,
  SquareNotConnectedError,
} from "../.server/square/client";
import { authenticate } from "../shopify.server";

const PUBLISH_SCOPES = ["ITEMS_WRITE"] as const;

function jsonError(message: string, status: number, code = "ERROR") {
  return Response.json({ code, message }, { status });
}

async function requestInput(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    productId?: unknown;
    overrides?: unknown;
  } | null;
  return {
    productId:
      typeof body?.productId === "string" && body.productId.trim()
        ? body.productId
        : null,
    overrides: normalizePublishOverrides(body?.overrides),
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const input = await requestInput(request);
  if (!input.productId) {
    return jsonError("Product ID is required", 400, "MISSING_PRODUCT_ID");
  }

  try {
    const connection = await getSquareConnection(session.shop);
    if (!connection) {
      return jsonError(
        "Square is not connected. Connect Square in Settings first.",
        409,
        "SQUARE_NOT_CONNECTED",
      );
    }

    const product = applyPublishOverrides(
      await getShopifyProductForSquare(admin, input.productId),
      input.overrides,
    );
    const preview = await buildPublishPreview(session.shop, product);
    const canWrite = hasSquareScopes(connection.scopes, PUBLISH_SCOPES);
    const blockers = canWrite
      ? preview.blockers
      : [
          ...preview.blockers,
          "Reconnect Square in Settings to grant catalog write access.",
        ];

    return Response.json({
      ...preview,
      blockers,
      square: { canWrite },
    });
  } catch (error) {
    if (error instanceof SquareNotConnectedError) {
      return jsonError(error.message, 409, "SQUARE_NOT_CONNECTED");
    }
    if (error instanceof Response) {
      return jsonError(await error.text(), error.status);
    }
    console.error("Publish on Square preview failed", error);
    return jsonError(
      error instanceof Error ? error.message : "Preview failed",
      500,
    );
  }
};
