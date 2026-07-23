import { useMemo, useState } from 'react';
import Head from 'next/head';
import {
  Activity,
  ExternalLink,
  Flag,
  GitBranch,
  Layers3,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  Upload,
  Wifi,
  XCircle,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { MainLayout } from '@/components/layout/MainLayout';
import { RefreshButton } from '@/components/RefreshButton';
import { AddHydraHeadDialog } from '@/components/hydra/AddHydraHeadDialog';
import { HydraHeadInHeadBalance } from '@/components/hydra/HydraHeadInHeadBalance';
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { SearchInput } from '@/components/ui/search-input';
import { Tabs } from '@/components/ui/tabs';
import { CopyButton } from '@/components/ui/copy-button';
import { useAppContext } from '@/lib/contexts/AppContext';
import { cn, getExplorerUrl, shortenAddress } from '@/lib/utils';
import {
  checkHydraNode,
  closeHydraHead,
  commitHydraHead,
  fanoutHydraHead,
  initHydraHead,
  useHydraHeads,
  type HydraHead,
  type HydraHeadStatus,
  type HydraNodeCheckResult,
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
  { action: 'init', label: 'Init' },
  { action: 'commit', label: 'Commit local' },
  { action: 'close', label: 'Close head' },
  { action: 'fanout', label: 'Fanout' },
];

function getLifecycleActionDisabledReason(head: HydraHead, action: HydraLifecycleAction) {
  if (action === 'init') {
    if (!head.LocalParticipant) return 'No local participant saved';
    if (head.status !== 'Idle') return 'Available only while the head is idle';
    return undefined;
  }

  if (action === 'commit') {
    if (!head.LocalParticipant) return 'No local participant saved';
    if (head.LocalParticipant.hasCommitted) return 'Local participant already committed';
    if (head.status !== 'Initializing') return 'Available only while the head is initializing';
    return undefined;
  }

  if (action === 'close') {
    if (head.status !== 'Open') return 'Available only while the head is open';
    return undefined;
  }

  if (head.status !== 'FanoutPossible') return 'Available only when fanout is possible';
  return undefined;
}

function getLifecycleButtonConfigs(head: HydraHead): HydraLifecycleButtonConfig[] {
  return lifecycleActions.map((actionConfig) => ({
    ...actionConfig,
    disabledReason: getLifecycleActionDisabledReason(head, actionConfig.action),
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
  const configs = getLifecycleButtonConfigs(head);

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
              title={config.disabledReason}
              onSelect={(event) => {
                event.preventDefault();
                onRequestLifecycle(head, config.action);
              }}
            >
              <LifecycleActionIcon action={config.action} isRunning={isRunning} />
              <span>{config.label}</span>
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

function TransactionHashRow({
  label,
  hash,
  network,
}: {
  label: string;
  hash: string | null | undefined;
  network: string;
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
          <p className="mt-1 text-sm text-muted-foreground">No transaction hash recorded</p>
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
}: {
  title: string;
  participant: HydraParticipant | HydraRemoteParticipant | null | undefined;
  network: string;
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
        <DetailField
          label="Wallet"
          value={participant.walletId}
          copyValue={participant.walletId}
          mono
        />
        {verificationKeyId && (
          <DetailField
            label="Hydra verification key"
            value={verificationKeyId}
            copyValue={verificationKeyId}
            mono
          />
        )}
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
      </div>

      <TransactionHashRow
        label={`${title} commit tx`}
        hash={participant.commitTxHash}
        network={network}
      />
    </div>
  );
}

function HydraNodeCheckPanel({
  head,
  nodeCheck,
  isCheckingNode,
  onCheckNode,
}: {
  head: HydraHead;
  nodeCheck: HydraNodeCheckResult | undefined;
  isCheckingNode: boolean;
  onCheckNode: (head: HydraHead) => void;
}) {
  const localParticipant = head.LocalParticipant;

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="font-medium">Node check</h3>
          <p className="text-sm text-muted-foreground">
            Checks the local participant node HTTP API and websocket reachability.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={!localParticipant || isCheckingNode}
          onClick={() => onCheckNode(head)}
        >
          {isCheckingNode ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Wifi className="h-4 w-4" />
          )}
          Check
        </Button>
      </div>

      {!localParticipant ? (
        <p className="text-sm text-muted-foreground">
          No local participant is saved for this head.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <DetailField
            label="Node WS"
            value={localParticipant.nodeUrl}
            copyValue={localParticipant.nodeUrl}
            mono
          />
          <DetailField
            label="Node HTTP"
            value={localParticipant.nodeHttpUrl}
            copyValue={localParticipant.nodeHttpUrl}
            mono
          />
        </div>
      )}

      {nodeCheck && (
        <div className="grid gap-3 rounded-md bg-muted/30 p-3 md:grid-cols-4">
          <div>
            <p className="text-xs font-medium uppercase text-muted-foreground">Reachability</p>
            <Badge variant={nodeCheck.reachable ? 'success' : 'destructive'} className="mt-1 w-fit">
              {nodeCheck.reachable ? 'Reachable' : 'Unreachable'}
            </Badge>
          </div>
          <DetailField
            label="HTTP"
            value={nodeCheck.httpStatus ? String(nodeCheck.httpStatus) : '-'}
          />
          <DetailField
            label="Websocket"
            value={nodeCheck.websocketReachable ? 'OK' : 'Unchecked'}
          />
          <DetailField label="Status" value={nodeCheck.status ?? '-'} />
          <div className="md:col-span-4">
            <p className="text-xs text-muted-foreground">
              Checked {formatDate(nodeCheck.checkedAt)}
              {nodeCheck.error ? ` - ${nodeCheck.error}` : ''}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function HydraHeadDetailsDialog({
  head,
  open,
  onOpenChange,
  network,
  nodeCheck,
  isCheckingNode,
  isLifecycleActionRunning,
  onCheckNode,
  onRequestLifecycle,
}: {
  head: HydraHead | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  network: string;
  nodeCheck: HydraNodeCheckResult | undefined;
  isCheckingNode: boolean;
  isLifecycleActionRunning: boolean;
  onCheckNode: (head: HydraHead) => void;
  onRequestLifecycle: (head: HydraHead, action: HydraLifecycleAction) => void;
}) {
  if (!head) {
    return null;
  }

  const participantSummary = getParticipantSummary(head);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle>Hydra head details</DialogTitle>
                <Badge variant={getStatusBadgeVariant(head.status)}>{head.status}</Badge>
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

        <div className="space-y-6">
          <div className="grid gap-4 rounded-md border bg-muted/10 p-4 md:grid-cols-3">
            <DetailField
              label="Head identifier"
              value={head.headIdentifier ?? head.id}
              copyValue={head.headIdentifier ?? head.id}
              mono
            />
            <DetailField
              label="Relation"
              value={head.hydraRelationId}
              copyValue={head.hydraRelationId}
              mono
            />
            <DetailField
              label="Participants"
              value={`${participantSummary.totalParticipants} total`}
            />
            <DetailField label="Snapshot" value={head.latestSnapshotNumber} />
            <DetailField label="Contestation period" value={`${head.contestationPeriod}s`} />
            <DetailField label="Transactions" value={String(head._count?.Transactions ?? 0)} />
            <DetailField label="Created" value={formatDate(head.createdAt)} />
            <DetailField label="Updated" value={formatDate(head.updatedAt)} />
            <DetailField label="Latest activity" value={formatDate(head.latestActivityAt)} />
            <DetailField label="Opened" value={formatDate(head.openedAt)} />
            <DetailField label="Closed" value={formatDate(head.closedAt)} />
            <DetailField label="Finalized" value={formatDate(head.finalizedAt)} />
          </div>

          <HydraNodeCheckPanel
            head={head}
            nodeCheck={nodeCheck}
            isCheckingNode={isCheckingNode}
            onCheckNode={onCheckNode}
          />

          <div className="space-y-3">
            <h3 className="font-medium">Lifecycle transactions</h3>
            <div className="grid gap-3">
              <TransactionHashRow label="Initial tx" hash={head.initTxHash} network={network} />
              <TransactionHashRow label="Close tx" hash={head.closeTxHash} network={network} />
              <TransactionHashRow label="Fanout tx" hash={head.fanoutTxHash} network={network} />
            </div>
          </div>

          <HydraHeadInHeadBalance
            headId={head.id}
            isOpen={head.status === 'Open'}
            network={network}
          />

          <div className="space-y-3">
            <h3 className="font-medium">Participants</h3>
            <ParticipantCard
              title="Local participant"
              participant={head.LocalParticipant}
              network={network}
            />
            {(head.RemoteParticipants ?? []).length > 0 ? (
              <div className="space-y-3">
                {(head.RemoteParticipants ?? []).map((participant, index) => (
                  <ParticipantCard
                    key={participant.id}
                    title={`Remote participant ${index + 1}`}
                    participant={participant}
                    network={network}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                No remote participants saved.
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function HydraHeadTable({
  heads,
  isLoading,
  hasActiveFilters,
  runningLifecycleHeadId,
  onOpenHead,
  onRequestLifecycle,
}: {
  heads: HydraHead[];
  isLoading: boolean;
  hasActiveFilters: boolean;
  runningLifecycleHeadId: string | null;
  onOpenHead: (head: HydraHead) => void;
  onRequestLifecycle: (head: HydraHead, action: HydraLifecycleAction) => void;
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
      <table className="w-full min-w-[1080px]">
        <thead className="bg-muted/30 dark:bg-muted/15">
          <tr className="border-b">
            <th scope="col" className="p-4 pl-6 text-left text-sm font-medium">
              Head
            </th>
            <th scope="col" className="p-4 text-left text-sm font-medium">
              Status
            </th>
            <th scope="col" className="p-4 text-left text-sm font-medium">
              Participants
            </th>
            <th scope="col" className="p-4 text-left text-sm font-medium">
              Snapshot
            </th>
            <th scope="col" className="p-4 text-left text-sm font-medium">
              Transactions
            </th>
            <th scope="col" className="p-4 text-left text-sm font-medium">
              Activity
            </th>
            <th scope="col" className="p-4 pr-6 text-left text-sm font-medium">
              Relation
            </th>
            <th scope="col" className="p-4 pr-6 text-right text-sm font-medium">
              Action
            </th>
          </tr>
        </thead>
        <tbody>
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
                      <span className="text-xs text-destructive">
                        {head._count.Errors} error{head._count.Errors === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                </td>
                <td className="p-4">
                  <div className="flex flex-col gap-1 text-sm">
                    <span>{participantSummary.totalParticipants} total</span>
                    <span className="text-xs text-muted-foreground">
                      {participantSummary.committedCount} committed,{' '}
                      {participantSummary.remoteCount} remote
                    </span>
                  </div>
                </td>
                <td className="p-4">
                  <div className="flex flex-col gap-1 text-sm">
                    <span>{head.latestSnapshotNumber}</span>
                    <span className="text-xs text-muted-foreground">
                      Contestation {head.contestationPeriod}s
                    </span>
                  </div>
                </td>
                <td className="p-4 text-sm">{head._count?.Transactions ?? 0}</td>
                <td className="p-4">
                  <div className="flex flex-col gap-1 text-sm">
                    <span>{formatDate(lifecycleDate)}</span>
                    {head.contestationDeadline && (
                      <span className="text-xs text-muted-foreground">
                        Fanout after {formatDate(head.contestationDeadline)}
                      </span>
                    )}
                  </div>
                </td>
                <td className="p-4 pr-6">
                  <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                    <span>{shortenAddress(head.hydraRelationId, 8)}</span>
                    <CopyButton value={head.hydraRelationId} className="h-7 w-7" />
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
  const { heads, isLoading, isFetching, refetch } = useHydraHeads();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<StatusTab>('All');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [selectedHeadId, setSelectedHeadId] = useState<string | null>(null);
  const [checkingHeadId, setCheckingHeadId] = useState<string | null>(null);
  const [runningLifecycleHeadId, setRunningLifecycleHeadId] = useState<string | null>(null);
  const [pendingLifecycleAction, setPendingLifecycleAction] =
    useState<PendingLifecycleAction | null>(null);
  const [nodeChecks, setNodeChecks] = useState<Record<string, HydraNodeCheckResult | undefined>>(
    {},
  );

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
        localParticipant?.nodeUrl ?? '',
        localParticipant?.nodeHttpUrl ?? '',
        ...remoteParticipants.flatMap((participant) => [
          participant.walletId,
          participant.nodeUrl,
          participant.nodeHttpUrl,
        ]),
      ];

      return searchableValues.some((value) => value.toLowerCase().includes(query));
    });
  }, [activeTab, heads, searchQuery]);

  const hasActiveFilters = searchQuery.trim().length > 0 || activeTab !== 'All';
  const selectedHead = useMemo(
    () => heads.find((head) => head.id === selectedHeadId) ?? null,
    [heads, selectedHeadId],
  );
  const pendingLifecycleCopy = pendingLifecycleAction
    ? getLifecycleActionConfirmCopy(pendingLifecycleAction.head, pendingLifecycleAction.action)
    : null;

  const handleCheckNode = async (head: HydraHead) => {
    const localParticipant = head.LocalParticipant;
    if (!localParticipant) {
      toast.error('This head has no local participant to check');
      return;
    }

    setCheckingHeadId(head.id);
    try {
      const result = await checkHydraNode(apiClient, {
        nodeHttpUrl: localParticipant.nodeHttpUrl,
        nodeUrl: localParticipant.nodeUrl,
        timeoutMs: 5000,
      });
      setNodeChecks((currentChecks) => ({ ...currentChecks, [head.id]: result }));
    } finally {
      setCheckingHeadId(null);
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
        await closeHydraHead(apiClient, { headId: head.id });
        toast.success('Hydra head close started');
      } else {
        await fanoutHydraHead(apiClient, { headId: head.id });
        toast.success('Hydra head fanout started');
      }

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
              <p className="text-sm text-muted-foreground">
                Monitor Hydra head sessions, lifecycle status, participants, and in-head activity.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button type="button" onClick={() => setIsAddDialogOpen(true)}>
                <Plus className="h-4 w-4" />
                Add
              </Button>
              <RefreshButton onRefresh={() => void refetch()} isRefreshing={isFetching} />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-lg border bg-card px-4 py-3">
              <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
                <Layers3 className="h-4 w-4" />
                Total
              </div>
              <p className="mt-1 text-xl font-semibold">{stats.totalHeads}</p>
            </div>
            <div
              className={cn(
                'rounded-lg border bg-card px-4 py-3',
                stats.openHeads > 0 && 'border-green-200 dark:border-green-900/60',
              )}
            >
              <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
                <Activity className="h-4 w-4" />
                Open
              </div>
              <p className="mt-1 text-xl font-semibold">{stats.openHeads}</p>
            </div>
            <div className="rounded-lg border bg-card px-4 py-3">
              <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
                <GitBranch className="h-4 w-4" />
                Active lifecycle
              </div>
              <p className="mt-1 text-xl font-semibold">{stats.activeHeads}</p>
            </div>
            <div className="rounded-lg border bg-card px-4 py-3">
              <p className="text-xs font-medium uppercase text-muted-foreground">Enabled</p>
              <p className="mt-1 text-xl font-semibold">{stats.enabledHeads}</p>
            </div>
          </div>

          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(tab) => setActiveTab(tab as StatusTab)}
          />

          <SearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search head ID, relation, participant wallet, or node..."
            className="max-w-md"
            isLoading={isFetching && !isLoading}
          />

          <HydraHeadTable
            heads={filteredHeads}
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
        nodeCheck={selectedHead ? nodeChecks[selectedHead.id] : undefined}
        isCheckingNode={selectedHead ? checkingHeadId === selectedHead.id : false}
        isLifecycleActionRunning={selectedHead ? runningLifecycleHeadId === selectedHead.id : false}
        onCheckNode={(head) => void handleCheckNode(head)}
        onRequestLifecycle={(head, action) => setPendingLifecycleAction({ head, action })}
      />
      <ConfirmDialog
        open={Boolean(pendingLifecycleAction)}
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
      />
      <AddHydraHeadDialog
        open={isAddDialogOpen}
        onOpenChange={setIsAddDialogOpen}
        onCreated={() => void refetch()}
      />
    </MainLayout>
  );
}
