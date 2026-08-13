import { useMemo, useState } from 'react';
import Head from 'next/head';
import {
  Activity,
  ChevronDown,
  ExternalLink,
  Flag,
  GitBranch,
  KeyRound,
  Layers3,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  Ticket,
  Upload,
  Wifi,
  XCircle,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { useResync } from '@/lib/hooks/useResync';
import { MainLayout } from '@/components/layout/MainLayout';
import { RefreshButton } from '@/components/RefreshButton';
import { HydraHeadErrors } from '@/components/hydra/HydraHeadErrors';
import { HydraHeadWallets } from '@/components/hydra/HydraHeadWallets';
import { HydraNotice } from '@/components/hydra/HydraNotice';
import { HydraWalletLink } from '@/components/hydra/HydraWalletLink';
import { HydraHeadTransactions } from '@/components/hydra/HydraHeadTransactions';
import { formatDuration } from '@/components/hydra/DurationPicker';
import { HydraHeadConnectionPanel } from '@/components/hydra/HydraHeadConnection';
import { HydraDetailSection } from '@/components/hydra/HydraDetailSection';
import { HydraInitDialog } from '@/components/hydra/HydraInitDialog';
import { HydraInvitesDialog } from '@/components/hydra/HydraManageDialog';
import { HydraNodeStrip } from '@/components/hydra/HydraNodeStrip';
import { HydraNodeDetailsDialog } from '@/components/hydra/HydraNodeDetailsDialog';
import { IssueHydraInviteDialog } from '@/components/hydra/IssueHydraInviteDialog';
import { RedeemHydraInviteDialog } from '@/components/hydra/RedeemHydraInviteDialog';
import type { HydraHost } from '@/lib/hooks/useHydraHosts';
import { useHydraInvites, type HydraInvite } from '@/lib/hooks/useHydraHeads';
import { useHydraHosts } from '@/lib/hooks/useHydraHosts';
import { ConnectHydraNodeDialog } from '@/components/hydra/ConnectHydraNodeDialog';
import { BackUpNodeKeysDialog } from '@/components/hydra/BackUpNodeKeysDialog';
import { HydraHeadInHeadBalance } from '@/components/hydra/HydraHeadInHeadBalance';
import { HydraHeadTopupButton } from '@/components/hydra/HydraHeadTopupButton';
import { HydraHeadWithdrawButton } from '@/components/hydra/HydraHeadWithdrawButton';
import { AnimatedPage } from '@/components/ui/animated-page';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { SearchInput } from '@/components/ui/search-input';
import { Tabs } from '@/components/ui/tabs';
import { CopyButton } from '@/components/ui/copy-button';
import { WalletLink } from '@/components/ui/wallet-link';
import {
  WalletDetailsDialog,
  type WalletWithBalance,
} from '@/components/wallets/WalletDetailsDialog';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useWalletsByVkeys } from '@/lib/queries/useWallets';
import { toPaymentSourceWalletDetails } from '@/lib/wallet-lookup';
import { cn, getExplorerUrl, shortenAddress } from '@/lib/utils';
import { HeadStatusHint } from '@/components/hydra/hydra-hints';
import { InfoHint } from '@/components/ui/info-hint';
import {
  closeHydraHead,
  commitHydraHead,
  fanoutHydraHead,
  initHydraHead,
  useHydraHeadReadiness,
  useHydraHeads,
  type HydraHead,
  type HydraHeadStatus,
  type HydraParticipant,
  type HydraRemoteParticipant,
} from '@/lib/hooks/useHydraHeads';

const statusTabs = ['All', 'Open', 'Initializing', 'Idle', 'Closed', 'Final'] as const;

type StatusTab = (typeof statusTabs)[number];
type HydraLifecycleAction = 'init' | 'commit' | 'close' | 'fanout';

type HydraLifecycleButtonConfig = {
  action: HydraLifecycleAction;
  label: string;
  disabledReason?: string;
};

type PendingLifecycleAction = {
  head: HydraHead;
  action: HydraLifecycleAction;
};

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatDate(value: string | null | undefined) {
  if (!value) return '-';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';

  return dateTimeFormatter.format(date);
}

function getStatusBadgeVariant(status: HydraHeadStatus): BadgeProps['variant'] {
  switch (status) {
    case 'Open':
      return 'success';
    case 'Initializing':
    case 'Connecting':
      return 'processing';
    case 'Closed':
    case 'FanoutPossible':
      return 'warning';
    case 'Disconnected':
      return 'destructive';
    case 'Final':
      return 'outline';
    case 'Connected':
    case 'Idle':
    default:
      return 'secondary';
  }
}

function getLifecycleDate(head: HydraHead) {
  if (head.status === 'Final') return head.finalizedAt;
  if (head.status === 'Closed' || head.status === 'FanoutPossible') return head.closedAt;
  if (head.status === 'Open') return head.openedAt;
  return head.latestActivityAt ?? head.updatedAt;
}

function matchesStatusTab(head: HydraHead, activeTab: StatusTab) {
  if (activeTab === 'All') return true;
  if (activeTab === 'Closed') return head.status === 'Closed' || head.status === 'FanoutPossible';
  return head.status === activeTab;
}

function getParticipantSummary(head: HydraHead) {
  const remoteCount = head.RemoteParticipants?.length ?? 0;
  const totalParticipants = (head.LocalParticipant ? 1 : 0) + remoteCount;
  const committedCount =
    (head.LocalParticipant?.hasCommitted ? 1 : 0) +
    (head.RemoteParticipants?.filter((participant) => participant.hasCommitted).length ?? 0);

  return {
    committedCount,
    remoteCount,
    totalParticipants,
  };
}

const lifecycleActions: Array<Omit<HydraLifecycleButtonConfig, 'disabledReason'>> = [
  // Named by what they do to the head, not by the protocol message they send.
  // "Init" and "Fanout" are hydra-node vocabulary; an operator deciding whether
  // to press one is thinking about opening, funding and settling.
  { action: 'init', label: 'Open head' },
  { action: 'commit', label: 'Fund at open' },
  { action: 'close', label: 'Close head' },
  { action: 'fanout', label: 'Settle on chain' },
];

/**
 * Actions that need this node to be answering and caught up.
 *
 * All four post something the node must build or observe, so all four are
 * gated. The API refuses them anyway; offering them regardless meant the
 * operator learned the node's state from a failed action instead of from the
 * control, having already been told in the panel directly above.
 */
function getLifecycleActionDisabledReason(
  head: HydraHead,
  action: HydraLifecycleAction,
  readiness?: { isReady: boolean; reason: string | null } | null,
) {
  if (readiness != null && !readiness.isReady) {
    return readiness.reason ?? 'The node is not ready yet.';
  }
  if (action === 'init') {
    if (!head.LocalParticipant) return 'This head has no node on your side';
    // One side opens, and it is the side that redeemed: two Inits race for the
    // same seed inputs and the loser is left waiting on a head that never
    // existed. Stated rather than hidden, so the wait looks intended.
    if (head.Invite?.role === 'Issuer')
      return 'They redeemed your invite, so they open the head. It moves on its own when they do.';
    if (head.status !== 'Idle') return `Already past this. The head is ${head.status}.`;
    return undefined;
  }

  if (action === 'commit') {
    if (!head.LocalParticipant) return 'This head has no node on your side';
    if (head.LocalParticipant.hasCommitted) return 'You have already funded this head at open';
    // The API accepts Initializing OR Open, an open head takes the same
    // deposit, which is what Add funds does. Refusing Open here forbade
    // something the service allows, and told an operator who had not yet
    // funded a head that the one control for it was gone.
    if (head.status !== 'Initializing' && head.status !== 'Open')
      return 'Only while the head is opening or open';
    return undefined;
  }

  if (action === 'close') {
    if (head.status !== 'Open') return 'Only an open head can be closed';
    return undefined;
  }

  if (head.status !== 'FanoutPossible')
    return 'Available once the head is closed and its dispute window has passed';
  return undefined;
}

function getLifecycleButtonConfigs(
  head: HydraHead,
  readiness?: { isReady: boolean; reason: string | null } | null,
): HydraLifecycleButtonConfig[] {
  return lifecycleActions.map((actionConfig) => ({
    ...actionConfig,
    disabledReason: getLifecycleActionDisabledReason(head, actionConfig.action, readiness),
  }));
}

function LifecycleActionIcon({
  action,
  isRunning,
}: {
  action: HydraLifecycleAction;
  isRunning: boolean;
}) {
  if (isRunning) {
    return <Loader2 className="h-4 w-4 animate-spin" />;
  }

  if (action === 'init') return <Play className="h-4 w-4" />;
  if (action === 'commit') return <Upload className="h-4 w-4" />;
  if (action === 'close') return <XCircle className="h-4 w-4" />;
  return <Flag className="h-4 w-4" />;
}

function getLifecycleActionConfirmCopy(head: HydraHead, action: HydraLifecycleAction) {
  const headLabel = head.headIdentifier
    ? shortenAddress(head.headIdentifier, 10)
    : shortenAddress(head.id, 10);

  if (action === 'init') {
    return {
      title: 'Confirm head init',
      description: `Initialize Hydra head ${headLabel}. This submits the opening transaction through the configured local Hydra node.`,
    };
  }

  if (action === 'commit') {
    return {
      title: 'Confirm local commit',
      description: `Commit the local participant funds into Hydra head ${headLabel}. This submits an L1 commit transaction.`,
    };
  }

  if (action === 'close') {
    return {
      title: 'Confirm head close',
      description: `Close Hydra head ${headLabel}. This starts the close flow and stops new in-head transactions.`,
    };
  }

  return {
    title: 'Confirm head fanout',
    description: `Fan out Hydra head ${headLabel}. This finalizes the head on L1 with the latest available state.`,
  };
}

function HydraLifecycleActionMenu({
  head,
  isRunning,
  onRequestLifecycle,
}: {
  head: HydraHead;
  isRunning: boolean;
  onRequestLifecycle: (head: HydraHead, action: HydraLifecycleAction) => void;
}) {
  // Only asked for a head with a node to ask about, and only polled while that
  // node is not ready, a healthy head costs one request.
  const { connection } = useHydraHeadReadiness(head.id, head.LocalParticipant != null);
  const configs = getLifecycleButtonConfigs(head, connection);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label="Open Hydra head actions"
          title="Hydra head actions"
        >
          {isRunning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <MoreHorizontal className="h-4 w-4" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {configs.map((config) => {
          const isDisabled = isRunning || Boolean(config.disabledReason);

          return (
            <DropdownMenuItem
              key={config.action}
              disabled={isDisabled}
              // No preventDefault: the menu should close on choosing an action.
              // Each one opens its own confirmation, so holding the menu open
              // just leaves it hanging behind that dialog.
              onSelect={() => onRequestLifecycle(head, config.action)}
              className={cn(config.disabledReason && 'flex-col items-start gap-0.5')}
            >
              <span className="flex items-center gap-2">
                <LifecycleActionIcon action={config.action} isRunning={isRunning} />
                <span>{config.label}</span>
              </span>
              {/* Spelled out rather than left to a tooltip. Hydra gates each
                  action to one stage, so most of this menu is greyed most of
                  the time, and hover text on a disabled item is easy to miss,
                  which makes a correctly-gated menu look broken. */}
              {config.disabledReason && (
                <span className="pl-6 text-xs font-normal text-muted-foreground">
                  {config.disabledReason}
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DetailField({
  label,
  value,
  copyValue,
  mono = false,
}: {
  label: string;
  value: string | null | undefined;
  copyValue?: string | null;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-xs font-medium uppercase text-muted-foreground">{label}</p>
      <div className="flex min-w-0 items-center gap-2">
        <p className={cn('truncate text-sm', mono && 'font-mono')}>{value || '-'}</p>
        {copyValue && <CopyButton value={copyValue} className="h-7 w-7 shrink-0" />}
      </div>
    </div>
  );
}

/**
 * One lifecycle transaction, or why there isn't one yet.
 *
 * These arrive in order, init, then close, then fanout, so on any live head
 * most of them are legitimately absent. Saying "no transaction hash recorded"
 * for a step that simply has not happened reads as missing data, which is how a
 * perfectly healthy open head came to look broken.
 */
function TransactionHashRow({
  label,
  hash,
  network,
  pendingReason,
}: {
  label: string;
  hash: string | null | undefined;
  network: string;
  /** What to say instead when the step has not happened yet. */
  pendingReason?: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/10 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase text-muted-foreground">{label}</p>
        {hash ? (
          <a
            href={getExplorerUrl(hash, network, 'transaction')}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 block truncate font-mono text-sm text-primary hover:underline"
          >
            {hash}
          </a>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            {pendingReason ?? 'No transaction hash recorded'}
          </p>
        )}
      </div>
      {hash && (
        <div className="flex shrink-0 items-center gap-1">
          <CopyButton value={hash} className="h-8 w-8" />
          <Button type="button" variant="outline" size="icon" asChild className="h-8 w-8">
            <a
              href={getExplorerUrl(hash, network, 'transaction')}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${label} on Cardanoscan`}
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        </div>
      )}
    </div>
  );
}

function ParticipantCard({
  title,
  participant,
  network,
  onWalletClick,
}: {
  title: string;
  participant: HydraParticipant | HydraRemoteParticipant | null | undefined;
  network: string;
  onWalletClick?: () => void;
}) {
  if (!participant) {
    return (
      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        No {title.toLowerCase()} participant saved.
      </div>
    );
  }

  const verificationKeyId =
    'hydraVerificationKeyId' in participant ? participant.hydraVerificationKeyId : null;

  return (
    <div className="space-y-4 rounded-md border bg-muted/10 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">
            Created {formatDate(participant.createdAt)}
          </p>
        </div>
        <Badge variant={participant.hasCommitted ? 'success' : 'secondary'}>
          {participant.hasCommitted ? 'Committed' : 'Not committed'}
        </Badge>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <p className="text-xs text-muted-foreground">Wallet</p>
          <WalletLink
            address={participant.Wallet.walletAddress}
            vkey={participant.Wallet.walletVkey}
            network={network}
            shorten={10}
            onInternalClick={onWalletClick}
          />
        </div>
        {verificationKeyId && (
          <DetailField
            label="Hydra verification key"
            value={verificationKeyId}
            copyValue={verificationKeyId}
            mono
          />
        )}
        {'advertise' in participant ? (
          <DetailField
            label="Peer address"
            value={participant.advertise}
            copyValue={participant.advertise}
            mono
          />
        ) : (
          <>
            <DetailField
              label="Node WS"
              value={participant.nodeUrl}
              copyValue={participant.nodeUrl}
              mono
            />
            <DetailField
              label="Node HTTP"
              value={participant.nodeHttpUrl}
              copyValue={participant.nodeHttpUrl}
              mono
            />
          </>
        )}
      </div>

      <TransactionHashRow
        label={`${title} commit tx`}
        hash={participant.commitTxHash}
        network={network}
        // A head can open with an empty commit, so "never committed" is a normal
        // resting state rather than a gap in the record.
        pendingReason="Nothing was committed at open. Add funds to deposit into the head."
      />
    </div>
  );
}

function HydraHeadDetailsDialog({
  head,
  open,
  onOpenChange,
  network,
  isLifecycleActionRunning,
  onRequestLifecycle,
  onBackUpKeys,
}: {
  head: HydraHead | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  network: string;
  isLifecycleActionRunning: boolean;
  onRequestLifecycle: (head: HydraHead, action: HydraLifecycleAction) => void;
  onBackUpKeys: (head: HydraHead) => void;
}) {
  const [selectedWalletForDetails, setSelectedWalletForDetails] =
    useState<WalletWithBalance | null>(null);
  const remoteWallet = head?.RemoteParticipants?.[0]?.Wallet;
  const remoteWalletVkeys = useMemo(
    () => head?.RemoteParticipants?.map((participant) => participant.Wallet.walletVkey) ?? [],
    [head],
  );
  const internalWallets = useWalletsByVkeys(remoteWalletVkeys);
  const localWalletForDetails = useMemo<WalletWithBalance | null>(() => {
    const participant = head?.LocalParticipant;
    if (!participant) return null;

    return {
      id: participant.walletId,
      walletVkey: participant.Wallet.walletVkey,
      walletAddress: participant.Wallet.walletAddress,
      collectionAddress: participant.Wallet.collectionAddress,
      note: participant.Wallet.note,
      type: participant.Wallet.type,
      balance: '0',
      usdcxBalance: '0',
    };
  }, [head]);
  const remoteWalletForDetails = remoteWallet
    ? internalWallets.get(remoteWallet.walletVkey)
    : undefined;

  if (!head) {
    return null;
  }

  const participantSummary = getParticipantSummary(head);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setSelectedWalletForDetails(null);
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="max-w-4xl max-h-[90vh] overflow-y-auto"
        isPushedBack={!!selectedWalletForDetails}
      >
        <DialogHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle>Hydra head details</DialogTitle>
                <Badge variant={getStatusBadgeVariant(head.status)}>{head.status}</Badge>
                <HeadStatusHint />
                {!head.isEnabled && <Badge variant="outline">Disabled</Badge>}
              </div>
              <DialogDescription>
                {head.headIdentifier
                  ? shortenAddress(head.headIdentifier, 10)
                  : shortenAddress(head.id, 10)}
              </DialogDescription>
            </div>
            <HydraLifecycleActionMenu
              head={head}
              isRunning={isLifecycleActionRunning}
              onRequestLifecycle={onRequestLifecycle}
            />
          </div>
        </DialogHeader>

        {/* What is read every visit stays open; reference material collapses.
            The wallets lead, because which two wallets a head is between is
            what decides whether a payment can use it at all. */}
        <div className="space-y-4">
          <HydraHeadWallets
            localWallet={head.LocalParticipant?.Wallet}
            localCardanoVkey={head.LocalParticipant?.cardanoVkey}
            remoteWallet={remoteWallet}
            remoteCardanoVkey={head.RemoteParticipants?.[0]?.cardanoVkey}
            network={network}
            onLocalWalletClick={
              localWalletForDetails
                ? () => setSelectedWalletForDetails(localWalletForDetails)
                : undefined
            }
            onRemoteWalletClick={
              remoteWalletForDetails
                ? () =>
                    setSelectedWalletForDetails(
                      toPaymentSourceWalletDetails(remoteWalletForDetails),
                    )
                : undefined
            }
          />

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
              <p className="font-medium">
                This node&apos;s signing keys have never been backed up.
              </p>
              <p>They can be shown once, then the service seals them.</p>
            </HydraNotice>
          )}

          <HydraHeadConnectionPanel headId={head.id} />

          <HydraHeadInHeadBalance
            headId={head.id}
            isOpen={head.status === 'Open'}
            network={network}
          />

          <HydraHeadTopupButton headId={head.id} isOpen={head.status === 'Open'} />

          <HydraHeadWithdrawButton headId={head.id} isOpen={head.status === 'Open'} />

          {/* Open whenever there are any. The section only renders when the count
              is non-zero, so collapsing it by default meant the card advertised
              "2 errors" while the details underneath looked empty, which reads as
              though something had cleared them. */}
          {(head._count?.Errors ?? 0) > 0 && (
            <HydraDetailSection
              title="Errors"
              summary={`${head._count?.Errors ?? 0} recorded`}
              defaultOpen
            >
              <HydraHeadErrors
                headId={head.id}
                count={head._count?.Errors ?? 0}
                showHeading={false}
              />
            </HydraDetailSection>
          )}

          <HydraDetailSection
            title="Transactions"
            summary={head.initTxHash ? 'Opened' : 'Not opened yet'}
            defaultOpen={head.status === 'Open'}
          >
            <HydraHeadTransactions headId={head.id} network={network} />

            {/* The three on-chain steps, behind one more click. Two of them are
                empty for the whole life of a healthy open head, and printing
                "nothing to close" as a full-height card on every visit gave the
                most-read section of the dialog to its least-read content. */}
            <HydraDetailSection
              title="Opening and closing"
              summary={head.fanoutTxHash ? 'Settled' : head.closeTxHash ? 'Closing' : 'Open'}
            >
              <TransactionHashRow
                label="Initial tx"
                hash={head.initTxHash}
                network={network}
                pendingReason="Not opened yet"
              />
              <TransactionHashRow
                label="Close tx"
                hash={head.closeTxHash}
                network={network}
                pendingReason={
                  head.status === 'Closed' || head.status === 'FanoutPossible'
                    ? 'Closing, hash not observed yet'
                    : 'Still open, nothing to close'
                }
              />
              <TransactionHashRow
                label="Fanout tx"
                hash={head.fanoutTxHash}
                network={network}
                pendingReason={
                  head.status === 'FanoutPossible'
                    ? 'Ready to fan out'
                    : 'Available once the head is closed and its dispute window has passed'
                }
              />
            </HydraDetailSection>
          </HydraDetailSection>

          <HydraDetailSection
            title="Participants"
            summary={`${participantSummary.totalParticipants} total, ${participantSummary.committedCount} committed`}
          >
            <ParticipantCard
              title="Local participant"
              participant={head.LocalParticipant}
              network={network}
              onWalletClick={
                localWalletForDetails
                  ? () => setSelectedWalletForDetails(localWalletForDetails)
                  : undefined
              }
            />
            {(head.RemoteParticipants ?? []).length > 0 ? (
              (head.RemoteParticipants ?? []).map((participant, index) => {
                const internalWallet = internalWallets.get(participant.Wallet.walletVkey);
                return (
                  <ParticipantCard
                    key={participant.id}
                    title={`Remote participant ${index + 1}`}
                    participant={participant}
                    network={network}
                    onWalletClick={
                      internalWallet
                        ? () =>
                            setSelectedWalletForDetails(
                              toPaymentSourceWalletDetails(internalWallet),
                            )
                        : undefined
                    }
                  />
                );
              })
            ) : (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                No remote participants saved.
              </div>
            )}
          </HydraDetailSection>

          <HydraDetailSection title="Identifiers and timeline" summary={formatDate(head.createdAt)}>
            <div className="grid gap-4 md:grid-cols-3">
              <DetailField
                label="Head identifier"
                value={head.headIdentifier ?? head.id}
                copyValue={head.headIdentifier ?? head.id}
                mono
              />
              <DetailField label="Snapshot" value={head.latestSnapshotNumber} />
              <DetailField
                label="Dispute window"
                value={formatDuration(Number(head.contestationPeriod))}
              />
              <DetailField label="Transactions" value={String(head._count?.Transactions ?? 0)} />
              <DetailField label="Created" value={formatDate(head.createdAt)} />
              <DetailField label="Updated" value={formatDate(head.updatedAt)} />
              <DetailField label="Latest activity" value={formatDate(head.latestActivityAt)} />
              <DetailField label="Opened" value={formatDate(head.openedAt)} />
              <DetailField label="Closed" value={formatDate(head.closedAt)} />
              <DetailField label="Finalized" value={formatDate(head.finalizedAt)} />
            </div>
          </HydraDetailSection>
        </div>
      </DialogContent>
      <WalletDetailsDialog
        isOpen={!!selectedWalletForDetails}
        onClose={() => setSelectedWalletForDetails(null)}
        wallet={selectedWalletForDetails}
        isChild
      />
    </Dialog>
  );
}

function HydraHeadTable({
  heads,
  pendingInvites,
  hostNames,
  isLoading,
  hasActiveFilters,
  runningLifecycleHeadId,
  onOpenHead,
  onRequestLifecycle,
  onManageInvites,
}: {
  heads: HydraHead[];
  /**
   * Invites nobody has redeemed yet, listed as the heads they are becoming.
   *
   * Issuing one already provisions the node and reserves its peer port, so the
   * head's resources exist and only the counterparty is missing, which makes
   * "awaiting counterparty" the first stage of a head's life rather than a
   * separate kind of object. Showing them apart was what made invites look like
   * a third concept to learn.
   */
  pendingInvites: HydraInvite[];
  hostNames: Record<string, string>;
  isLoading: boolean;
  hasActiveFilters: boolean;
  runningLifecycleHeadId: string | null;
  onOpenHead: (head: HydraHead) => void;
  onRequestLifecycle: (head: HydraHead, action: HydraLifecycleAction) => void;
  onManageInvites: () => void;
}) {
  if (isLoading && heads.length === 0) {
    return (
      <div className="rounded-lg border p-8">
        <div className="space-y-3 animate-pulse">
          <div className="h-4 w-44 rounded bg-muted" />
          <div className="h-12 rounded bg-muted/70" />
          <div className="h-12 rounded bg-muted/70" />
          <div className="h-12 rounded bg-muted/70" />
        </div>
      </div>
    );
  }

  if (heads.length === 0) {
    return (
      <div className="rounded-lg border">
        <EmptyState
          icon={hasActiveFilters ? 'search' : 'inbox'}
          title={hasActiveFilters ? 'No Hydra heads match these filters' : 'No Hydra heads yet'}
          description={
            hasActiveFilters
              ? 'Try another status tab or search term.'
              : 'Hydra heads will appear here once they are created through the Hydra API.'
          }
        />
      </div>
    );
  }

  return (
    <div className="rounded-lg border overflow-x-auto">
      <table className="w-full min-w-[720px]">
        <thead className="bg-muted/30 dark:bg-muted/15">
          <tr className="border-b">
            <th scope="col" className="p-4 pl-6 text-left text-sm font-medium">
              Head
            </th>
            <th scope="col" className="p-4 text-left text-sm font-medium">
              Status
            </th>
            <th scope="col" className="p-4 text-left text-sm font-medium">
              Node
            </th>
            <th scope="col" className="p-4 text-left text-sm font-medium">
              Counterparty
            </th>
            <th scope="col" className="p-4 text-left text-sm font-medium">
              Activity
            </th>
            <th scope="col" className="p-4 pr-6 text-right text-sm font-medium">
              Action
            </th>
          </tr>
        </thead>
        <tbody>
          {/* Listed first because they are the newest thing an operator did,
              and because reading them as heads-in-waiting is the whole point:
              the lifecycle runs awaiting → idle → initializing → open, not
              "invites" beside "heads". */}
          {pendingInvites.map((invite) => (
            <tr key={invite.id} className="border-b bg-muted/20">
              <td className="p-4 pl-6">
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-sm text-muted-foreground">
                    {invite.nonce.slice(0, 12)}…
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Invited {formatDate(invite.createdAt)}
                  </span>
                </div>
              </td>
              <td className="p-4">
                <Badge variant="outline" className="w-fit">
                  Awaiting counterparty
                </Badge>
              </td>
              <td className="p-4">
                <span className="text-sm">{hostNames[invite.hydraHostId] ?? '—'}</span>
              </td>
              <td className="p-4 text-sm text-muted-foreground" colSpan={2}>
                Its node and peer port are reserved. It becomes a head when the counterparty redeems
                it, or expires {formatDate(invite.expiresAt)}.
              </td>
              <td className="p-4 pr-6 text-right">
                <Button type="button" variant="ghost" size="sm" onClick={onManageInvites}>
                  Manage
                </Button>
              </td>
            </tr>
          ))}
          {heads.map((head, index) => {
            const participantSummary = getParticipantSummary(head);
            const lifecycleDate = getLifecycleDate(head);

            return (
              <tr
                key={head.id}
                role="button"
                tabIndex={0}
                aria-label={`Open details for Hydra head ${head.headIdentifier ?? head.id}`}
                className="group border-b last:border-0 align-top animate-fade-in opacity-0 cursor-pointer transition-colors hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                style={{ animationDelay: `${Math.min(index, 9) * 35}ms` }}
                onClick={() => onOpenHead(head)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpenHead(head);
                  }
                }}
              >
                <td className="p-4 pl-6">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm text-primary underline-offset-4 group-hover:underline">
                        {head.headIdentifier
                          ? shortenAddress(head.headIdentifier, 8)
                          : shortenAddress(head.id, 8)}
                      </span>
                      <CopyButton value={head.headIdentifier ?? head.id} className="h-7 w-7" />
                    </div>
                    <span className="text-xs text-muted-foreground">
                      Created {formatDate(head.createdAt)}
                    </span>
                    {!head.isEnabled && (
                      <Badge variant="outline" className="w-fit">
                        Disabled
                      </Badge>
                    )}
                  </div>
                </td>
                <td className="p-4">
                  <div className="flex flex-col gap-2">
                    <Badge variant={getStatusBadgeVariant(head.status)} className="w-fit">
                      {head.status}
                    </Badge>
                    {head._count && head._count.Errors > 0 && (
                      // Muted once the head has moved past Idle: the errors are
                      // then history, a failed Init that later succeeded, say,
                      // and colouring them like a live alarm makes a healthy
                      // head read as broken.
                      <span
                        className={cn(
                          'text-xs',
                          head.status === 'Idle' ? 'text-destructive' : 'text-muted-foreground',
                        )}
                      >
                        {head._count.Errors} {head.status === 'Idle' ? '' : 'past '}error
                        {head._count.Errors === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                </td>
                <td className="p-4">
                  {/* A head runs on exactly one node for its whole life and
                      cannot be moved, so this is a fact about the head. */}
                  <span className="text-sm">
                    {hostNames[head.LocalParticipant?.hydraHostId ?? ''] ?? '—'}
                  </span>
                </td>
                <td className="p-4">
                  {/* Who the head is with, rather than the id of the join row
                      that records it. The address is what an operator can match
                      against an agent's seller wallet. */}
                  <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                    {head.RemoteParticipants?.[0]?.Wallet?.walletAddress ? (
                      <>
                        <span>
                          {shortenAddress(head.RemoteParticipants[0].Wallet.walletAddress, 8)}
                        </span>
                        <CopyButton
                          value={head.RemoteParticipants[0].Wallet.walletAddress}
                          className="h-7 w-7"
                        />
                      </>
                    ) : (
                      <span>Not recorded</span>
                    )}
                  </div>
                </td>
                <td className="p-4 pr-6">
                  <div className="flex flex-col gap-1 text-sm">
                    <span>{formatDate(lifecycleDate)}</span>
                    {head.contestationDeadline && (
                      <span className="text-xs text-muted-foreground">
                        Settles after {formatDate(head.contestationDeadline)}
                      </span>
                    )}
                  </div>
                </td>
                <td className="p-4 pr-6">
                  <div
                    className="flex justify-end"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <HydraLifecycleActionMenu
                      head={head}
                      isRunning={runningLifecycleHeadId === head.id}
                      onRequestLifecycle={onRequestLifecycle}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function HydraHeadsPage() {
  const { apiClient, network } = useAppContext();
  const resync = useResync();
  const { heads, isLoading, isFetching, refetch } = useHydraHeads();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<StatusTab>('All');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isConnectNodeOpen, setIsConnectNodeOpen] = useState(false);
  const [isInvitesOpen, setIsInvitesOpen] = useState(false);
  const [isIssueInviteOpen, setIsIssueInviteOpen] = useState(false);
  const [isRedeemInviteOpen, setIsRedeemInviteOpen] = useState(false);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [detailsHost, setDetailsHost] = useState<HydraHost | null>(null);
  const { invites } = useHydraInvites();
  const inviteCount = invites.length;
  // Read here rather than through the nodes card: the card now lives in a
  // dialog, so leaving the count to it reported zero until the operator happened
  // to open one, and the page gates its primary action on this.
  const { hosts } = useHydraHosts(
    network === 'Preprod' || network === 'Mainnet' ? network : undefined,
  );
  const [backUpKeysParticipantId, setBackUpKeysParticipantId] = useState<string | null>(null);
  const [selectedHeadId, setSelectedHeadId] = useState<string | null>(null);
  const [runningLifecycleHeadId, setRunningLifecycleHeadId] = useState<string | null>(null);
  /**
   * The head whose close was refused for still holding escrows, and the reason.
   *
   * Held as state rather than answered inline: the API's refusal names the
   * counts and what closing does to them, and that wording is what the operator
   * has to agree to. Re-writing it as a generic warning would drop the only part
   * that makes the decision informed.
   */
  const [pendingEscrowClose, setPendingEscrowClose] = useState<{
    head: HydraHead;
    reason: string;
  } | null>(null);
  const [pendingLifecycleAction, setPendingLifecycleAction] =
    useState<PendingLifecycleAction | null>(null);

  const stats = useMemo(() => {
    const openHeads = heads.filter((head) => head.status === 'Open').length;
    const enabledHeads = heads.filter((head) => head.isEnabled).length;
    const activeHeads = heads.filter((head) =>
      ['Connected', 'Connecting', 'Initializing', 'Open'].includes(head.status),
    ).length;

    return {
      activeHeads,
      enabledHeads,
      openHeads,
      totalHeads: heads.length,
    };
  }, [heads]);

  const tabs = useMemo(
    () =>
      statusTabs.map((tab) => ({
        name: tab,
        count: heads.filter((head) => matchesStatusTab(head, tab)).length,
        variant: tab === 'Open' && stats.openHeads > 0 ? ('alert' as const) : undefined,
      })),
    [heads, stats.openHeads],
  );

  const filteredHeads = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return heads.filter((head) => {
      if (!matchesStatusTab(head, activeTab)) {
        return false;
      }

      // Selecting a node chip narrows the table to what that node runs, which
      // is the "heads inside their node" view without a second layout.
      if (selectedHostId !== null && head.LocalParticipant?.hydraHostId !== selectedHostId) {
        return false;
      }

      if (!query) {
        return true;
      }

      const localParticipant = head.LocalParticipant;
      const remoteParticipants = head.RemoteParticipants ?? [];
      const searchableValues = [
        head.id,
        head.hydraRelationId,
        head.headIdentifier ?? '',
        head.status,
        localParticipant?.walletId ?? '',
        localParticipant?.Wallet.walletAddress ?? '',
        localParticipant?.nodeUrl ?? '',
        localParticipant?.nodeHttpUrl ?? '',
        ...remoteParticipants.flatMap((participant) => [
          participant.walletId,
          participant.Wallet.walletAddress,
          participant.advertise,
        ]),
      ];

      return searchableValues.some((value) => value.toLowerCase().includes(query));
    });
  }, [activeTab, heads, searchQuery, selectedHostId]);

  const hasActiveFilters =
    searchQuery.trim().length > 0 || activeTab !== 'All' || selectedHostId !== null;
  const selectedHead = useMemo(
    () => heads.find((head) => head.id === selectedHeadId) ?? null,
    [heads, selectedHeadId],
  );
  // A head has to run somewhere, so the action is unavailable until a node is
  // connected, which is the step above it on this page.
  const connectedNodeCount = hosts.length;
  // A head runs on exactly one node for its whole life, so this is a property of
  // the head rather than a join: the chip can say what it is carrying.
  const headCountsByHost = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const head of heads) {
      const hostId = head.LocalParticipant?.hydraHostId;
      if (hostId) counts[hostId] = (counts[hostId] ?? 0) + 1;
    }
    return counts;
  }, [heads]);
  const hasConnectedNode = connectedNodeCount > 0;
  const hostNames = useMemo(
    () => Object.fromEntries(hosts.map((host) => [host.id, host.name])),
    [hosts],
  );
  // Only ones we issued and nobody has taken: a redeemed invite already has a
  // head of its own in the list below, and showing both would double-count it.
  const pendingInvites = useMemo(
    () =>
      invites.filter(
        (invite) =>
          invite.role === 'Issuer' &&
          invite.status === 'Issued' &&
          (selectedHostId === null || invite.hydraHostId === selectedHostId),
      ),
    [invites, selectedHostId],
  );
  const pendingLifecycleCopy = pendingLifecycleAction
    ? getLifecycleActionConfirmCopy(pendingLifecycleAction.head, pendingLifecycleAction.action)
    : null;

  /** Close the head having accepted that its escrows move to L1. */
  const handleConfirmEscrowClose = async () => {
    const pending = pendingEscrowClose;
    if (!pending) return;
    setRunningLifecycleHeadId(pending.head.id);
    try {
      await closeHydraHead(apiClient, { headId: pending.head.id, acknowledgeActiveEscrows: true });
      toast.success('Hydra head close started');
      await resync('hydra');
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRunningLifecycleHeadId(null);
      setPendingEscrowClose(null);
    }
  };

  const handleRunLifecycleAction = async (head: HydraHead, action: HydraLifecycleAction) => {
    setRunningLifecycleHeadId(head.id);
    try {
      if (action === 'init') {
        await initHydraHead(apiClient, { headId: head.id });
        toast.success('Hydra head init started');
      } else if (action === 'commit') {
        await commitHydraHead(apiClient, { headId: head.id });
        toast.success('Local Hydra commit submitted');
      } else if (action === 'close') {
        try {
          await closeHydraHead(apiClient, { headId: head.id });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          // Anything else is a real failure: this call no longer toasts for
          // itself, so saying so here is what keeps it from failing silently.
          if (!reason.includes('fanned out to L1')) {
            toast.error(reason);
            return;
          }
          // Ask, with the API's own wording. Answered in its own dialog rather
          // than here, so the operator reads the counts before agreeing.
          setPendingEscrowClose({ head, reason });
          return;
        }
        toast.success('Hydra head close started');
      } else {
        await fanoutHydraHead(apiClient, { headId: head.id });
        toast.success('Hydra head fanout started');
      }

      // Everything about this head just changed: its status, its participants,
      // its transactions and its balance. Refetching only the list left the
      // dialog the operator is looking at describing the previous state.
      await resync('hydra');
      await refetch();
    } finally {
      setRunningLifecycleHeadId(null);
      setPendingLifecycleAction(null);
    }
  };

  const handleConfirmLifecycleAction = () => {
    if (!pendingLifecycleAction) {
      return;
    }

    void handleRunLifecycleAction(pendingLifecycleAction.head, pendingLifecycleAction.action);
  };

  return (
    <MainLayout>
      <Head>
        <title>Hydra Heads | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">Hydra Heads</h1>
                <Badge variant="outline">Cardano L2</Badge>
              </div>
              {/* Two objects, said once. Operators kept asking what the
                  difference was, and an invite looked like a third thing to
                  learn rather than the first stage of a head's life. */}
              {/* One sentence on screen. The rest is the same explanation, kept
                  for the first visit and out of the way on every visit after. */}
              <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                Instant payments between two wallets, off chain.
                <InfoHint label="relationship between nodes and heads">
                  <p>
                    A <span className="text-foreground">node</span> is a machine you connect once. A{' '}
                    <span className="text-foreground">head</span> is one channel with one
                    counterparty, and runs on exactly one node for its whole life.
                  </p>
                  <p>
                    Inviting someone opens a head. It appears below as awaiting counterparty until
                    they accept.
                  </p>
                </InfoHint>
              </p>
            </div>

            <RefreshButton onRefresh={() => void refetch()} isRefreshing={isFetching} />
          </div>

          <HydraNodeStrip
            hosts={hosts}
            headCounts={headCountsByHost}
            selectedHostId={selectedHostId}
            onSelectHost={setSelectedHostId}
            onOpenHost={setDetailsHost}
            onAddNode={() => setIsConnectNodeOpen(true)}
          />

          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(tab) => setActiveTab(tab as StatusTab)}
          />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <SearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search head ID, relation, participant wallet, or node..."
              className="max-w-md"
              isLoading={isFetching && !isLoading}
            />
            {/* The head action sits with the list it adds to, beside the
                search. Opening a head is one action with two ways in, so it is
                one button with a menu rather than two competing buttons. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  disabled={!hasConnectedNode}
                  title={
                    hasConnectedNode
                      ? undefined
                      : 'Connect a node first. A head has to run somewhere.'
                  }
                >
                  <Plus className="h-4 w-4" />
                  New head
                  <ChevronDown className="h-4 w-4 opacity-70" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuItem onClick={() => setIsIssueInviteOpen(true)}>
                  <Ticket className="h-4 w-4" />
                  Invite someone
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setIsRedeemInviteOpen(true)}>
                  <Ticket className="h-4 w-4" />
                  Redeem an invite
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setIsInvitesOpen(true)}>
                  Manage invites{inviteCount > 0 ? ` (${inviteCount})` : ''}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <HydraHeadTable
            heads={filteredHeads}
            pendingInvites={pendingInvites}
            hostNames={hostNames}
            onManageInvites={() => setIsInvitesOpen(true)}
            isLoading={isLoading}
            hasActiveFilters={hasActiveFilters}
            runningLifecycleHeadId={runningLifecycleHeadId}
            onOpenHead={(head) => setSelectedHeadId(head.id)}
            onRequestLifecycle={(head, action) => setPendingLifecycleAction({ head, action })}
          />
        </div>
      </AnimatedPage>
      <HydraHeadDetailsDialog
        head={selectedHead}
        open={Boolean(selectedHead)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedHeadId(null);
          }
        }}
        network={network}
        isLifecycleActionRunning={selectedHead ? runningLifecycleHeadId === selectedHead.id : false}
        onRequestLifecycle={(head, action) => setPendingLifecycleAction({ head, action })}
        onBackUpKeys={(head) => setBackUpKeysParticipantId(head.LocalParticipant?.id ?? null)}
      />
      {/* Init has a precondition the others do not: the node must be able to pay
          for the transaction it is about to post. */}
      <HydraInitDialog
        open={pendingLifecycleAction?.action === 'init'}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingLifecycleAction(null);
        }}
        localParticipantId={pendingLifecycleAction?.head.LocalParticipant?.id ?? null}
        onConfirm={handleConfirmLifecycleAction}
        isRunning={
          pendingLifecycleAction ? runningLifecycleHeadId === pendingLifecycleAction.head.id : false
        }
      />
      {/* Not a refusal — closing with live escrows is offered and always was.
          The dialog exists to price the choice: settling in the head takes
          about a second per escrow and costs nothing, and closing swaps that
          for the contestation period plus an L1 settlement each. */}
      <ConfirmDialog
        open={Boolean(pendingEscrowClose)}
        onClose={() => setPendingEscrowClose(null)}
        title="Closing now will take a while"
        description={pendingEscrowClose?.reason ?? ''}
        confirmLabel="Close anyway"
        loadingNote="Posted to the node. This carries on without the window, and the head's status updates on its own — you can close this."
        onConfirm={handleConfirmEscrowClose}
        isLoading={
          pendingEscrowClose ? runningLifecycleHeadId === pendingEscrowClose.head.id : false
        }
      />

      <ConfirmDialog
        open={Boolean(pendingLifecycleAction) && pendingLifecycleAction?.action !== 'init'}
        onClose={() => setPendingLifecycleAction(null)}
        title={pendingLifecycleCopy?.title ?? 'Confirm Hydra action'}
        description={
          pendingLifecycleCopy?.description ??
          'Confirm that you want to run this Hydra head lifecycle action.'
        }
        onConfirm={handleConfirmLifecycleAction}
        isLoading={
          pendingLifecycleAction ? runningLifecycleHeadId === pendingLifecycleAction.head.id : false
        }
        loadingNote="Posted to the node. This carries on without the window, and the head's status updates on its own — you can close this."
      />
      <BackUpNodeKeysDialog
        open={backUpKeysParticipantId !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setBackUpKeysParticipantId(null);
        }}
        participantId={backUpKeysParticipantId}
        onDone={() => void refetch()}
      />
      <HydraInvitesDialog
        open={isInvitesOpen}
        onOpenChange={setIsInvitesOpen}
        hasConnectedNode={hasConnectedNode}
      />
      <HydraNodeDetailsDialog
        host={detailsHost}
        open={detailsHost !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDetailsHost(null);
        }}
      />
      <IssueHydraInviteDialog
        open={isIssueInviteOpen}
        onOpenChange={setIsIssueInviteOpen}
        onIssued={() => void refetch()}
      />
      <RedeemHydraInviteDialog
        open={isRedeemInviteOpen}
        onOpenChange={setIsRedeemInviteOpen}
        onRedeemed={() => void refetch()}
      />
      <ConnectHydraNodeDialog
        open={isConnectNodeOpen}
        onOpenChange={setIsConnectNodeOpen}
        onConnected={() => void refetch()}
      />
    </MainLayout>
  );
}
