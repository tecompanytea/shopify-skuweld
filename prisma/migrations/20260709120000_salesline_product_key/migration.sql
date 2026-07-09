-- Stable product identity on the fact table. `itemName` is the order line's
-- snapshot name (renamed buttons produce several names for one product), and
-- the 4-digit SKU family is not a product — Square packs several distinct
-- items into one family (2502 = Sweet Potato + Mung bean sesame cake). The
-- catalog item / Shopify product is the real product, and its variations are
-- the sizes. Nullable + additive: existing rows read as null until backfilled.
ALTER TABLE "SalesLine" ADD COLUMN "productKey" TEXT;
ALTER TABLE "SalesLine" ADD COLUMN "productTitle" TEXT;

CREATE INDEX "SalesLine_shop_productKey_idx" ON "SalesLine"("shop", "productKey");
