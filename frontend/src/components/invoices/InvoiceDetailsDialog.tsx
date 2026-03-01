import { useState, useMemo, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { Download } from 'lucide-react';
import type { InvoiceSummary } from '@/lib/hooks/useInvoices';
import { useInvoiceRevisions } from '@/lib/hooks/useInvoices';
import { downloadBase64Pdf, base64ToPdfBlob } from '@/lib/pdf-utils';

interface InvoiceDetailsDialogProps {
  selectedInvoice: InvoiceSummary | null;
  onClose: () => void;
  onRegenerate: (invoice: InvoiceSummary) => void;
}

export function InvoiceDetailsDialog({
  selectedInvoice,
  onClose,
  onRegenerate,
}: InvoiceDetailsDialogProps) {
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [pdfTab, setPdfTab] = useState<'invoice' | 'cancellation'>('invoice');

  // Reset revision selection when invoice changes (adjust state during render)
  const [prevInvoiceId, setPrevInvoiceId] = useState(selectedInvoice?.id);
  if (prevInvoiceId !== selectedInvoice?.id) {
    setPrevInvoiceId(selectedInvoice?.id);
    setSelectedRevisionId(null);
    setPdfTab('invoice');
  }

  // Build the month string for the revision query
  const month = selectedInvoice
    ? `${selectedInvoice.invoiceYear}-${String(selectedInvoice.invoiceMonth).padStart(2, '0')}`
    : '';

  // Fetch all revisions for this invoice base on demand
  const { revisions, isLoading: isLoadingRevisions } = useInvoiceRevisions(
    month,
    selectedInvoice?.id ?? null,
  );

  // Use fetched revisions if available, otherwise fall back to selectedInvoice
  const sortedRevisions = useMemo(() => {
    if (revisions.length > 0) {
      return [...revisions].sort((a, b) => b.revisionNumber - a.revisionNumber);
    }
    return selectedInvoice ? [selectedInvoice] : [];
  }, [revisions, selectedInvoice]);

  // Current displayed revision
  const invoice = useMemo(() => {
    if (!selectedInvoice) return null;
    if (selectedRevisionId) {
      return sortedRevisions.find((r) => r.revisionId === selectedRevisionId) ?? selectedInvoice;
    }
    return sortedRevisions[0] ?? selectedInvoice;
  }, [selectedInvoice, selectedRevisionId, sortedRevisions]);

  // PDF blob URLs for preview — useMemo for creation, useEffect for cleanup only
  const invoicePdf = invoice?.invoicePdf ?? null;
  const pdfBlobUrl = useMemo(() => {
    if (!invoicePdf) return null;
    return URL.createObjectURL(base64ToPdfBlob(invoicePdf));
  }, [invoicePdf]);

  useEffect(() => {
    return () => {
      if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl);
    };
  }, [pdfBlobUrl]);

  const cancellationPdf = invoice?.cancellationInvoicePdf ?? null;
  const cancellationPdfBlobUrl = useMemo(() => {
    if (!cancellationPdf) return null;
    return URL.createObjectURL(base64ToPdfBlob(cancellationPdf));
  }, [cancellationPdf]);

  useEffect(() => {
    return () => {
      if (cancellationPdfBlobUrl) URL.revokeObjectURL(cancellationPdfBlobUrl);
    };
  }, [cancellationPdfBlobUrl]);

  const handleDownload = useCallback(() => {
    if (!invoice) return;
    if (pdfTab === 'cancellation' && invoice.cancellationInvoicePdf) {
      downloadBase64Pdf(
        invoice.cancellationInvoicePdf,
        `${invoice.invoiceId}_rev${invoice.revisionNumber}_cancellation.pdf`,
      );
    } else if (invoice.invoicePdf) {
      downloadBase64Pdf(
        invoice.invoicePdf,
        `${invoice.invoiceId}_rev${invoice.revisionNumber}.pdf`,
      );
    }
  }, [invoice, pdfTab]);

  const handleClose = useCallback(() => {
    setSelectedRevisionId(null);
    setPdfTab('invoice');
    onClose();
  }, [onClose]);

  if (!invoice) return null;

  const monthName = new Date(invoice.invoiceYear, invoice.invoiceMonth - 1).toLocaleString(
    undefined,
    { month: 'long', year: 'numeric' },
  );

  return (
    <Dialog open={!!selectedInvoice} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            Invoice Details
            {invoice.isCancelled ? (
              <Badge variant="destructive">Cancelled</Badge>
            ) : (
              <Badge variant="success">Active</Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* Revision selector */}
        {sortedRevisions.length > 1 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">Revision:</span>
            {sortedRevisions.map((rev) => (
              <Button
                key={rev.revisionId}
                size="sm"
                variant={
                  (selectedRevisionId ?? sortedRevisions[0]?.revisionId) === rev.revisionId
                    ? 'default'
                    : 'outline'
                }
                onClick={() => setSelectedRevisionId(rev.revisionId)}
                className="gap-1"
              >
                #{rev.revisionNumber}
                {rev.isCancelled && (
                  <Badge variant="destructive" className="ml-1 text-[10px] px-1 py-0">
                    Cancelled
                  </Badge>
                )}
              </Button>
            ))}
          </div>
        )}
        {isLoadingRevisions && sortedRevisions.length <= 1 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size={14} />
            Loading revisions...
          </div>
        )}

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Invoice ID</span>
              <div className="flex items-center gap-2 font-mono mt-1">
                {invoice.invoiceId}
                <CopyButton value={invoice.invoiceId} />
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">Revision</span>
              <div className="mt-1">
                #{invoice.revisionNumber}
                <span className="text-muted-foreground text-xs ml-2">({invoice.revisionId})</span>
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">Month / Year</span>
              <div className="mt-1">{monthName}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Invoice Date</span>
              <div className="mt-1">{new Date(invoice.invoiceDate).toLocaleDateString()}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Currency</span>
              <div className="mt-1 uppercase">{invoice.currencyShortId}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Created</span>
              <div className="mt-1">{new Date(invoice.createdAt).toLocaleString()}</div>
            </div>
          </div>

          <Separator />

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground font-medium">Seller</span>
              <div className="mt-1">{invoice.sellerName || '—'}</div>
              {invoice.sellerCompanyName && (
                <div className="text-muted-foreground">{invoice.sellerCompanyName}</div>
              )}
            </div>
            <div>
              <span className="text-muted-foreground font-medium">Buyer</span>
              <div className="mt-1">{invoice.buyerName || '—'}</div>
              {invoice.buyerCompanyName && (
                <div className="text-muted-foreground">{invoice.buyerCompanyName}</div>
              )}
            </div>
          </div>

          <Separator />

          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Items</span>
              <div className="mt-1 font-medium">{invoice.itemCount}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Net Total</span>
              <div className="mt-1 font-medium">
                {invoice.netTotal} {invoice.currencyShortId.toUpperCase()}
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">VAT Total</span>
              <div className="mt-1 font-medium">
                {invoice.vatTotal} {invoice.currencyShortId.toUpperCase()}
              </div>
            </div>
          </div>
          <div className="text-sm">
            <span className="text-muted-foreground">Gross Total</span>
            <div className="mt-1 text-lg font-semibold">
              {invoice.grossTotal} {invoice.currencyShortId.toUpperCase()}
            </div>
          </div>

          {invoice.isCancelled && (
            <>
              <Separator />
              <div className="space-y-2 text-sm">
                <span className="text-muted-foreground font-medium">Cancellation Details</span>
                {invoice.cancellationReason && (
                  <div>
                    <span className="text-muted-foreground">Reason: </span>
                    {invoice.cancellationReason}
                  </div>
                )}
                {invoice.cancellationDate && (
                  <div>
                    <span className="text-muted-foreground">Date: </span>
                    {new Date(invoice.cancellationDate).toLocaleString()}
                  </div>
                )}
                {invoice.cancellationId && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">Cancellation ID: </span>
                    <span className="font-mono text-xs">{invoice.cancellationId}</span>
                    <CopyButton value={invoice.cancellationId} />
                  </div>
                )}
              </div>
            </>
          )}

          {invoice.coveredPaymentRequestIds.length > 0 && (
            <>
              <Separator />
              <div className="text-sm">
                <span className="text-muted-foreground font-medium">
                  Covered Payment Requests ({invoice.coveredPaymentRequestIds.length})
                </span>
                <div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
                  {invoice.coveredPaymentRequestIds.map((id) => (
                    <div key={id} className="flex items-center gap-2 font-mono text-xs">
                      {id}
                      <CopyButton value={id} />
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* PDF Preview */}
          {(pdfBlobUrl || cancellationPdfBlobUrl) && (
            <>
              <Separator />
              <div className="text-sm">
                {cancellationPdfBlobUrl ? (
                  <>
                    <div className="flex items-center gap-1 mb-2">
                      <button
                        type="button"
                        className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                          pdfTab === 'invoice'
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:bg-muted'
                        }`}
                        onClick={() => setPdfTab('invoice')}
                      >
                        Original Invoice
                      </button>
                      <button
                        type="button"
                        className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                          pdfTab === 'cancellation'
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:bg-muted'
                        }`}
                        onClick={() => setPdfTab('cancellation')}
                      >
                        Cancellation Invoice
                      </button>
                    </div>
                    <div className="border rounded-lg overflow-hidden bg-muted/20">
                      <iframe
                        src={
                          pdfTab === 'cancellation' ? cancellationPdfBlobUrl : (pdfBlobUrl ?? '')
                        }
                        className="w-full"
                        style={{ height: '500px' }}
                        title={
                          pdfTab === 'cancellation'
                            ? 'Cancellation Invoice PDF'
                            : 'Invoice PDF Preview'
                        }
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <span className="text-muted-foreground font-medium">Invoice PDF</span>
                    <div className="mt-2 border rounded-lg overflow-hidden bg-muted/20">
                      <iframe
                        src={pdfBlobUrl!}
                        className="w-full"
                        style={{ height: '500px' }}
                        title="Invoice PDF Preview"
                      />
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={handleClose}>
            Close
          </Button>
          {(invoice.invoicePdf || invoice.cancellationInvoicePdf) && (
            <Button variant="outline" onClick={handleDownload}>
              <Download className="h-4 w-4 mr-2" />
              {pdfTab === 'cancellation' && invoice.cancellationInvoicePdf
                ? 'Download Cancellation PDF'
                : 'Download Invoice PDF'}
            </Button>
          )}
          <Button onClick={() => onRegenerate(invoice)}>Regenerate Invoice</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
