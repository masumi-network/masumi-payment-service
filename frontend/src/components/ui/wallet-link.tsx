import { ExternalLink, Wallet } from 'lucide-react';
import { CopyButton } from '@/components/ui/copy-button';
import { shortenAddress, getExplorerUrl } from '@/lib/utils';
import { cn } from '@/lib/utils';

interface WalletLinkProps {
  address?: string | null;
  vkey?: string | null;
  network: string;
  shorten?: number;
  onInternalClick?: () => void;
  className?: string;
}

export function WalletLink({
  address,
  vkey,
  network,
  shorten,
  onInternalClick,
  className,
}: WalletLinkProps) {
  const displayValue = address || vkey || '';
  if (!displayValue) return null;

  const displayText = shorten ? shortenAddress(displayValue, shorten) : displayValue;
  const copyValue = address || vkey || '';
  const explorerUrl = address ? getExplorerUrl(address, network) : null;

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      {onInternalClick ? (
        <button
          type="button"
          className="font-mono text-sm break-all hover:underline text-primary cursor-pointer text-left"
          onClick={onInternalClick}
        >
          {displayText}
          <Wallet className="h-3 w-3 ml-0.5 inline align-baseline" />
        </button>
      ) : explorerUrl ? (
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-sm break-all hover:underline text-primary"
        >
          {displayText}
          <ExternalLink className="h-3 w-3 ml-0.5 inline align-baseline" />
        </a>
      ) : (
        <span className="font-mono text-sm break-all text-muted-foreground">{displayText}</span>
      )}
      <CopyButton value={copyValue} />
    </span>
  );
}
