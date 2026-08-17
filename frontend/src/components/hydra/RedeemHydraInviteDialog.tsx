/**
 * Redeem an invite someone sent you.
 *
 * Two steps on purpose. Pasting a code only reads it, nothing is provisioned
 * and the counterparty is not contacted, so the operator can look at who
 * signed it first. Redeeming is the second, deliberate step.
 *
 * That first step is the only human gate in the whole exchange. A signature
 * proves the invite came from the holder of a wallet; it cannot say whether
 * that wallet is the organisation you meant. So the review screen leads with
 * the registry entries that wallet holds, because "Acme Weather Agent" is a
 * check someone performs and a hex address is one they click past.
 */

import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, ShieldAlert, Ticket } from 'lucide-react';
import { toast } from 'react-toastify';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { shortenAddress } from '@/lib/utils';
import type { ReactNode } from 'react';
import {
  DepositPeriodHint,
  DisputeWindowHint,
  OutOfSyncLimitHint,
} from '@/components/hydra/hydra-hints';
import { formatDuration } from '@/components/hydra/DurationPicker';
import { HydraDetailSection } from '@/components/hydra/HydraDetailSection';
import { HydraNotice } from '@/components/hydra/HydraNotice';
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

function Field({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
        {hint}
      </p>
      <p className="break-all font-mono text-xs">{value}</p>
    </div>
  );
}

function usesInsecureHttp(value: string): boolean {
  try {
    return new URL(value).protocol === 'http:';
  } catch {
    return false;
  }
}

export function RedeemHydraInviteDialog({
  open,
  onOpenChange,
  onRedeemed,
}: RedeemHydraInviteDialogProps) {
  const { apiClient, selectedPaymentSource } = useAppContext();
  const { wallets } = useWallets();
  // Same rule as issuing: payments only reach a head through the V2 path, so a
  // head redeemed onto a V1 source's wallet would sit open and unused. The
  // service refuses it; this says so before the counterparty's single-use nonce
  // is spent on a redemption that cannot complete.
  const isHeadCapableSource = selectedPaymentSource?.paymentSourceType === 'Web3CardanoV2';
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [hotWalletId, setHotWalletId] = useState('');

  const [preview, setPreview] = useState<HydraInvitePreview | null>(null);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [allowInsecureExchangeHttp, setAllowInsecureExchangeHttp] = useState(false);
  const [allowPrivateExchangeNetwork, setAllowPrivateExchangeNetwork] = useState(false);
  // Reported at the field rather than as a toast: a message that disappears
  // leaves the operator to work out which of three things it meant.
  const [errors, setErrors] = useState<Record<string, string>>({});

  // A head runs between a buyer and a seller. Offering the wallets that cannot
  // work, and refusing them on submit, teaches the rule the slow way; offering
  // only the ones that can teaches it by construction.
  const requiredRole = preview?.issuerWalletRole ?? null;
  const selectableWallets = useMemo(
    () =>
      requiredRole === null
        ? wallets
        : wallets.filter((wallet) =>
            requiredRole === 'Buyer' ? wallet.type === 'Selling' : wallet.type === 'Purchasing',
          ),
    [wallets, requiredRole],
  );
  const [isLoading, setIsLoading] = useState(false);

  const isInsecureExchangeHttp = preview !== null && usesInsecureHttp(preview.exchangeUrl);
  const needsPrivateNetworkConsent =
    preview !== null && preview.exchangeUsesPrivateNetwork !== false;

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setCode('');
      setHotWalletId('');
      setPreview(null);
      setAllowInsecureExchangeHttp(false);
      setAllowPrivateExchangeNetwork(false);
      // Consent is to one invite's numbers, and those numbers are fixed for the
      // head's whole life. Left ticked, it would answer for the next invite
      // read in this dialog — a different settle time and dispute window that
      // nobody agreed to.
      setAcceptedTerms(false);
      setErrors({});
    }
    onOpenChange(nextOpen);
  }

  async function handlePreview() {
    if (code.trim().length === 0) {
      setErrors({ code: 'Paste the invite code you were sent.' });
      return;
    }
    setIsLoading(true);
    try {
      setAllowInsecureExchangeHttp(false);
      setAllowPrivateExchangeNetwork(false);
      // Reading a second invite without closing the dialog replaces the timings
      // the tick referred to, so the tick goes with them.
      setAcceptedTerms(false);
      setErrors({});
      setPreview(await previewHydraInvite(apiClient, { code: code.trim() }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to read the invite');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRedeem() {
    if (!acceptedTerms) {
      setErrors({ terms: 'Accept the head\u2019s timings before redeeming.' });
      return;
    }
    if (hotWalletId.length === 0) {
      setErrors({ wallet: 'Choose the wallet that will identify you on this head.' });
      return;
    }
    if (!selectableWallets.some((wallet) => wallet.id === hotWalletId)) {
      // Reachable by picking a wallet, going Back, and reading an invite from
      // the other side: the server would refuse it, but later and less clearly.
      setErrors({ wallet: 'That wallet is not on the side this invite needs. Choose another.' });
      return;
    }
    if (isInsecureExchangeHttp && !allowInsecureExchangeHttp) {
      toast.error('Confirm that the HTTP exchange is protected by a separately secured network.');
      return;
    }
    if (needsPrivateNetworkConsent && !allowPrivateExchangeNetwork) {
      toast.error(
        'Confirm that this exchange may connect to private or special-use network space.',
      );
      return;
    }
    setIsLoading(true);
    try {
      const result = await redeemHydraInvite(apiClient, {
        code: code.trim(),
        hotWalletId,
        allowInsecureExchangeHttp,
        allowPrivateExchangeNetwork,
      });
      toast.success(`Head opened with ${result.counterpartyWalletAddress.slice(0, 20)}…`);
      // Redeeming creates a head, a participant and an invite record at once, so
      // refreshing only the head list left the rest of the page describing a
      // world that no longer existed until the operator navigated away.
      await queryClient.invalidateQueries({
        predicate: (query) => String(query.queryKey[0]).startsWith('hydra'),
      });
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
            Paste what they sent you. Nothing is created until you have seen who it is from.
          </DialogDescription>
        </DialogHeader>

        {!isHeadCapableSource ? (
          <HydraNotice tone="warn">
            <p>
              The selected payment source is not a Web3CardanoV2 source. Payments on it settle on
              chain and never enter a head, so redeeming would open a head nothing would use, and
              spend the invite. Switch to a V2 payment source first.
            </p>
          </HydraNotice>
        ) : preview === null ? (
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
              Reading it starts nothing and tells the sender nothing.
            </p>
            {errors.code && <p className="text-xs text-destructive">{errors.code}</p>}
          </div>
        ) : (
          <div className="space-y-5">
            {!preview.signatureValid && (
              <HydraNotice tone="error">
                <p>
                  The signature does not match the wallet this invite claims to be from. It was
                  altered in transit, or that wallet did not produce it. Do not redeem it. Ask for a
                  fresh one over a channel you trust.
                </p>
              </HydraNotice>
            )}

            {/* Identity, not data. The wallet is what the signature proves, but
                what an operator actually recognises is the agent name, so that
                leads, the address is truncated with a copy, and the raw asset
                ids move behind a disclosure where they belong. */}
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Who this is from</h3>

              {preview.identity.lookupError !== null ? (
                <p className="text-xs text-muted-foreground">{preview.identity.lookupError}</p>
              ) : preview.identity.entries.length === 0 ? (
                <HydraNotice tone="warn">
                  <p>
                    This wallet holds no registry entries, so nothing on chain vouches for who it
                    is. That is normal for a new operator. If you were not expecting it, confirm the
                    address with them directly.
                  </p>
                </HydraNotice>
              ) : (
                <ul className="divide-y rounded-md border">
                  {preview.identity.entries.map((entry) => (
                    <li key={entry.unit} className="px-3 py-2">
                      <p className="text-sm font-medium">{entry.name ?? entry.assetName}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {entry.assetName}
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/10 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Wallet</p>
                  <p className="truncate font-mono text-xs">
                    {shortenAddress(preview.issuerWalletAddress, 12)}
                  </p>
                </div>
                <CopyButton value={preview.issuerWalletAddress} className="h-7 w-7" />
              </div>
            </section>

            {isInsecureExchangeHttp && (
              <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                <p className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Their signed exchange URL uses unencrypted HTTP. Anyone on that network path can
                    read or disrupt redemption. Continue only on loopback or a private network
                    protected separately.
                  </span>
                </p>
                <label className="flex cursor-pointer items-start gap-2 font-medium">
                  <Checkbox
                    checked={allowInsecureExchangeHttp}
                    onCheckedChange={(checked) => setAllowInsecureExchangeHttp(checked === true)}
                    aria-label="Allow invite redemption over HTTP"
                  />
                  <span>Allow this redemption over HTTP</span>
                </label>
              </div>
            )}

            {needsPrivateNetworkConsent && (
              <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                <p className="flex items-start gap-2">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {preview.exchangeUsesPrivateNetwork === true
                      ? 'Their exchange resolves to private, loopback, link-local, or other special-use network space. That can reach internal services. Continue only when this exact network path is expected.'
                      : `The exchange network could not be classified${preview.exchangeNetworkWarning ? `: ${preview.exchangeNetworkWarning}` : '.'} Private access stays blocked unless you explicitly allow it.`}
                  </span>
                </p>
                <label className="flex cursor-pointer items-start gap-2 font-medium">
                  <Checkbox
                    checked={allowPrivateExchangeNetwork}
                    onCheckedChange={(checked) => setAllowPrivateExchangeNetwork(checked === true)}
                    aria-label="Allow invite redemption to private network space"
                  />
                  <span>Allow this redemption to private network space</span>
                </label>
              </div>
            )}

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">What you would be agreeing to</h3>
              {/* The two terms with consequences stay visible; addresses and
                  ports are for verifying a suspicion, not for reading every
                  time. */}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Network" value={preview.network} />
                <Field
                  label="Dispute window"
                  value={formatDuration(preview.contestationPeriodSeconds)}
                  hint={<DisputeWindowHint />}
                />
                <Field
                  label="Deposit settles after"
                  value={formatDuration(preview.depositPeriodSeconds)}
                  hint={<DepositPeriodHint />}
                />
              </div>

              {/* An explicit tick rather than a line of prose. The settle time is
                  the one term here with a running cost, it was chosen by someone
                  else, and it cannot be changed once the head exists, so it is
                  worth making the operator look at it. */}
              <label className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
                <Checkbox
                  checked={acceptedTerms}
                  onCheckedChange={(checked) => {
                    setAcceptedTerms(checked === true);
                    setErrors({});
                  }}
                  className="mt-0.5"
                />
                <span>
                  I accept a {formatDuration(preview.depositPeriodSeconds)} settle time, a{' '}
                  {formatDuration(preview.contestationPeriodSeconds)} dispute window and a{' '}
                  {formatDuration(preview.unsyncedPeriodSeconds)} out-of-sync limit for this head.
                </span>
              </label>
              {errors.terms && <p className="text-xs text-destructive">{errors.terms}</p>}

              <HydraDetailSection title="Technical details" summary={preview.advertise}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Their node" value={preview.advertise} />
                  <Field label="Their exchange" value={preview.exchangeUrl} />
                  <Field
                    label="Out-of-sync limit"
                    value={formatDuration(preview.unsyncedPeriodSeconds)}
                    hint={<OutOfSyncLimitHint />}
                  />
                  <Field label="Expires" value={new Date(preview.expiresAt).toLocaleString()} />
                  <Field label="Nonce" value={preview.nonce} />
                </div>
              </HydraDetailSection>
            </section>

            {preview.alreadyKnown && (
              <HydraNotice tone="warn" plain>
                <p>You have read this invite before. It is already recorded here.</p>
              </HydraNotice>
            )}

            <div className="space-y-2">
              <Label htmlFor="hydra-redeem-wallet">Our wallet</Label>
              <Select
                value={hotWalletId}
                onValueChange={(value) => {
                  setHotWalletId(value);
                  setErrors({});
                }}
              >
                <SelectTrigger id="hydra-redeem-wallet">
                  <SelectValue placeholder="Choose a wallet" />
                </SelectTrigger>
                <SelectContent>
                  {selectableWallets.map((wallet) => (
                    <SelectItem key={wallet.id} value={wallet.id}>
                      {/* The role is always shown, even when the wallet has a
                          note. A head is between two wallets and which side
                          each plays decides whether payments can route through
                          it, a name alone does not say that. */}
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
              {requiredRole !== null && (
                <p className="text-xs text-muted-foreground">
                  Their side is the {requiredRole === 'Seller' ? 'seller' : 'buyer'}, so only your{' '}
                  {requiredRole === 'Seller' ? 'buying' : 'selling'} wallets are offered. A head
                  runs between a buyer and a seller, and payments route through it in that direction
                  only.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                This starts a node on your side and tells them you are ready. About 10 ADA moves
                from this wallet to that node to cover the head&apos;s on-chain fees, separate from
                whatever you later put into the head.
              </p>
              {errors.wallet && <p className="text-xs text-destructive">{errors.wallet}</p>}
              <p className="text-xs text-muted-foreground">
                Your side is the one that opens the head. You do that from the head itself, once
                both nodes have found each other, usually within a minute.
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
              <Button
                type="button"
                onClick={() => void handlePreview()}
                disabled={isLoading || !isHeadCapableSource}
              >
                {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                Read invite
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  // The next invite may be from the other side, which makes a
                  // wallet chosen here invalid rather than merely stale.
                  setPreview(null);
                  setAcceptedTerms(false);
                  setHotWalletId('');
                  setErrors({});
                  setAllowInsecureExchangeHttp(false);
                  setAllowPrivateExchangeNetwork(false);
                }}
              >
                Back
              </Button>
              <Button
                type="button"
                onClick={() => void handleRedeem()}
                disabled={
                  isLoading ||
                  !preview.signatureValid ||
                  (isInsecureExchangeHttp && !allowInsecureExchangeHttp) ||
                  (needsPrivateNetworkConsent && !allowPrivateExchangeNetwork)
                }
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                Redeem and set up
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
