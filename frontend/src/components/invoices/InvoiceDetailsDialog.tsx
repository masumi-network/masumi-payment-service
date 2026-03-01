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
import type { InvoiceSummary } from '@/lib/hooks/useInvoices';

interface InvoiceDetailsDialogProps {
  invoice: InvoiceSummary | null;
  onClose: () => void;
  onRegenerate: (invoice: InvoiceSummary) => void;
}

export function InvoiceDetailsDialog({
  invoice,
  onClose,
  onRegenerate,
}: InvoiceDetailsDialogProps) {
  if (!invoice) return null;

  const monthName = new Date(invoice.invoiceYear, invoice.invoiceMonth - 1).toLocaleString(
    undefined,
    { month: 'long', year: 'numeric' },
  );

  return (
    <Dialog open={!!invoice} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
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
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => onRegenerate(invoice)}>Regenerate Invoice</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
