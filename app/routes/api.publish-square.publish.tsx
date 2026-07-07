import type { ActionFunctionArgs } from "react-router";

import { getShopifyProductForSquare } from "../.server/shopify/product-for-square";
import {
  getSquareConnection,
  hasSquareScopes,
  SquareNotConnectedError,
} from "../.server/square/client";
import {
  applyPublishOverrides,
  normalizePublishOverrides,
  publishProductToSquare,
} from "../.server/square/publish";
import { authenticate } from "../shopify.server";

const PUBLISH_SCOPES = ["ITEMS_WRITE"] as const;

interface PublishBody {
  productId?: unknown;
  categoryId?: unknown;
  createCategoryName?: unknown;
  overrides?: unknown;
}

function jsonError(message: string, status: number, code = "ERROR") {
  return Response.json({ code, message }, { status });
}

async function requestBody(request: Request) {
  const body = (await request.json().catch(() => null)) as PublishBody | null;
  return {
    productId:
      typeof body?.productId === "string" && body.productId.trim()
        ? body.productId
        : null,
    categoryId:
      typeof body?.categoryId === "string" && body.categoryId.trim()
        ? body.categoryId
        : null,
    createCategoryName:
      typeof body?.createCategoryName === "string" &&
      body.createCategoryName.trim()
        ? body.createCategoryName
        : null,
    overrides: normalizePublishOverrides(body?.overrides),
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const body = await requestBody(request);
  if (!body.productId) {
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
    if (!hasSquareScopes(connection.scopes, PUBLISH_SCOPES)) {
      return jsonError(
        "Reconnect Square in Settings to grant catalog write access.",
        403,
        "SQUARE_RECONNECT_REQUIRED",
      );
    }

    const product = applyPublishOverrides(
      await getShopifyProductForSquare(admin, body.productId),
      body.overrides,
    );
    const result = await publishProductToSquare(session.shop, product, {
      categoryId: body.categoryId,
      createCategoryName: body.createCategoryName,
      uploadImage: body.overrides.uploadImage,
    });

    return Response.json({ result });
  } catch (error) {
    if (error instanceof SquareNotConnectedError) {
      return jsonError(error.message, 409, "SQUARE_NOT_CONNECTED");
    }
    if (error instanceof Response) {
      return jsonError(await error.text(), error.status);
    }
    console.error("Publish on Square failed", error);
    return jsonError(
      error instanceof Error ? error.message : "Publish failed",
      500,
    );
  }
};
