-- An operator can acknowledge a row in Needs Action to hide it from that view.
-- The acknowledgement lives on the current action-data row, so a new action row starts unacknowledged.
ALTER TABLE "PaymentActionData" ADD COLUMN "manualActionAcknowledgedAt" TIMESTAMP(3);
ALTER TABLE "PurchaseActionData" ADD COLUMN "manualActionAcknowledgedAt" TIMESTAMP(3);

-- Errors are also written in place on the same action-data row. Reset the acknowledgement
-- whenever the action or the error changes, so a new error shows up in Needs Action again.
CREATE OR REPLACE FUNCTION "fn_PaymentActionData_nextActionLastChangedAt"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."requestedAction" IS DISTINCT FROM OLD."requestedAction"
     OR NEW."errorType" IS DISTINCT FROM OLD."errorType"
     OR NEW."errorNote" IS DISTINCT FROM OLD."errorNote" THEN
    -- PaymentRequest holds the FK (`nextActionId`) referencing PaymentActionData.id, so bump the parent's timestamp.
    UPDATE "PaymentRequest"
    SET "nextActionLastChangedAt" = CURRENT_TIMESTAMP
    WHERE "nextActionId" = NEW."id";
    NEW."manualActionAcknowledgedAt" = NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "fn_PurchaseActionData_nextActionLastChangedAt"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."requestedAction" IS DISTINCT FROM OLD."requestedAction"
     OR NEW."errorType" IS DISTINCT FROM OLD."errorType"
     OR NEW."errorNote" IS DISTINCT FROM OLD."errorNote" THEN
    -- PurchaseRequest holds the FK (`nextActionId`) referencing PurchaseActionData.id, so bump the parent's timestamp.
    UPDATE "PurchaseRequest"
    SET "nextActionLastChangedAt" = CURRENT_TIMESTAMP
    WHERE "nextActionId" = NEW."id";
    NEW."manualActionAcknowledgedAt" = NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
