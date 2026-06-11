import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import { buildAuthorizeUrl, revokeAccess } from "./oauth";
import { getSquareConnection } from "./client";

// Shared action for the Square connect/disconnect intents, used by both the
// dashboard and Settings so each page can host the buttons without
// duplicating the OAuth/revoke logic.
export async function squareConnectionAction({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "connect") {
    return { authorizeUrl: buildAuthorizeUrl(session.shop) };
  }

  if (intent === "disconnect") {
    const connection = await getSquareConnection(session.shop);
    if (connection) {
      try {
        await revokeAccess(connection.merchantId);
      } catch (error) {
        // Revoke failing (network, already revoked) shouldn't strand the
        // merchant with a connection row they can't remove.
        console.error("Square revoke failed", error);
      }
      await prisma.squareConnection.delete({ where: { shop: session.shop } });
    }
    return { disconnected: true as const };
  }

  return { ok: false as const };
}

export type SquareConnectionActionData = Awaited<
  ReturnType<typeof squareConnectionAction>
>;
