/**
 * A transaction id that opens on a chain explorer.
 *
 * Shared between deposits and withdrawals because the distinction it draws
 * matters in both: only ids that exist on L1 are rendered as links. A Hydra head
 * produces transaction ids that never reach a chain — the in-head split, the
 * decommit itself — and rendering one of those as a link sends an operator to a
 * 404 that reads like the withdrawal went missing.
 */

import { ExternalLink } from 'lucide-react';
import { getExplorerUrl } from '@/lib/utils';
import { CopyButton } from '@/components/ui/copy-button';

export function TxLink({
  label,
  hash,
  network,
  fallback,
}: {
  label: string;
  hash: string | null;
  network: string | undefined;
  /** Shown when there is no transaction yet, e.g. a split still being built. */
  fallback: string | null;
}) {
  if (hash === null) {
    return fallback === null ? null : (
      <span className="text-xs text-muted-foreground">{fallback}</span>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <a
        href={getExplorerUrl(hash, network ?? 'Preprod', 'transaction')}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
        title="Open on Cardanoscan"
      >
        {hash.slice(0, 10)}…
        <ExternalLink className="h-3 w-3" />
      </a>
      <CopyButton value={hash} className="h-6 w-6" />
    </span>
  );
}

/**
 * An id that is not on any chain, shown as plain text.
 *
 * Explicitly labelled rather than left bare: an operator looking at a hash in an
 * admin UI reasonably assumes it is on chain, and the label is what stops them
 * searching an explorer for something that was only ever inside the head.
 */
export function InHeadTxId({ label, hash }: { label: string; hash: string | null }) {
  if (hash === null) return null;
  return (
    <span className="flex items-center gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className="font-mono text-xs text-muted-foreground"
        title="Inside the head, not on chain"
      >
        {hash.slice(0, 10)}…
      </span>
      <CopyButton value={hash} className="h-6 w-6" />
    </span>
  );
}
