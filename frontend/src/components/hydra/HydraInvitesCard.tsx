/**
 * Outstanding and spent invites.
 *
 * Exists mainly because an issued invite is not free, it holds a node and a
 * peer port, and there was otherwise nowhere to see what you were holding or
 * to give it back. Revoking is the only way a reservation returns before its
 * expiry.
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { useAppContext } from '@/lib/contexts/AppContext';
import { revokeHydraInvite, useHydraInvites, type HydraInvite } from '@/lib/hooks/useHydraHeads';
import { HydraInviteDetailsDialog } from '@/components/hydra/HydraInviteDetailsDialog';
import { IssueHydraInviteDialog } from '@/components/hydra/IssueHydraInviteDialog';
import { RedeemHydraInviteDialog } from '@/components/hydra/RedeemHydraInviteDialog';

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

/** Invite list for the Hydra manage dialog (embedded, no outer card chrome). */
export function HydraInvitesCard({ hasConnectedNode }: { hasConnectedNode: boolean }) {
  const { apiClient, network } = useAppContext();
  const { invites, refetch, isLoading, isError } = useHydraInvites(
    network === 'Preprod' || network === 'Mainnet' ? network : undefined,
  );
  const [isIssueOpen, setIsIssueOpen] = useState(false);
  const [isRedeemOpen, setIsRedeemOpen] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<HydraInvite | null>(null);
  const [detailsInvite, setDetailsInvite] = useState<HydraInvite | null>(null);
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

  return (
    <div className="space-y-4">
      <div className="flex flex-row flex-wrap items-start justify-between gap-3">
        <span />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setIsRedeemOpen(true)}
            disabled={!hasConnectedNode}
            title={
              hasConnectedNode ? undefined : 'Connect a node first. A head has to run somewhere.'
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
              hasConnectedNode ? undefined : 'Connect a node first. A head has to run somewhere.'
            }
          >
            Invite someone
          </Button>
        </div>
      </div>

      <div>
        {isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading invites…
          </p>
        ) : isError && invites.length === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-destructive/40 px-3 py-2">
            <span className="text-sm text-muted-foreground">Could not read your invites.</span>
            <Button type="button" size="sm" variant="outline" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
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
                <button
                  type="button"
                  className="min-w-0 space-y-1 text-left"
                  onClick={() => setDetailsInvite(invite)}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs underline-offset-4 hover:underline">
                      {invite.nonce.slice(0, 12)}…
                    </span>
                    <Badge variant={statusTone(invite.status)}>{invite.status}</Badge>
                    <Badge variant="outline">{invite.role}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{describe(invite)}</p>
                </button>

                <div className="flex items-center gap-1">
                  <CopyButton value={invite.nonce} />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busyId === invite.id}
                    onClick={() => setDetailsInvite(invite)}
                  >
                    Details
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

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
      <HydraInviteDetailsDialog
        invite={detailsInvite}
        open={detailsInvite !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDetailsInvite(null);
        }}
        network={network}
        isRevoking={busyId === detailsInvite?.id}
        onRevoke={(invite) => {
          setDetailsInvite(null);
          setPendingRevoke(invite);
        }}
      />
      <ConfirmDialog
        elevatedChildStack
        open={pendingRevoke !== null}
        onClose={() => setPendingRevoke(null)}
        title="Revoke this invite?"
        description="The counterparty can no longer redeem it, and the node and peer port it reserved are released. If they already have the code, tell them. Redeeming it will fail."
        isLoading={busyId !== null}
        onConfirm={() => {
          if (pendingRevoke !== null) void handleRevoke(pendingRevoke);
        }}
      />
    </div>
  );
}
