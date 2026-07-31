/**
 * Issue an invite to open a head with someone.
 *
 * Two things make this different from a form that just posts and closes.
 *
 * Issuing spends real capacity — a node process and a peer port, held until
 * someone redeems or it expires — so the cost is stated before the button, not
 * discovered afterwards from a node list.
 *
 * And the result is the whole point. The code is what the operator carries to
 * the counterparty, so the dialog stays open on it, offers a copy, and says
 * plainly that it is not a secret but is single-use.
 */

import { useState } from 'react';
import { AlertTriangle, Loader2, Ticket } from 'lucide-react';
import { toast } from 'react-toastify';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useWallets } from '@/lib/queries/useWallets';
import { createHydraInvite } from '@/lib/hooks/useHydraHeads';

type IssueHydraInviteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssued: () => void;
};

const DEFAULT_TTL_HOURS = 168;

export function IssueHydraInviteDialog({
  open,
  onOpenChange,
  onIssued,
}: IssueHydraInviteDialogProps) {
  const { apiClient } = useAppContext();
  const { wallets } = useWallets();
  const [hotWalletId, setHotWalletId] = useState('');
  const [ttlHours, setTtlHours] = useState(String(DEFAULT_TTL_HOURS));
  const [isLoading, setIsLoading] = useState(false);
  const [issued, setIssued] = useState<{ code: string; expiresAt: string } | null>(null);

  function reset() {
    setHotWalletId('');
    setTtlHours(String(DEFAULT_TTL_HOURS));
    setIssued(null);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      reset();
    }
    onOpenChange(nextOpen);
  }

  async function handleIssue() {
    if (hotWalletId.length === 0) {
      toast.error('Choose the wallet that will identify you on this head.');
      return;
    }
    const hours = Number(ttlHours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
      toast.error('Validity must be a whole number of hours between 1 and 720.');
      return;
    }

    setIsLoading(true);
    try {
      const invite = await createHydraInvite(apiClient, { hotWalletId, ttlHours: hours });
      setIssued({ code: invite.code, expiresAt: invite.expiresAt });
      onIssued();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create the invite');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ticket className="h-4 w-4" />
            Invite someone to open a head
          </DialogTitle>
          <DialogDescription>
            Creates a signed code to send them. Redeeming it opens the head — no further step here.
          </DialogDescription>
        </DialogHeader>

        {issued === null ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="hydra-invite-wallet">Our wallet</Label>
              <Select value={hotWalletId} onValueChange={setHotWalletId}>
                <SelectTrigger id="hydra-invite-wallet">
                  <SelectValue placeholder="Choose a wallet" />
                </SelectTrigger>
                <SelectContent>
                  {wallets.map((wallet) => (
                    <SelectItem key={wallet.id} value={wallet.id}>
                      {/* The role is always shown, even when the wallet has a
                          note. A head is between two wallets and which side
                          each plays decides whether payments can route through
                          it — a name alone does not say that. */}
                      <span className="flex items-center gap-2">
                        <Badge variant="outline" className="shrink-0">
                          {wallet.type === 'Purchasing' ? 'Buyer' : 'Seller'}
                        </Badge>
                        <span className="truncate">
                          {wallet.note?.trim() ? `${wallet.note.trim()} · ` : ''}
                          {wallet.walletAddress.slice(0, 16)}…
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                This wallet signs the invite and is who the counterparty will see. It is who you
                settle with, not the node&apos;s own key.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="hydra-invite-ttl">Valid for (hours)</Label>
              <Input
                id="hydra-invite-ttl"
                inputMode="numeric"
                value={ttlHours}
                onChange={(event) => setTtlHours(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                A node and a peer port stay reserved for this long. Shorter is tidier; long enough
                that they will actually read it.
              </p>
            </div>

            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
              <AlertTriangle className="mr-1 inline h-3 w-3" />
              Issuing starts a node and holds a peer port straight away. It cannot be pointed at a
              different counterparty later, so revoke it if you change your mind.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Invite code</Label>
                <CopyButton value={issued.code} />
              </div>
              <p className="max-h-40 overflow-auto break-all rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs">
                {issued.code}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              Send this however you normally reach them. It is not a secret — everything in it is
              public and signed — but it can be redeemed once, so whoever uses it first becomes your
              counterparty.
            </p>
            <p className="text-xs text-muted-foreground">
              Expires {new Date(issued.expiresAt).toLocaleString()}.
            </p>
          </div>
        )}

        <DialogFooter>
          {issued === null ? (
            <>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void handleIssue()} disabled={isLoading}>
                {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                Create invite
              </Button>
            </>
          ) : (
            <Button type="button" onClick={() => handleOpenChange(false)}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
