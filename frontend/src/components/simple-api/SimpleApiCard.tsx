import { SimpleApiListing } from '@/lib/api/generated';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { cn } from '@/lib/utils';
import { ExternalLink, Clock } from 'lucide-react';

interface SimpleApiCardProps {
  listing: SimpleApiListing;
  onDetails: (listing: SimpleApiListing) => void;
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
  // USDC / USDbC and similar stablecoins on Base/Ethereum use 6 decimals
  const lowercaseAsset = accept.asset.toLowerCase();
  const is6Dec =
    lowercaseAsset.startsWith('0x') &&
    (accept.network.includes('base') || accept.network.includes('ethereum'));
  if (is6Dec) {
    const dollars = Number(raw) / 1_000_000;
    return `$${dollars.toFixed(dollars < 0.01 ? 4 : 2)}`;
  }
  // Fallback: show raw value
  return raw.toString();
}

function getStatusConfig(status: SimpleApiListing['status']) {
  switch (status) {
    case 'Online':
      return { dot: 'bg-green-500', badge: 'bg-green-50 text-green-700' };
    case 'Offline':
      return { dot: 'bg-yellow-500', badge: 'bg-yellow-50 text-yellow-700' };
    case 'Invalid':
      return { dot: 'bg-red-500', badge: 'bg-red-50 text-red-700' };
    case 'Deregistered':
    default:
      return { dot: 'bg-muted-foreground/40', badge: 'text-muted-foreground' };
  }
}

function formatLastActive(date: Date | null | undefined): string {
  if (!date) return 'Never';
  const d = date instanceof Date ? date : new Date(date);
  const diffMs = Date.now() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

export function SimpleApiCard({ listing, onDetails }: SimpleApiCardProps) {
  const { dot, badge } = getStatusConfig(listing.status);
  const firstAccept = listing.accepts[0];

  return (
    <div
      className={cn(
        'rounded-xl border bg-card flex flex-col gap-0 transition-shadow hover:shadow-md cursor-pointer',
        listing.status === 'Deregistered' && 'opacity-60',
      )}
      onClick={() => onDetails(listing)}
    >
      {/* Card header */}
      <div className="px-5 pt-5 pb-3 flex flex-col gap-2 flex-1">
        {/* Status row */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <span className={cn('w-2 h-2 rounded-full flex-shrink-0', dot)} />
            <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded-full', badge)}>
              {listing.status}
            </span>
          </div>
          {firstAccept && (
            <span className="text-xs font-medium bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 px-2 py-0.5 rounded-full truncate max-w-[120px]">
              {formatNetwork(firstAccept.network)}
            </span>
          )}
        </div>

        {/* Name + description */}
        <div>
          <h3 className="font-semibold text-sm leading-snug line-clamp-1">{listing.name}</h3>
          {listing.description && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
              {listing.description}
            </p>
          )}
        </div>

        {/* URL */}
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span className="truncate font-mono">{listing.url}</span>
          <a
            href={listing.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="flex-shrink-0 hover:text-primary"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
          <span onClick={(e) => e.stopPropagation()}>
            <CopyButton value={listing.url} />
          </span>
        </div>

        {/* Price + method */}
        <div className="flex items-center justify-between text-xs mt-1">
          <span className="font-medium text-foreground">
            {firstAccept ? (
              <>
                {formatPrice(firstAccept)}
                {listing.accepts.length > 1 && (
                  <span className="text-muted-foreground font-normal ml-1">
                    +{listing.accepts.length - 1} more
                  </span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">No payment info</span>
            )}
          </span>
          {listing.httpMethod && (
            <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
              {listing.httpMethod}
            </span>
          )}
        </div>

        {/* Category + tags */}
        {(listing.category || listing.tags.length > 0) && (
          <div className="flex flex-wrap gap-1 mt-1">
            {listing.category && (
              <Badge variant="secondary" className="text-xs py-0 px-2">
                {listing.category}
              </Badge>
            )}
            {listing.tags.slice(0, 2).map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs py-0 px-2">
                {tag}
              </Badge>
            ))}
            {listing.tags.length > 2 && (
              <span className="text-xs text-muted-foreground self-center">
                +{listing.tags.length - 2}
              </span>
            )}
          </div>
        )}

        {/* Last active */}
        <div className="flex items-center gap-1 text-xs text-muted-foreground mt-auto pt-2">
          <Clock className="h-3 w-3 flex-shrink-0" />
          <span>Last active: {formatLastActive(listing.lastActiveAt)}</span>
        </div>
      </div>

      {/* Footer actions */}
      <div
        className="px-5 pb-4 pt-3 border-t flex items-center gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          variant="outline"
          size="sm"
          className="flex-1 text-xs"
          onClick={() => onDetails(listing)}
        >
          View details
        </Button>
      </div>
    </div>
  );
}
