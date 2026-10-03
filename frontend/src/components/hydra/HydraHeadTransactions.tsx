/**
 * What this head has done, newest first.
 *
 * The head record keeps three hashes, opening, closing, fanning out, which
 * leaves out everything in between: the payments that ran inside the head and
 * the deposits that funded them. Those are the ones an operator is usually
 * looking for, because they are the ones that can go wrong quietly.
 *
 * L1 and L2 are labelled rather than separated. Whether a payment went through
 * the head or around it is the single most useful thing this list answers, and
 * splitting them into two lists hides exactly that.
 */

import { ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { formatFundUnit, getExplorerUrl, shortenAddress } from '@/lib/utils';
import { formatDateTime } from '@/lib/format-date';
import { useHydraHeadTransactions, type HydraHeadTransaction } from '@/lib/hooks/useHydraHeads';
import { InfoHint } from '@/components/ui/info-hint';

/**
 * Lovelace crosses the wire as a string because it is a BigInt, and putting it
 * through Number to divide would give it back the precision loss the string was
 * there to avoid. Split on the decimal instead.
 */
function formatLovelace(lovelace: string): string {
  const negative = lovelace.startsWith('-');
  const digits = (negative ? lovelace.slice(1) : lovelace).padStart(7, '0');
  const whole = digits.slice(0, -6).replace(/^0+(?=\d)/, '');
  const fraction = digits.slice(-6, -4);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'Confirmed') return 'default';
  if (status === 'Pending') return 'secondary';
  if (status.startsWith('Failed') || status === 'RolledBack') return 'destructive';
  return 'outline';
}

function TransactionRow({
  transaction,
  network,
}: {
  transaction: HydraHeadTransaction;
  network: string;
}) {
  // Before broadcast there is no txHash, only the hash the body will have. It
  // is shown because it is what identifies the transaction if the submit turns
  // out to be ambiguous.
  const hash = transaction.txHash ?? transaction.intendedTxHash;
  const isOnChain = transaction.layer === 'L1' && transaction.txHash !== null;
  // The same lovelace shows as tADA in the balance panel one section up, so a
  // hardcoded "ADA" here read as a second, different asset.
  const ticker = formatFundUnit('lovelace', network);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          {/* Named by what the money was for, not by which table it came from.
              A deposit and a node top-up are both L1 transactions, and telling
              them apart is the whole reason someone opens this list. */}
          <Badge variant={transaction.layer === 'L2' ? 'secondary' : 'outline'}>
            {transaction.kind === 'Deposit'
              ? 'Into the head'
              : transaction.kind === 'NodeFunding'
                ? 'Node fuel'
                : transaction.layer === 'L2'
                  ? 'In head'
                  : 'On chain'}
          </Badge>
          <Badge variant={statusVariant(transaction.status)}>{transaction.status}</Badge>
          {transaction.txHash === null && transaction.intendedTxHash !== null && (
            <span className="text-xs text-muted-foreground">not broadcast yet</span>
          )}
        </div>
        {hash === null ? (
          <p className="text-xs text-muted-foreground">No hash recorded</p>
        ) : (
          <div className="flex items-center gap-1">
            <span className="font-mono text-xs">{shortenAddress(hash, 10)}</span>
            <CopyButton value={hash} />
            {isOnChain && (
              <a
                href={getExplorerUrl(hash, network, 'transaction')}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground"
                aria-label="Open in the explorer"
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        )}
      </div>
      <div className="text-right text-xs text-muted-foreground">
        <p>{formatDateTime(transaction.createdAt)}</p>
        {transaction.lovelace != null && (
          <p className="tabular-nums">
            {formatLovelace(transaction.lovelace)} {ticker}
          </p>
        )}
        {transaction.fees !== null && (
          <p className="tabular-nums">
            {formatLovelace(transaction.fees)} {ticker} fee
          </p>
        )}
      </div>
    </div>
  );
}

export function HydraHeadTransactions({
  headId,
  network,
}: {
  headId: string;
  /** 'Preprod' or 'Mainnet', passed straight to the explorer URL builder. */
  network: string;
}) {
  const { transactions, isLoading, isError, isFetching, refetch } =
    useHydraHeadTransactions(headId);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Newest first
          <InfoHint label="transaction list">
            <p>
              Everything this head has moved: payments it carried, deposits into it, and ADA sent to
              its node to pay on-chain fees.
            </p>
            <p>
              In-head transactions never reach the explorer, because the head settles as one
              transaction when it closes.
            </p>
          </InfoHint>
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label="Refresh the transactions"
          onClick={() => void refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {isLoading ? (
        <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading
        </p>
      ) : isError && transactions.length === 0 ? (
        // Never the affirmative empty state on a failed read: "nothing yet" is a
        // claim about the head, and this is a claim about the request.
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-destructive/40 px-3 py-2">
          <span className="text-sm text-muted-foreground">
            Could not read this head&apos;s transactions.
          </span>
          <Button type="button" size="sm" variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : transactions.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          Nothing yet. Payments routed through this head show up here as they happen.
        </p>
      ) : (
        <div className="divide-y rounded-md border">
          {transactions.map((transaction) => (
            <TransactionRow key={transaction.id} transaction={transaction} network={network} />
          ))}
        </div>
      )}
    </div>
  );
}
