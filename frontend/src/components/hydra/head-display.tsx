/**
 * How a head is written down: its status, its dates, and the small rows the
 * details dialog is built from.
 *
 * Split out of the Hydra page when it went past the file-size limit. These are
 * the pieces every other part of that page renders through — the table, the
 * details dialog and the lifecycle menu all ask "what colour is this status"
 * and "how is this date written" — so they belong to none of them.
 */

import { ExternalLink } from 'lucide-react';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { cn, getExplorerUrl } from '@/lib/utils';
import type { HydraHead, HydraHeadStatus } from '@/lib/hooks/useHydraHeads';

export const statusTabs = ['All', 'Open', 'Initializing', 'Idle', 'Closed', 'Final'] as const;

export type StatusTab = (typeof statusTabs)[number];
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatDate(value: string | null | undefined) {
  if (!value) return '-';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';

  return dateTimeFormatter.format(date);
}

export function getStatusBadgeVariant(status: HydraHeadStatus): BadgeProps['variant'] {
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

export function getLifecycleDate(head: HydraHead) {
  if (head.status === 'Final') return head.finalizedAt;
  if (head.status === 'Closed' || head.status === 'FanoutPossible') return head.closedAt;
  if (head.status === 'Open') return head.openedAt;
  return head.latestActivityAt ?? head.updatedAt;
}

export function matchesStatusTab(head: HydraHead, activeTab: StatusTab) {
  if (activeTab === 'All') return true;
  if (activeTab === 'Closed') return head.status === 'Closed' || head.status === 'FanoutPossible';
  return head.status === activeTab;
}

export function getParticipantSummary(head: HydraHead) {
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

export function DetailField({
  label,
  value,
  copyValue,
  mono = false,
  hint,
}: {
  label: string;
  value: string | null | undefined;
  copyValue?: string | null;
  mono?: boolean;
  /** One line on what the reading means, for the ones nobody guesses. */
  hint?: string;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-xs font-medium uppercase text-muted-foreground">{label}</p>
      <div className="flex min-w-0 items-center gap-2">
        <p className={cn('truncate text-sm', mono && 'font-mono')}>{value || '-'}</p>
        {copyValue && <CopyButton value={copyValue} className="h-7 w-7 shrink-0" />}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
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
export function TransactionHashRow({
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
