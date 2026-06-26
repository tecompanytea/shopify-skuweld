-- Adds the per-source incremental high-water mark. Nullable + additive: no
-- data change, backward-compatible (existing code ignores the column).
ALTER TABLE "SyncState" ADD COLUMN "watermark" TIMESTAMP(3);
