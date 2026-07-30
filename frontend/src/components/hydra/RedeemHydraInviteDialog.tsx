/**
 * Redeem an invite someone sent you.
 *
 * Two steps on purpose. Pasting a code only reads it — nothing is provisioned
 * and the counterparty is not contacted — so the operator can look at who
 * signed it first. Redeeming is the second, deliberate step.
 *
 * That first step is the only human gate in the whole exchange. A signature
 * proves the invite came from the holder of a wallet; it cannot say whether
 * that wallet is the organisation you meant. So the review screen leads with
 * the registry entries that wallet holds, because "Acme Weather Agent" is a
 * check someone performs and a hex address is one they click past.
 */

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, ShieldAlert, Ticket } from 'lucide-react';
import { toast } from 'react-toastify';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useWallets } from '@/lib/queries/useWallets';
import {
  previewHydraInvite,
  redeemHydraInvite,
  type HydraInvitePreview,
} from '@/lib/hooks/useHydraHeads';

type RedeemHydraInviteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRedeemed: () => void;
};

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="break-all font-mono text-xs">{value}</p>
    </div>
  );
}

export function RedeemHydraInviteDialog({
  open,
  onOpenChange,
  onRedeemed,
}: RedeemHydraInviteDialogProps) {
  const { apiClient } = useAppContext();
  const { wallets } = useWallets();
  const [code, setCode] = useState('');
  const [hotWalletId, setHotWalletId] = useState('');
  const [preview, setPreview] = useState<HydraInvitePreview | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setCode('');
      setHotWalletId('');
      setPreview(null);
    }
    onOpenChange(nextOpen);
  }

  async function handlePreview() {
    if (code.trim().length === 0) {
      toast.error('Paste the invite code you were sent.');
      return;
    }
    setIsLoading(true);
    try {
      setPreview(await previewHydraInvite(apiClient, { code: code.trim() }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to read the invite');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRedeem() {
    if (hotWalletId.length === 0) {
      toast.error('Choose the wallet that will identify you on this head.');
      return;
    }
    setIsLoading(true);
    try {
      const result = await redeemHydraInvite(apiClient, { code: code.trim(), hotWalletId });
      toast.success(`Head opened with ${result.counterpartyWalletAddress.slice(0, 20)}…`);
      onRedeemed();
      handleOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to redeem the invite');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ticket className="h-4 w-4" />
            Redeem an invite
          </DialogTitle>
          <DialogDescription>
            Paste what they sent you. Nothing happens until you have seen who it is from.
          </DialogDescription>
        </DialogHeader>

        {preview === null ? (
          <div className="space-y-2">
            <Label htmlFor="hydra-invite-code">Invite code</Label>
            <Textarea
              id="hydra-invite-code"
              rows={5}
              className="font-mono text-xs"
              placeholder="masumi-hydra-invite-1.…"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Reading it provisions nothing and tells the sender nothing.
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {!preview.signatureValid && (
              <p className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-400">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  This invite&apos;s signature does not match the wallet it claims to be from. It
                  has been altered in transit or was not produced by that wallet. Do not redeem it —
                  ask for a fresh one over a channel you trust.
                </span>
              </p>
            )}

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Who this is from</h3>
              <Field label="Wallet" value={preview.issuerWalletAddress} />
              {preview.identity.lookupError !== null ? (
                <p className="text-xs text-muted-foreground">{preview.identity.lookupError}</p>
              ) : preview.identity.entries.length === 0 ? (
                <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    This wallet holds no registry entries, so there is nothing on chain vouching for
                    who it is. That is normal for a brand-new operator and expected if you were told
                    to expect it — otherwise confirm the address with them directly.
                  </span>
                </p>
              ) : (
                <ul className="space-y-1 rounded-md border p-2">
                  {preview.identity.entries.map((entry) => (
                    <li
                      key={entry.unit}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="font-medium">{entry.name ?? entry.assetName}</span>
                      <span className="truncate font-mono text-muted-foreground">
                        {entry.assetName}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">What you would be agreeing to</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Network" value={preview.network} />
                <Field label="Their node" value={preview.advertise} />
                <Field label="Contestation" value={`${preview.contestationPeriodSeconds}s`} />
                <Field label="Deposit period" value={`${preview.depositPeriodSeconds}s`} />
                <Field label="Expires" value={new Date(preview.expiresAt).toLocaleString()} />
                <Field label="Their exchange" value={preview.exchangeUrl} />
              </div>
              <p className="text-xs text-muted-foreground">
                The contestation period is how long a closing head can be disputed. It is fixed for
                the head&apos;s life and cannot be changed afterwards.
              </p>
            </section>

            {preview.alreadyKnown && (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                You have seen this invite before — it is already recorded here.
              </p>
            )}

            <div className="space-y-2">
              <Label htmlFor="hydra-redeem-wallet">Our wallet</Label>
              <Select value={hotWalletId} onValueChange={setHotWalletId}>
                <SelectTrigger id="hydra-redeem-wallet">
                  <SelectValue placeholder="Choose a wallet" />
                </SelectTrigger>
                <SelectContent>
                  {wallets.map((wallet) => (
                    <SelectItem key={wallet.id} value={wallet.id}>
                      {wallet.note?.trim() || wallet.type} · {wallet.walletAddress.slice(0, 16)}…
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Redeeming starts a node on your side and tells them you are ready.
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          {preview === null ? (
            <>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void handlePreview()} disabled={isLoading}>
                {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                Read invite
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => setPreview(null)}>
                Back
              </Button>
              <Button
                type="button"
                onClick={() => void handleRedeem()}
                disabled={isLoading || !preview.signatureValid}
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                Open the head
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function InviteStatusBadge({ status }: { status: string }) {
  const tone =
    status === 'Completed'
      ? 'default'
      : status === 'Issued'
        ? 'secondary'
        : status === 'Expired' || status === 'Revoked'
          ? 'outline'
          : 'secondary';
  return <Badge variant={tone as 'default' | 'secondary' | 'outline'}>{status}</Badge>;
}
