-- CreateTable
CREATE TABLE "SalesLine" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "day" TEXT NOT NULL,
    "sku" TEXT,
    "itemName" TEXT NOT NULL,
    "variationName" TEXT,
    "category" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "grossCents" INTEGER NOT NULL,
    "discountCents" INTEGER NOT NULL,
    "netCents" INTEGER NOT NULL,
    "taxCents" INTEGER NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "progress" TEXT,
    "error" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalesLine_shop_day_idx" ON "SalesLine"("shop", "day");

-- CreateIndex
CREATE INDEX "SalesLine_shop_channel_day_idx" ON "SalesLine"("shop", "channel", "day");

-- CreateIndex
CREATE INDEX "SalesLine_shop_category_day_idx" ON "SalesLine"("shop", "category", "day");
