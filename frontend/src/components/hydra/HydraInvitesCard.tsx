/**
 * Outstanding and spent invites.
 *
 * Exists mainly because an issued invite is not free — it holds a node and a
 * peer port — and there was otherwise nowhere to see what you were holding or
 * to give it back. Revoking is the only way a reservation returns before its
 * expiry.
 */

import { useState } from 'react';
import { Loader2, MoreHorizontal, Ticket } from 'lucide-react';
import { toast } from 'react-toastify';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAppContext } from '@/lib/contexts/AppContext';
import { revokeHydraInvite, useHydraInvites, type HydraInvite } from '@/lib/hooks/useHydraHeads';
import { IssueHydraInviteDialog } from '@/components/hydra/IssueHydraInviteDialog';
import { RedeemHydraInviteDialog } from '@/components/hydra/RedeemHydraInviteDialog';

/** Chrome-free stand-ins, so the same card can sit inside a dialog that already has a header. */
function EmbeddedShell({ children }: { children: React.ReactNode }) {
  return <div className="space-y-4">{children}</div>;
}
function EmbeddedHeader({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={className}>{children}</div>;
}
function EmbeddedBody({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}

function statusTone(status: HydraInvite['status']) {
  if (status === 'Completed') return 'default';
  if (status === 'Issued') return 'secondary';
  return 'outline';
}

function describe(invite: HydraInvite): string {
  if (invite.status === 'Completed' && invite.redeemerWalletAddress !== null) {
    return `Redeemed by ${invite.redeemerWalletAddress.slice(0, 24)}…`;
  }
  if (invite.role === 'Redeemer') {
    return `From ${invite.issuerWalletAddress.slice(0, 24)}…`;
  }
  if (invite.status === 'Issued') {
    return `Waiting to be redeemed · expires ${new Date(invite.expiresAt).toLocaleDateString()}`;
  }
  return invite.status;
}

export function HydraInvitesCard({
  hasConnectedNode,
  variant = 'card',
}: {
  hasConnectedNode: boolean;
  /** 'embedded' drops the card chrome, for use inside a dialog that already has a header. */
  variant?: 'card' | 'embedded';
}) {
  const { apiClient } = useAppContext();
  const { invites, refetch, isLoading } = useHydraInvites();
  const [isIssueOpen, setIsIssueOpen] = useState(false);
  const [isRedeemOpen, setIsRedeemOpen] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<HydraInvite | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function handleRevoke(invite: HydraInvite) {
    setBusyId(invite.id);
    try {
      await revokeHydraInvite(apiClient, { id: invite.id });
      toast.success('Invite revoked; its node and port are released');
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to revoke the invite');
    } finally {
      setBusyId(null);
      setPendingRevoke(null);
    }
  }

  const isEmbedded = variant === 'embedded';
  const Shell = isEmbedded ? EmbeddedShell : Card;
  const HeaderShell = isEmbedded ? EmbeddedHeader : CardHeader;
  const BodyShell = isEmbedded ? EmbeddedBody : CardContent;

  return (
    <Shell>
      <HeaderShell className="flex flex-row flex-wrap items-start justify-between gap-3">
        {isEmbedded ? (
          <span />
        ) : (
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Ticket className="h-4 w-4" />
              Invites
              <Badge variant="outline">{invites.length}</Badge>
            </CardTitle>
            <CardDescription>
              A head is opened by issuing an invite or redeeming one. An outstanding invite holds a
              node and a peer port until it is used.
            </CardDescription>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setIsRedeemOpen(true)}
            disabled={!hasConnectedNode}
            title={
              hasConnectedNode ? undefined : 'Connect a node first — a head has to run somewhere'
            }
          >
            Redeem an invite
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => setIsIssueOpen(true)}
            disabled={!hasConnectedNode}
            title={
              hasConnectedNode ? undefined : 'Connect a node first — a head has to run somewhere'
            }
          >
            Invite someone
          </Button>
        </div>
      </HeaderShell>

      <BodyShell>
        {isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading invites…
          </p>
        ) : invites.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No invites yet. Invite someone to open the first head, or redeem a code they sent you.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {invites.map((invite) => (
              <li
                key={invite.id}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{invite.nonce.slice(0, 12)}…</span>
                    <Badge variant={statusTone(invite.status)}>{invite.status}</Badge>
                    <Badge variant="outline">{invite.role}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{describe(invite)}</p>
                </div>

                <div className="flex items-center gap-1">
                  <CopyButton value={invite.nonce} />
                  {invite.role === 'Issuer' && invite.status === 'Issued' && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          disabled={busyId === invite.id}
                          aria-label={`More actions for invite ${invite.nonce}`}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          className="text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400"
                          onClick={() => setPendingRevoke(invite)}
                        >
                          Revoke and release its node
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </BodyShell>

      <IssueHydraInviteDialog
        open={isIssueOpen}
        onOpenChange={setIsIssueOpen}
        onIssued={() => void refetch()}
      />
      <RedeemHydraInviteDialog
        open={isRedeemOpen}
        onOpenChange={setIsRedeemOpen}
        onRedeemed={() => void refetch()}
      />
      <ConfirmDialog
        open={pendingRevoke !== null}
        onClose={() => setPendingRevoke(null)}
        title="Revoke this invite?"
        description="The counterparty can no longer redeem it, and the node and peer port it reserved are released. If they already have the code, tell them — redeeming will simply fail."
        isLoading={busyId !== null}
        onConfirm={() => {
          if (pendingRevoke !== null) void handleRevoke(pendingRevoke);
        }}
      />
    </Shell>
  );
}
