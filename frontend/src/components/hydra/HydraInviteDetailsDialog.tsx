/**
 * Everything recorded about one invite, and the one action it still has.
 *
 * The list could only show a truncated nonce, a status and a role, which is
 * enough to tell two invites apart and nothing else. It could not answer the
 * questions an operator actually has about an outstanding one: which wallet did
 * I issue it with, which node is it holding, who redeemed it, and can I take it
 * back. Revoke lived behind a three-dot menu on the row, which is a strange
 * place for the only thing you can do here.
 */

import { Loader2, Ticket, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatDateTime } from '@/lib/format-date';
import { HydraWalletLink } from '@/components/hydra/HydraWalletLink';
import type { HydraInvite } from '@/lib/hooks/useHydraHeads';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b py-2 last:border-b-0">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="min-w-0 text-sm">{children}</span>
    </div>
  );
}

export function HydraInviteDetailsDialog({
  invite,
  open,
  onOpenChange,
  onRevoke,
  isRevoking,
  network,
}: {
  invite: HydraInvite | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRevoke: (invite: HydraInvite) => void;
  isRevoking: boolean;
  network: string;
}) {
  if (!invite) return null;

  // Only an unredeemed invite we issued can be taken back. Once the far side has
  // redeemed it, the head exists and revoking here would leave them holding a
  // node pointed at nothing.
  const canRevoke = invite.role === 'Issuer' && invite.status === 'Issued';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <Ticket className="h-4 w-4" />
            Invite
            <Badge variant="outline">{invite.status}</Badge>
            <Badge variant="outline">{invite.role}</Badge>
          </DialogTitle>
          <DialogDescription>
            {invite.role === 'Issuer'
              ? 'You issued this. The side that redeems it opens the head.'
              : 'You redeemed this. Your side opens the head.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-0">
          <Row label="Code">
            <span className="flex items-center gap-1">
              <span className="break-all font-mono text-xs">{invite.nonce}</span>
              <CopyButton value={invite.nonce} />
            </span>
          </Row>
          <Row label="Issuer wallet">
            <HydraWalletLink address={invite.issuerWalletAddress} network={network} shorten={10} />
          </Row>
          {invite.redeemerWalletAddress && (
            <Row label="Redeemer wallet">
              <HydraWalletLink
                address={invite.redeemerWalletAddress}
                network={network}
                shorten={10}
              />
            </Row>
          )}
          <Row label="Created">{formatDateTime(invite.createdAt)}</Row>
          <Row label={invite.redeemedAt ? 'Redeemed' : 'Expires'}>
            {formatDateTime(invite.redeemedAt ?? invite.expiresAt)}
          </Row>
          <Row label="Node held">
            <span className="break-all font-mono text-xs">{invite.hostNodeId}</span>
          </Row>
          {invite.hydraHeadId && (
            <Row label="Head">
              <span className="break-all font-mono text-xs">{invite.hydraHeadId}</span>
            </Row>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          {canRevoke
            ? 'While this sits unredeemed it holds a node process and a peer port. Revoking frees both, and the code stops working.'
            : 'The node and port this reserved are now committed to its head.'}
        </p>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {canRevoke && (
            <Button
              type="button"
              variant="destructive"
              disabled={isRevoking}
              onClick={() => onRevoke(invite)}
            >
              {isRevoking ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              Revoke
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
