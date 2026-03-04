-- Keep "nextActionOrOnChainStateOrResultLastChangedAt" columns in sync by bumping them when the
-- combined state of a request may have changed.
--
-- The combined state depends on:
-- - "nextActionLastChangedAt" (last action change)
-- - "onChainStateOrResultLastChangedAt" (last on-chain state OR resultHash change)
--
-- We intentionally do NOT use "updatedAt" here.

-- PaymentRequest: bump combined when either "nextActionLastChangedAt" or "onChainStateOrResultLastChangedAt" changes
DROP TRIGGER IF EXISTS "trg_PaymentRequest_nextActionOrOnChainStateOrResultLastChangedAt" ON "PaymentRequest";
DROP FUNCTION IF EXISTS "fn_PaymentRequest_nextActionOrOnChainStateOrResultLastChangedAt"();
CREATE FUNCTION "fn_PaymentRequest_nextActionOrOnChainStateOrResultLastChangedAt"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."nextActionLastChangedAt" IS DISTINCT FROM OLD."nextActionLastChangedAt"
     OR NEW."onChainStateOrResultLastChangedAt" IS DISTINCT FROM OLD."onChainStateOrResultLastChangedAt" THEN
    NEW."nextActionOrOnChainStateOrResultLastChangedAt" = CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "trg_PaymentRequest_nextActionOrOnChainStateOrResultLastChangedAt"
BEFORE UPDATE ON "PaymentRequest"
FOR EACH ROW
EXECUTE FUNCTION "fn_PaymentRequest_nextActionOrOnChainStateOrResultLastChangedAt"();

-- PurchaseRequest: bump combined when either "nextActionLastChangedAt" or "onChainStateOrResultLastChangedAt" changes
DROP TRIGGER IF EXISTS "trg_PurchaseRequest_nextActionOrOnChainStateOrResultLastChangedAt" ON "PurchaseRequest";
DROP FUNCTION IF EXISTS "fn_PurchaseRequest_nextActionOrOnChainStateOrResultLastChangedAt"();
CREATE FUNCTION "fn_PurchaseRequest_nextActionOrOnChainStateOrResultLastChangedAt"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."nextActionLastChangedAt" IS DISTINCT FROM OLD."nextActionLastChangedAt"
     OR NEW."onChainStateOrResultLastChangedAt" IS DISTINCT FROM OLD."onChainStateOrResultLastChangedAt" THEN
    NEW."nextActionOrOnChainStateOrResultLastChangedAt" = CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "trg_PurchaseRequest_nextActionOrOnChainStateOrResultLastChangedAt"
BEFORE UPDATE ON "PurchaseRequest"
FOR EACH ROW
EXECUTE FUNCTION "fn_PurchaseRequest_nextActionOrOnChainStateOrResultLastChangedAt"();