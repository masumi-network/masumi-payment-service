import { SimpleApiListing } from '@/lib/api/generated';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { cn, shortenAddress } from '@/lib/utils';
import { ExternalLink, Clock, Calendar, Tag } from 'lucide-react';

function isSafeUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

interface SimpleApiDetailsDialogProps {
  listing: SimpleApiListing | null;
  onClose: () => void;
}

function formatNetwork(network: string): string {
  const map: Record<string, string> = {
    'base-sepolia': 'Base Sepolia',
    base: 'Base',
    'ethereum-sepolia': 'ETH Sepolia',
    ethereum: 'Ethereum',
    solana: 'Solana',
    'solana-devnet': 'Sol Devnet',
  };
  return map[network] ?? network;
}

function formatPrice(accept: SimpleApiListing['accepts'][number]): string {
  const raw = BigInt(accept.maxAmountRequired ?? '0');
  const lowercaseAsset = accept.asset.toLowerCase();
  const is6Dec =
    lowercaseAsset.startsWith('0x') &&
    (accept.network.includes('base') || accept.network.includes('ethereum'));
  if (is6Dec) {
    const dollars = Number(raw) / 1_000_000;
    return `$${dollars.toFixed(dollars < 0.01 ? 4 : 2)}`;
  }
  return raw.toString();
}

function getStatusConfig(status: SimpleApiListing['status']) {
  switch (status) {
    case 'Online':
      return { dot: 'bg-green-500', label: 'text-green-700 bg-green-50' };
    case 'Offline':
      return { dot: 'bg-yellow-500', label: 'text-yellow-700 bg-yellow-50' };
    case 'Invalid':
      return { dot: 'bg-red-500', label: 'text-red-700 bg-red-50' };
    case 'Deregistered':
    default:
      return { dot: 'bg-muted-foreground/40', label: 'text-muted-foreground' };
  }
}

function formatDate(date: Date | null | undefined): string {
  if (!date) return '—';
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleString();
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
        {label}
      </span>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export function SimpleApiDetailsDialog({ listing, onClose }: SimpleApiDetailsDialogProps) {
  if (!listing) return null;

  const { dot, label } = getStatusConfig(listing.status);

  return (
    <Dialog open={!!listing} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className={cn('w-2.5 h-2.5 rounded-full flex-shrink-0', dot)} />
            {listing.name}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Status + network badges */}
          <div className="flex flex-wrap gap-2">
            <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', label)}>
              {listing.status}
            </span>
            <span className="text-xs font-medium bg-muted px-2 py-0.5 rounded-full">
              Registry: {listing.network}
            </span>
            {listing.httpMethod && (
              <span className="font-mono text-xs bg-muted px-2 py-0.5 rounded-full">
                {listing.httpMethod}
              </span>
            )}
          </div>

          {/* Service info */}
          <div className="grid grid-cols-1 gap-4">
            {listing.description && (
              <DetailRow label="Description">
                <p className="text-muted-foreground">{listing.description}</p>
              </DetailRow>
            )}

            <DetailRow label="URL">
              <div className="flex items-center gap-2 font-mono text-xs break-all">
                <span>{listing.url}</span>
                <div className="flex-shrink-0 flex items-center gap-1">
                  <CopyButton value={listing.url} />
                  {isSafeUrl(listing.url) ? (
                    <a
                      href={listing.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-primary"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : (
                    <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/40" />
                  )}
                </div>
              </div>
            </DetailRow>

            {listing.category && (
              <DetailRow label="Category">
                <Badge variant="secondary">{listing.category}</Badge>
              </DetailRow>
            )}

            {listing.tags.length > 0 && (
              <DetailRow label="Tags">
                <div className="flex flex-wrap gap-1">
                  {listing.tags.map((tag) => (
                    <Badge key={tag} variant="outline" className="text-xs">
                      <Tag className="h-2.5 w-2.5 mr-1" />
                      {tag}
                    </Badge>
                  ))}
                </div>
              </DetailRow>
            )}
          </div>

          {/* Payment options */}
          {listing.accepts.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-3">
                Payment options ({listing.accepts.length})
              </h4>
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-muted/30">
                    <tr className="border-b">
                      <th className="p-3 text-left font-medium text-muted-foreground">Network</th>
                      <th className="p-3 text-left font-medium text-muted-foreground">Amount</th>
                      <th className="p-3 text-left font-medium text-muted-foreground">Pay To</th>
                      <th className="p-3 text-left font-medium text-muted-foreground">Resource</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listing.accepts.map((accept, i) => (
                      <tr key={i} className="border-b last:border-b-0">
                        <td className="p-3">
                          <span className="font-medium">{formatNetwork(accept.network)}</span>
                        </td>
                        <td className="p-3 font-medium text-foreground">{formatPrice(accept)}</td>
                        <td className="p-3">
                          <div className="flex items-center gap-1 font-mono">
                            <span className="text-muted-foreground">
                              {shortenAddress(accept.payTo)}
                            </span>
                            <CopyButton value={accept.payTo} />
                          </div>
                        </td>
                        <td className="p-3">
                          <div className="flex items-center gap-1 font-mono max-w-[140px]">
                            <span className="truncate text-muted-foreground">
                              {accept.resource}
                            </span>
                            <CopyButton value={accept.resource} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Asset addresses */}
              {listing.accepts.length === 1 && listing.accepts[0].asset && (
                <div className="mt-2 text-xs text-muted-foreground flex items-center gap-1">
                  <span className="font-medium">Token contract:</span>
                  <span className="font-mono">{shortenAddress(listing.accepts[0].asset)}</span>
                  <CopyButton value={listing.accepts[0].asset} />
                </div>
              )}
            </div>
          )}

          {/* Timestamps */}
          <div className="grid grid-cols-2 gap-4 pt-2 border-t">
            <DetailRow label="Last Active">
              <div className="flex items-center gap-1 text-muted-foreground">
                <Clock className="h-3.5 w-3.5 flex-shrink-0" />
                {formatDate(listing.lastActiveAt)}
              </div>
            </DetailRow>
            <DetailRow label="Status Updated">
              <div className="flex items-center gap-1 text-muted-foreground">
                <Clock className="h-3.5 w-3.5 flex-shrink-0" />
                {formatDate(listing.statusUpdatedAt)}
              </div>
            </DetailRow>
            <DetailRow label="First Synced">
              <div className="flex items-center gap-1 text-muted-foreground">
                <Calendar className="h-3.5 w-3.5 flex-shrink-0" />
                {formatDate(listing.createdAt)}
              </div>
            </DetailRow>
            <DetailRow label="Registry ID">
              <div className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
                <span>{shortenAddress(listing.registryListingId)}</span>
                <CopyButton value={listing.registryListingId} />
              </div>
            </DetailRow>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
