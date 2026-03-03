-- DropEnum
DROP TYPE IF EXISTS "SymbolPosition";

-- AlterTable: remove invoiceDisclaimer
ALTER TABLE "InvoiceRevision" DROP COLUMN IF EXISTS "invoiceDisclaimer";

-- Create trigger function: auto-set timestamp when PDF columns change,
-- and reject direct modification of the timestamp columns.
CREATE OR REPLACE FUNCTION update_generated_invoice_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Reject direct modification of timestamp columns without a PDF change
    IF OLD."generatedInvoiceUpdatedAt" IS DISTINCT FROM NEW."generatedInvoiceUpdatedAt"
       AND OLD."generatedPDFInvoice" IS NOT DISTINCT FROM NEW."generatedPDFInvoice" THEN
      RAISE EXCEPTION 'generatedInvoiceUpdatedAt cannot be modified directly; update generatedPDFInvoice instead';
    END IF;
    IF OLD."generatedCancelledInvoiceUpdatedAt" IS DISTINCT FROM NEW."generatedCancelledInvoiceUpdatedAt"
       AND OLD."generatedCancelledInvoice" IS NOT DISTINCT FROM NEW."generatedCancelledInvoice" THEN
      RAISE EXCEPTION 'generatedCancelledInvoiceUpdatedAt cannot be modified directly; update generatedCancelledInvoice instead';
    END IF;

    -- Auto-set timestamps when PDF columns change
    IF OLD."generatedPDFInvoice" IS DISTINCT FROM NEW."generatedPDFInvoice" THEN
      NEW."generatedInvoiceUpdatedAt" = NOW();
    END IF;
    IF OLD."generatedCancelledInvoice" IS DISTINCT FROM NEW."generatedCancelledInvoice" THEN
      NEW."generatedCancelledInvoiceUpdatedAt" = NOW();
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Set timestamps if the PDF data is non-empty
    IF NEW."generatedPDFInvoice" IS NOT NULL AND length(NEW."generatedPDFInvoice") > 0 THEN
      NEW."generatedInvoiceUpdatedAt" = NOW();
    END IF;
    IF NEW."generatedCancelledInvoice" IS NOT NULL AND length(NEW."generatedCancelledInvoice") > 0 THEN
      NEW."generatedCancelledInvoiceUpdatedAt" = NOW();
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger on InvoiceRevision for both INSERT and UPDATE
CREATE TRIGGER trg_invoice_revision_pdf_timestamp
  BEFORE INSERT OR UPDATE ON "InvoiceRevision"
  FOR EACH ROW
  EXECUTE FUNCTION update_generated_invoice_timestamp();
