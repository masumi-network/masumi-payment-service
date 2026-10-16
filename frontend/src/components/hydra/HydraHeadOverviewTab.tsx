/**
 * The Overview tab: the state of one head at a glance.
 *
 * Anything that needs the operator comes first, as notices. Then three
 * numbers, each a link to the tab that explains it, then the live connection
 * (checked on open), then the two wallets the head is between. Everything an
 * operator reads on every visit, and nothing they read once.
 */

import type { ReactNode } from 'react';
import { ChevronRight, KeyRound } from 'lucide-react';
import { HydraHeadEnableNotice } from '@/components/hydra/HydraHeadEnableNotice';
import { HydraNotice } from '@/components/hydra/HydraNotice';
import { HydraHeadWallets } from '@/components/hydra/HydraHeadWallets';
import { HydraHeadConnectionPanel } from '@/components/hydra/HydraHeadConnection';
import { HydraHeadSnapshotRoundNotice } from '@/components/hydra/HydraHeadSnapshotRoundNotice';
import { counterpartRole } from '@/components/hydra/WalletRoleBadge';
import { headStagePermitsAnyAction } from '@/components/hydra/head-lifecycle';
import { formatDate } from '@/components/hydra/head-display';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useHydraHeadBalance, type HydraHead } from '@/lib/hooks/useHydraHeads';
import { formatAssetAmount } from '@/lib/utils';

export type HydraHeadTab = 'Overview' | 'Funds' | 'Activity' | 'Errors' | 'Details';

function StatTile({
  label,
  value,
  detail,
  onClick,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="group min-w-0 space-y-1 rounded-lg border p-3 text-left transition-colors enabled:hover:bg-accent/50 disabled:cursor-default"
    >
      <p className="flex items-center justify-between text-xs text-muted-foreground">
        {label}
        {onClick && (
          <ChevronRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </p>
      <p className="truncate font-mono text-base font-semibold tabular-nums">{value}</p>
      {detail && <p className="truncate text-xs text-muted-foreground">{detail}</p>}
    </button>
  );
}

function BalanceTile({
  head,
  network,
  onClick,
}: {
  head: HydraHead;
  network: string;
  onClick: () => void;
}) {
  const isOpen = head.status === 'Open';
  const { data, isLoading } = useHydraHeadBalance(head.id, isOpen);
  const ada = data?.balance.find((asset) => asset.unit === '');
  const tokenCount = (data?.balance ?? []).filter((asset) => asset.unit !== '').length;

  const value = !isOpen ? (
    '-'
  ) : isLoading ? (
    <Spinner className="h-4 w-4" />
  ) : data?.connected ? (
    formatAssetAmount(ada?.quantity ?? '0', 'lovelace', network)
  ) : (
    '-'
  );
  const detail = !isOpen
    ? 'Head is not open'
    : data && !data.connected
      ? 'Not connected'
      : tokenCount > 0
        ? `+ ${tokenCount} token${tokenCount === 1 ? '' : 's'}`
        : data
          ? `${data.utxoCount} UTxO${data.utxoCount === 1 ? '' : 's'}`
          : undefined;

  return <StatTile label="In the head" value={value} detail={detail} onClick={onClick} />;
}

export function HydraHeadOverviewTab({
  head,
  network,
  onNavigate,
  onBackUpKeys,
  onLocalWalletClick,
  onRemoteWalletClick,
}: {
  head: HydraHead;
  network: string;
  onNavigate: (tab: HydraHeadTab) => void;
  onBackUpKeys: (head: HydraHead) => void;
  onLocalWalletClick?: () => void;
  onRemoteWalletClick?: () => void;
}) {
  const isOpen = head.status === 'Open';
  const remote = head.RemoteParticipants?.[0];
  // Ledger rows only. Activity also lists deposits and node funding, which the
  // head carries no count for.
  const ledgerCount = head._count?.Transactions ?? 0;

  return (
    <div className="space-y-6">
      {/* A disabled head answers every other question on this screen: the
          balances still read as healthy and every action is greyed out. */}
      <HydraHeadEnableNotice head={head} />

      {head.reconciliationStalledTxId && (
        <HydraNotice tone="error">
          <p className="font-medium">This head has stopped syncing and needs an operator.</p>
          <p>
            A confirmed in-head transaction could not be processed
            {head.reconciliationStalledReason ? ` (${head.reconciliationStalledReason})` : ''}, and
            every later sync pass stops at it. Payments on this head will not settle until it is
            cleared.
          </p>
          <p className="mt-1 break-all font-mono text-xs">{head.reconciliationStalledTxId}</p>
          {head.reconciliationStalledSince && (
            <p className="text-xs">
              Stalled since {new Date(head.reconciliationStalledSince).toLocaleString()}
            </p>
          )}
        </HydraNotice>
      )}

      <HydraHeadSnapshotRoundNotice headId={head.id} isOpen={isOpen} />

      {head.LocalParticipant && !head.LocalParticipant.keysDisclosedAt && (
        <HydraNotice
          tone="warn"
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => onBackUpKeys(head)}
            >
              <KeyRound className="h-4 w-4" />
              Back up keys
            </Button>
          }
        >
          <p className="font-medium">This node&apos;s signing keys have never been backed up.</p>
          <p>They can be shown once, then the service seals them.</p>
        </HydraNotice>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <BalanceTile head={head} network={network} onClick={() => onNavigate('Funds')} />
        <StatTile
          label="Transactions"
          value={ledgerCount}
          detail="in this head's ledger"
          onClick={() => onNavigate('Activity')}
        />
        <StatTile
          label="Last activity"
          value={<span className="font-sans text-sm">{formatDate(head.latestActivityAt)}</span>}
          detail={`Opened ${formatDate(head.openedAt)}`}
          onClick={() => onNavigate('Details')}
        />
      </div>

      <HydraHeadConnectionPanel headId={head.id} poll={headStagePermitsAnyAction(head)} />

      <HydraHeadWallets
        localWallet={head.LocalParticipant?.Wallet}
        localCardanoVkey={head.LocalParticipant?.cardanoVkey}
        localRole={head.LocalParticipant?.Wallet.type ?? null}
        remoteWallet={remote?.Wallet}
        remoteCardanoVkey={remote?.cardanoVkey}
        remoteRole={counterpartRole(head.LocalParticipant?.Wallet.type)}
        network={network}
        onLocalWalletClick={onLocalWalletClick}
        onRemoteWalletClick={onRemoteWalletClick}
      />
    </div>
  );
}
