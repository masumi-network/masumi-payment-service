/**
 * The head list: what exists, what state it is in, and what can be done to it.
 *
 * Invites nobody has redeemed are rows here too, at the top, because that is
 * the first stage of a head's life rather than a separate kind of object.
 */

import { Ticket } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { HorizontalScrollArea } from '@/components/ui/horizontal-scroll-area';
import {
  tableActionsCellWideClass,
  tableActionsHeadWideClass,
} from '@/components/ui/table-actions-column';
import { CopyButton } from '@/components/ui/copy-button';
import { cn, shortenAddress } from '@/lib/utils';
import type { HydraHead, HydraInvite } from '@/lib/hooks/useHydraHeads';
import {
  formatDate,
  getLifecycleDate,
  getParticipantSummary,
  getStatusBadgeVariant,
} from '@/components/hydra/head-display';
import {
  HydraLifecycleActionMenu,
  type HydraLifecycleAction,
} from '@/components/hydra/head-lifecycle';

export function HydraHeadTable({
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
  // An invite is a head with one participant missing, so a page holding one is
  // not empty. Counting only heads sent the operator who had just issued their
  // first invite — provisioning a node and reserving its port — to an empty
  // state that said nothing exists.
  const isEmpty = heads.length === 0 && pendingInvites.length === 0;

  if (isLoading && isEmpty) {
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

  if (isEmpty) {
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
    <HorizontalScrollArea className="rounded-lg border">
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
            <th scope="col" className={tableActionsHeadWideClass}>
              Actions
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
              <td className={tableActionsCellWideClass}>
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
                className="group border-b last:border-0 align-top animate-fade-in opacity-0 cursor-pointer transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                style={{ animationDelay: `${Math.min(index, 9) * 35}ms` }}
                onClick={() => onOpenHead(head)}
                onKeyDown={(event) => {
                  // Only the row's own key events. A keydown that bubbled up from
                  // a control inside the row — the copy buttons next to the ids —
                  // was being preventDefault()ed here, which cancelled the
                  // button's activation: Enter on a copy button opened the
                  // details dialog and copied nothing.
                  if (event.target !== event.currentTarget) return;
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
                <td className={tableActionsCellWideClass}>
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
    </HorizontalScrollArea>
  );
}
