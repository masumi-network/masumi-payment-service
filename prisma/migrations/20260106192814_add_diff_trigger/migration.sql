
-- Keep "*LastChangedAt" columns in sync by updating them only when the tracked field(s) change.
-- Uses Postgres `IS DISTINCT FROM` to correctly handle NULL comparisons.

-- PaymentActionData: bump when requestedAction changes
DROP TRIGGER IF EXISTS "trg_PaymentActionData_nextActionLastChangedAt" ON "PaymentActionData";
DROP FUNCTION IF EXISTS "fn_PaymentActionData_nextActionLastChangedAt"();
CREATE FUNCTION "fn_PaymentActionData_nextActionLastChangedAt"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."requestedAction" IS DISTINCT FROM OLD."requestedAction"
     OR NEW."errorType" IS DISTINCT FROM OLD."errorType"
     OR NEW."errorNote" IS DISTINCT FROM OLD."errorNote" THEN
    -- PaymentRequest holds the FK (`nextActionId`) referencing PaymentActionData.id, so bump the parent's timestamp.
    UPDATE "PaymentRequest"
    SET "nextActionLastChangedAt" = CURRENT_TIMESTAMP
    WHERE "nextActionId" = NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "trg_PaymentActionData_nextActionLastChangedAt"
BEFORE UPDATE ON "PaymentActionData"
FOR EACH ROW
EXECUTE FUNCTION "fn_PaymentActionData_nextActionLastChangedAt"();

-- PurchaseActionData: bump when requestedAction changes
DROP TRIGGER IF EXISTS "trg_PurchaseActionData_nextActionLastChangedAt" ON "PurchaseActionData";
DROP FUNCTION IF EXISTS "fn_PurchaseActionData_nextActionLastChangedAt"();
CREATE FUNCTION "fn_PurchaseActionData_nextActionLastChangedAt"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."requestedAction" IS DISTINCT FROM OLD."requestedAction"
     OR NEW."errorType" IS DISTINCT FROM OLD."errorType"
     OR NEW."errorNote" IS DISTINCT FROM OLD."errorNote" THEN
    -- PurchaseRequest holds the FK (`nextActionId`) referencing PurchaseActionData.id, so bump the parent's timestamp.
    UPDATE "PurchaseRequest"
    SET "nextActionLastChangedAt" = CURRENT_TIMESTAMP
    WHERE "nextActionId" = NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "trg_PurchaseActionData_nextActionLastChangedAt"
BEFORE UPDATE ON "PurchaseActionData"
FOR EACH ROW
EXECUTE FUNCTION "fn_PurchaseActionData_nextActionLastChangedAt"();

-- PaymentRequest: bump when nextActionId changes
DROP TRIGGER IF EXISTS "trg_PaymentRequest_nextActionLastChangedAt" ON "PaymentRequest";
DROP FUNCTION IF EXISTS "fn_PaymentRequest_nextActionLastChangedAt"();
CREATE FUNCTION "fn_PaymentRequest_nextActionLastChangedAt"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."nextActionId" IS DISTINCT FROM OLD."nextActionId" THEN
    NEW."nextActionLastChangedAt" = CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "trg_PaymentRequest_nextActionLastChangedAt"
BEFORE UPDATE ON "PaymentRequest"
FOR EACH ROW
EXECUTE FUNCTION "fn_PaymentRequest_nextActionLastChangedAt"();

-- PaymentRequest: bump when onChainState OR resultHash changes
DROP TRIGGER IF EXISTS "trg_PaymentRequest_onChainStateOrResultLastChangedAt" ON "PaymentRequest";
DROP FUNCTION IF EXISTS "fn_PaymentRequest_onChainStateOrResultLastChangedAt"();
CREATE FUNCTION "fn_PaymentRequest_onChainStateOrResultLastChangedAt"()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW."onChainState" IS DISTINCT FROM OLD."onChainState")
     OR (NEW."resultHash" IS DISTINCT FROM OLD."resultHash") THEN
    NEW."onChainStateOrResultLastChangedAt" = CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "trg_PaymentRequest_onChainStateOrResultLastChangedAt"
BEFORE UPDATE ON "PaymentRequest"
FOR EACH ROW
EXECUTE FUNCTION "fn_PaymentRequest_onChainStateOrResultLastChangedAt"();

-- PurchaseRequest: bump when nextActionId changes
DROP TRIGGER IF EXISTS "trg_PurchaseRequest_nextActionLastChangedAt" ON "PurchaseRequest";
DROP FUNCTION IF EXISTS "fn_PurchaseRequest_nextActionLastChangedAt"();
CREATE FUNCTION "fn_PurchaseRequest_nextActionLastChangedAt"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."nextActionId" IS DISTINCT FROM OLD."nextActionId" THEN
    NEW."nextActionLastChangedAt" = CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "trg_PurchaseRequest_nextActionLastChangedAt"
BEFORE UPDATE ON "PurchaseRequest"
FOR EACH ROW
EXECUTE FUNCTION "fn_PurchaseRequest_nextActionLastChangedAt"();

-- PurchaseRequest: bump when onChainState OR resultHash changes
DROP TRIGGER IF EXISTS "trg_PurchaseRequest_onChainStateOrResultLastChangedAt" ON "PurchaseRequest";
DROP FUNCTION IF EXISTS "fn_PurchaseRequest_onChainStateOrResultLastChangedAt"();
CREATE FUNCTION "fn_PurchaseRequest_onChainStateOrResultLastChangedAt"()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW."onChainState" IS DISTINCT FROM OLD."onChainState")
     OR (NEW."resultHash" IS DISTINCT FROM OLD."resultHash") THEN
    NEW."onChainStateOrResultLastChangedAt" = CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "trg_PurchaseRequest_onChainStateOrResultLastChangedAt"
BEFORE UPDATE ON "PurchaseRequest"
FOR EACH ROW
EXECUTE FUNCTION "fn_PurchaseRequest_onChainStateOrResultLastChangedAt"();

-- RegistryRequest: bump when state changes
DROP TRIGGER IF EXISTS "trg_RegistryRequest_registrationStateLastChangedAt" ON "RegistryRequest";
DROP FUNCTION IF EXISTS "fn_RegistryRequest_registrationStateLastChangedAt"();
CREATE FUNCTION "fn_RegistryRequest_registrationStateLastChangedAt"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."state" IS DISTINCT FROM OLD."state" or NEW."error" IS DISTINCT FROM OLD."error" THEN
    NEW."registrationStateLastChangedAt" = CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "trg_RegistryRequest_registrationStateLastChangedAt"
BEFORE UPDATE ON "RegistryRequest"
FOR EACH ROW
EXECUTE FUNCTION "fn_RegistryRequest_registrationStateLastChangedAt"();
