import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { formatDateTime } from '@/lib/format-date';
import { rowActivation } from '@/lib/a11y';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RefreshButton } from '@/components/RefreshButton';
import {
  useX402Networks,
  useX402PaymentAttempts,
  type X402PaymentFilters,
} from '@/lib/hooks/useX402';
import { cn, groupDigits, shortenAddress } from '@/lib/utils';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useApiMutation } from '@/lib/hooks/useApiMutation';
import { postX402PaymentsReconcile, X402PaymentAttempt } from '@/lib/api/generated';

const TX_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/;

const ALL = '__all__';

// Primary view switcher (mirrors Cardano's Payments/Purchases split): Pay = outbound, Receive =
// both inbound directions, Needs action = the reconciliation backlog.
type PaymentView = 'all' | 'buy' | 'sell' | 'needs';
const VIEW_OPTIONS: { key: PaymentView; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'buy', label: 'Pay' },
  { key: 'sell', label: 'Receive' },
  { key: 'needs', label: 'Needs action' },
];

const STATUS_OPTIONS: X402PaymentAttempt['status'][] = [
  'PaymentRequired',
  'Verified',
  'Settled',
  'Failed',
  'Replayed',
];

const STATUS_VARIANT: Record<X402PaymentAttempt['status'], BadgeProps['variant']> = {
  PaymentRequired: 'pending',
  Verified: 'processing',
  Settled: 'success',
  Failed: 'destructive',
  Replayed: 'secondary',
};

const DIRECTION_LABEL: Record<X402PaymentAttempt['direction'], string> = {
  InboundVerify: 'Inbound · Verify',
  InboundSettle: 'Inbound · Settle',
  OutboundPayment: 'Outbound · Payment',
};

export function PaymentsTab() {
  const { networks } = useX402Networks();
  const { activeRail, selectedX402ChainId } = useAppContext();
  const [filters, setFilters] = useState<X402PaymentFilters>({});
  const [selected, setSelected] = useState<X402PaymentAttempt | null>(null);

  // On the EVM rail, scope the payment list to the chain selected in the sidebar, and keep
  // it in sync when that selection changes. A manual chain filter persists until the
  // sidebar selection actually changes (tracked via ref), so this follows the chip without
  // overriding an in-table choice on every render.
  const selectedCaip2 = networks.find((n) => n.id === selectedX402ChainId)?.caip2Id;
  const lastAppliedCaip2 = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (activeRail !== 'x402') return;
    // No chain selected (e.g. right after a network switch clears selectedX402ChainId): drop
    // the previous chain scope so the table doesn't keep querying the old, now-invalid chain.
    if (!selectedX402ChainId) {
      if (lastAppliedCaip2.current !== undefined) {
        lastAppliedCaip2.current = undefined;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- Clears the stale chain scope when the sidebar selection is cleared.
        setFilters((prev) => (prev.caip2Network ? { ...prev, caip2Network: undefined } : prev));
      }
      return;
    }
    if (!selectedCaip2) return; // chain selected but networks still loading
    if (lastAppliedCaip2.current === selectedCaip2) return;
    lastAppliedCaip2.current = selectedCaip2;

    setFilters((prev) =>
      prev.caip2Network === selectedCaip2 ? prev : { ...prev, caip2Network: selectedCaip2 },
    );
  }, [activeRail, selectedX402ChainId, selectedCaip2]);
  const { attempts, isLoading, hasMore, loadMore, isFetchingNextPage, refetch, isRefetching } =
    useX402PaymentAttempts(filters);

  const chainLabel = (caip2: string) =>
    networks.find((n) => n.caip2Id === caip2)?.displayName ?? caip2;

  // The switcher is the primary control; it maps to the coarse side/needs-action filters.
  const activeView: PaymentView = filters.needsManualAction ? 'needs' : (filters.side ?? 'all');
  const setView = (view: PaymentView) =>
    setFilters((prev) => ({
      ...prev,
      side: view === 'buy' ? 'buy' : view === 'sell' ? 'sell' : undefined,
      needsManualAction: view === 'needs' ? true : undefined,
      // Needs-action pins its own set of states, so drop any status refinement + granular direction.
      status: view === 'needs' ? undefined : prev.status,
      direction: undefined,
    }));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Every x402 payment this service signed (Pay / outbound) or verified and settled (Receive /
        inbound), newest first. Use the switcher for the buy vs sell side or the reconciliation
        backlog.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border bg-muted/40 p-0.5">
            {VIEW_OPTIONS.map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={() => setView(v.key)}
                aria-pressed={activeView === v.key}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  activeView === v.key
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {v.label}
              </button>
            ))}
          </div>

          {activeView !== 'needs' && (
            <Select
              value={filters.status ?? ALL}
              onValueChange={(value) =>
                setFilters((prev) => ({
                  ...prev,
                  status: value === ALL ? undefined : (value as X402PaymentAttempt['status']),
                }))
              }
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {STATUS_OPTIONS.map((status) => (
                  <SelectItem key={status} value={status}>
                    {status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select
            value={filters.caip2Network ?? ALL}
            onValueChange={(value) =>
              setFilters((prev) => ({
                ...prev,
                caip2Network: value === ALL ? undefined : value,
              }))
            }
          >
            <SelectTrigger className="w-[170px]">
              <SelectValue placeholder="All chains" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All chains</SelectItem>
              {networks.map((network) => (
                <SelectItem key={network.id} value={network.caip2Id}>
                  {network.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <RefreshButton onRefresh={refetch} isRefreshing={isRefetching} />
      </div>

      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full">
          <thead className="bg-muted/30 dark:bg-muted/15">
            <tr className="border-b">
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Direction
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Status
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Chain
              </th>
              <th scope="col" className="p-4 text-right text-sm font-medium text-muted-foreground">
                Amount (base units)
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Asset
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Created
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={6} className="py-10">
                  <div className="flex justify-center">
                    <Spinner />
                  </div>
                </td>
              </tr>
            ) : attempts.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState
                    title="No payment activity"
                    description="x402 verify, settle and fetch attempts will appear here."
                  />
                </td>
              </tr>
            ) : (
              attempts.map((attempt) => (
                <tr
                  key={attempt.id}
                  className="border-b last:border-0 cursor-pointer hover:bg-muted/40"
                  aria-label="View payment attempt details"
                  onClick={() => setSelected(attempt)}
                  {...rowActivation(() => setSelected(attempt))}
                >
                  <td className="p-4 text-sm">{DIRECTION_LABEL[attempt.direction]}</td>
                  <td className="p-4">
                    <Badge variant={STATUS_VARIANT[attempt.status]}>{attempt.status}</Badge>
                  </td>
                  <td className="p-4 text-sm">{chainLabel(attempt.caip2Network)}</td>
                  <td className="p-4 text-right font-mono text-sm">
                    {groupDigits(attempt.amount)}
                  </td>
                  <td className="p-4 font-mono text-sm">{shortenAddress(attempt.asset, 6)}</td>
                  <td className="p-4 text-sm text-muted-foreground">
                    {formatDateTime(attempt.createdAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={isFetchingNextPage}>
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}

      <PaymentDetailsDialog
        attempt={selected}
        chainLabel={selected ? chainLabel(selected.caip2Network) : ''}
        onClose={() => setSelected(null)}
        onReconciled={() => {
          setSelected(null);
          refetch();
        }}
      />
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 border-b last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono text-sm text-right break-all' : 'text-sm text-right'}>
        {value}
      </span>
    </div>
  );
}

// A mono value with a copy button, for ids / hashes / addresses.
function CopyValue({ value }: { value: string }) {
  return (
    <span className="flex items-center justify-end gap-1">
      <span className="font-mono text-sm text-right break-all">{value}</span>
      <CopyButton value={value} />
    </span>
  );
}

function PaymentDetailsDialog({
  attempt,
  chainLabel,
  onClose,
  onReconciled,
}: {
  attempt: X402PaymentAttempt | null;
  chainLabel: string;
  onClose: () => void;
  onReconciled: () => void;
}) {
  return (
    <Dialog open={!!attempt} onOpenChange={(value) => !value && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Payment attempt</DialogTitle>
          <DialogDescription>x402 payment attempt and its settlement result.</DialogDescription>
        </DialogHeader>

        {attempt && (
          <div className="space-y-4">
            <div className="rounded-lg border p-3">
              <p className="text-sm font-medium mb-2">Overview</p>
              <DetailRow label="Attempt id" value={<CopyValue value={attempt.id} />} />
              <DetailRow label="Direction" value={DIRECTION_LABEL[attempt.direction]} />
              <DetailRow
                label="Status"
                value={<Badge variant={STATUS_VARIANT[attempt.status]}>{attempt.status}</Badge>}
              />
              <DetailRow label="Chain" value={chainLabel} />
              <DetailRow label="Created" value={formatDateTime(attempt.createdAt)} />
              <DetailRow label="Updated" value={formatDateTime(attempt.updatedAt)} />
              <DetailRow label="API key" value={attempt.apiKeyId} mono />
            </div>

            <div className="rounded-lg border p-3">
              <p className="text-sm font-medium mb-2">Payment</p>
              <DetailRow label="Amount (base units)" value={attempt.amount} mono />
              <DetailRow label="Asset" value={attempt.asset} mono />
              <DetailRow label="Pay to" value={attempt.payTo ?? '—'} mono={!!attempt.payTo} />
              <DetailRow label="Payer" value={attempt.payer ?? '—'} mono={!!attempt.payer} />
              {attempt.resource && <DetailRow label="Resource" value={attempt.resource} mono />}
              {attempt.paymentIdentifier && (
                <DetailRow label="Payment identifier" value={attempt.paymentIdentifier} mono />
              )}
            </div>

            <div className="rounded-lg border p-3">
              <p className="text-sm font-medium mb-2">Wallet &amp; facilitator</p>
              {attempt.direction === 'OutboundPayment' ? (
                <DetailRow
                  label="Signing wallet"
                  value={attempt.evmWalletId ? <CopyValue value={attempt.evmWalletId} /> : '—'}
                />
              ) : attempt.facilitator ? (
                <DetailRow
                  label="Facilitator"
                  value={
                    attempt.facilitator.mode === 'remote'
                      ? 'Remote facilitator'
                      : (attempt.facilitator.address ?? 'Self-hosted wallet')
                  }
                  mono={attempt.facilitator.mode === 'self_hosted' && !!attempt.facilitator.address}
                />
              ) : (
                <DetailRow label="Facilitator" value="—" />
              )}
              {attempt.supportedPaymentSourceId && (
                <DetailRow
                  label="Payment source"
                  value={<CopyValue value={attempt.supportedPaymentSourceId} />}
                />
              )}
              {attempt.registryRequestId && (
                <DetailRow
                  label="Registry request"
                  value={<CopyValue value={attempt.registryRequestId} />}
                />
              )}
            </div>

            {attempt.errorReason && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-1">
                <p className="text-sm font-medium text-destructive">{attempt.errorReason}</p>
                {attempt.errorMessage && (
                  <p className="text-xs text-muted-foreground">{attempt.errorMessage}</p>
                )}
              </div>
            )}

            {attempt.Settlement && (
              <div className="rounded-lg border p-3">
                <p className="text-sm font-medium mb-2">Settlement</p>
                <DetailRow
                  label="Result"
                  value={
                    <Badge variant={attempt.Settlement.success ? 'success' : 'destructive'}>
                      {attempt.Settlement.success ? 'Success' : 'Failed'}
                    </Badge>
                  }
                />
                {attempt.Settlement.txHash && (
                  <div className="flex items-center justify-between gap-4 py-1.5 border-b">
                    <span className="text-sm text-muted-foreground">Transaction</span>
                    <span className="flex items-center gap-1">
                      <span className="font-mono text-sm">
                        {shortenAddress(attempt.Settlement.txHash, 8)}
                      </span>
                      <CopyButton value={attempt.Settlement.txHash} />
                    </span>
                  </div>
                )}
                {attempt.Settlement.amount && (
                  <DetailRow label="Amount (base units)" value={attempt.Settlement.amount} mono />
                )}
                {attempt.Settlement.payer && (
                  <DetailRow label="Payer" value={attempt.Settlement.payer} mono />
                )}
                <DetailRow
                  label="Settled at"
                  value={formatDateTime(attempt.Settlement.createdAt)}
                />
              </div>
            )}

            <ReconcileSection attempt={attempt} onReconciled={onReconciled} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// An inbound settle can get stuck when the on-chain settle result is ambiguous (the settle threw
// or crashed after broadcasting). Only an operator can resolve it — by confirming on-chain whether
// funds moved. Shown for InboundSettle attempts left Verified, or Settled but missing their
// settlement record (funds moved, only 'settled' is valid then).
function ReconcileSection({
  attempt,
  onReconciled,
}: {
  attempt: X402PaymentAttempt;
  onReconciled: () => void;
}) {
  const { apiClient } = useAppContext();
  const [txHash, setTxHash] = useState('');
  const reconcile = useApiMutation({
    mutationFn: (body: { attemptId: string; resolution: 'settled' | 'failed'; txHash?: string }) =>
      postX402PaymentsReconcile({ client: apiClient, body }),
    errorMessage: 'Failed to reconcile payment',
  });

  const settledMissingRecord = attempt.status === 'Settled' && !attempt.Settlement;
  const isReconcilable =
    attempt.direction === 'InboundSettle' &&
    (attempt.status === 'Verified' || settledMissingRecord);
  if (!isReconcilable) return null;

  const txHashValid = TX_HASH_REGEX.test(txHash);
  const submit = async (resolution: 'settled' | 'failed') => {
    const response = await reconcile
      .mutateAsync({
        attemptId: attempt.id,
        resolution,
        txHash: resolution === 'settled' ? txHash : undefined,
      })
      .catch(() => null);
    if (!response) return;
    toast.success(resolution === 'settled' ? 'Marked settled' : 'Marked failed');
    onReconciled();
  };

  return (
    <div className="rounded-lg border border-amber-300/60 bg-amber-50 p-3 space-y-3 dark:border-amber-900/40 dark:bg-amber-950/20">
      <div>
        <p className="text-sm font-medium">Needs reconciliation</p>
        <p className="text-xs text-muted-foreground">
          The settle outcome is unknown. Confirm on-chain whether the funds moved, then record it.
        </p>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="reconcile-txhash" className="text-xs font-medium text-muted-foreground">
          Settlement tx hash
        </label>
        <Input
          id="reconcile-txhash"
          placeholder="0x… 32-byte tx hash"
          className="font-mono text-xs"
          value={txHash}
          onChange={(e) => setTxHash(e.target.value.trim())}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!txHashValid || reconcile.isPending}
          onClick={() => submit('settled')}
        >
          {reconcile.isPending ? 'Saving…' : 'Mark settled'}
        </Button>
        {!settledMissingRecord && (
          <Button
            size="sm"
            variant="outline"
            disabled={reconcile.isPending}
            onClick={() => submit('failed')}
          >
            Mark failed (retryable)
          </Button>
        )}
      </div>
    </div>
  );
}
