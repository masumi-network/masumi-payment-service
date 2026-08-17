/**
 * Put more funds into an open head.
 *
 * An amount, and nothing else. The previous form asked which UTxOs to commit
 * and then, separately, for an exact amount in lovelace, which is the
 * machinery, not the decision. An operator wants to move 5 ADA into a head;
 * whether that needs a dedicated UTxO split first is the service's problem, and
 * it already solves it: an exact amount pre-splits an L1 UTxO and commits that.
 *
 * Denominated in ADA rather than lovelace for the same reason. Every other
 * amount an operator types in this admin is in ADA.
 *
 * Native assets stay first-class rather than hidden: the stablecoin an operator
 * is most likely to move is a preset, and anything else is one field away. The
 * presets are the same units the invoice formatter already recognises, so a
 * token that renders as "tUSDM" on an invoice is the same token here.
 */

import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { formatAssetAmount, getExplorerUrl } from '@/lib/utils';
import { useResync } from '@/lib/hooks/useResync';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  recoverHydraTopup,
  topupHydraHead,
  useHydraTopups,
  type HydraTopup,
  type HydraTopupRequest,
} from '@/lib/hooks/useHydraHeads';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { TxLink } from '@/components/hydra/TxLink';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { DepositPeriodHint } from '@/components/hydra/hydra-hints';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface HydraHeadTopupButtonProps {
  headId: string;
  /** Top-ups are incremental commits, only possible on an Open head. */
  isOpen: boolean;
}

/**
 * Assets an operator can put into a head, per network.
 *
 * The stablecoin units are the same constants the invoice formatter recognises
 * (`src/utils/invoice/template.ts`) rather than new ones, so a token that
 * renders as "tUSDM" on an invoice is the same token here. Preprod has no USDC
 * deployment worth presetting, which is why the two lists differ rather than
 * being one list with a network switch.
 */
const PRESET_ASSETS: Record<'Preprod' | 'Mainnet', Array<{ label: string; unit: string }>> = {
  Preprod: [
    {
      label: 'tUSDM',
      unit: '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d',
    },
  ],
  Mainnet: [
    {
      label: 'USDM',
      unit: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d',
    },
    { label: 'USDCx', unit: '1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e345553444378' },
  ],
};

/** `ada` covers the common case; the rest name a native asset. */
type AssetChoice = 'ada' | 'custom' | string;

/**
 * Parse an ADA amount into a lovelace string.
 *
 * Built by concatenation rather than arithmetic: the API takes a decimal string
 * anyway, and multiplying by a million in floating point is how 0.1 ADA becomes
 * 99999.99999999999 lovelace. Nothing finer than one lovelace is accepted,
 * because nothing finer exists.
 */
function adaToLovelace(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    return null;
  }
  const [whole, fraction = ''] = trimmed.split('.');
  const lovelace = `${whole}${fraction.padEnd(6, '0')}`.replace(/^0+(?=\d)/, '');
  return lovelace === '0' ? null : lovelace;
}

/**
 * What has been deposited, and what is still on its way.
 *
 * A top-up is minutes of on-chain work, so the only honest feedback is a list
 * that outlives the request: submitting returns immediately and the row shows
 * up here, moving Pending to Confirmed on its own.
 */
/**
 * Lovelace as a decimal with the network's own ticker.
 *
 * The shared formatter reports "ADA" for lovelace on every network, so a
 * preprod deposit read as ADA next to a tADA balance in the same dialog.
 * Corrected here rather than in the shared helper, which every other screen
 * depends on.
 */
function formatLovelace(lovelace: string, network: string | undefined): string {
  const ticker = network?.toLowerCase() === 'mainnet' ? 'ADA' : 'tADA';
  const padded = lovelace.padStart(7, '0');
  const whole = padded.slice(0, -6).replace(/^0+(?=\d)/, '');
  const fraction = padded.slice(-6).replace(/0+$/, '') || '00';
  return `${Number(whole).toLocaleString()}.${fraction} ${ticker}`;
}

/**
 * One transaction on a deposit row, named and linkable.
 *
 * Every hash here is an ordinary L1 transaction, so it is worth linking: the
 * only way an operator could previously check a deposit was to copy the hash
 * and paste it into an explorer, which is precisely the moment they are least
 * sure anything happened.
 *
 * Labelled, because a row shows the deposit once it exists and the split that
 * precedes it until then, and those are different transactions moving different
 * amounts.
 */
function HydraTopupList({
  headId,
  isOpen,
  network,
  onRetry,
}: {
  headId: string;
  isOpen: boolean;
  network: string | undefined;
  /** Re-runs a failed ADA deposit for the same amount. */
  onRetry: (topup: { committedLovelace: string }) => void;
}) {
  const { apiClient } = useAppContext();
  const resync = useResync();
  const { topups, isError, refetch } = useHydraTopups(headId, isOpen);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    const first = setTimeout(() => setNow(Date.now()), 0);
    return () => {
      clearInterval(tick);
      clearTimeout(first);
    };
  }, []);

  // Until the clock is read, nothing is claimed to be usable: saying money is
  // in the head when it is not is the error that matters here.
  const isUsable = (topup: HydraTopup) =>
    now !== null && topup.usableFrom != null && new Date(topup.usableFrom).getTime() <= now;
  const [recoveringId, setRecoveringId] = useState<string | null>(null);

  async function handleRecover(topupId: string) {
    setRecoveringId(topupId);
    try {
      const result = await recoverHydraTopup(apiClient, { topupId });
      await resync('hydra', 'wallets');
      toast[result.requested ? 'success' : 'info'](
        result.requested
          ? 'Recovery posted. Funds return once it confirms.'
          : (result.reason ?? 'Nothing to recover'),
      );
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The recovery failed');
    } finally {
      setRecoveringId(null);
    }
  }

  // A failed read is not an empty list. Drawn as one, the whole Deposits
  // section disappears — no rows, no error, no way back — while the section
  // beside it says in as many words that nothing is in the head yet, which is
  // exactly how an operator ends up sending a second deposit.
  if (isError && topups.length === 0) {
    return (
      <div className="space-y-2 border-t pt-3">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Deposits
          <DepositPeriodHint />
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-destructive/40 px-3 py-2">
          <span className="text-sm text-muted-foreground">
            Could not read this head&apos;s deposits. Any that are in flight are unaffected.
          </span>
          <Button type="button" size="sm" variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (topups.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2 border-t pt-3">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Deposits
        <DepositPeriodHint />
      </p>
      <ul className="divide-y rounded-md border">
        {topups.map((topup) => {
          // The node refuses a recovery until the deposit's own deadline has
          // passed, and turns that refusal into a red toast. Before then the
          // deposit is either still waiting to be absorbed or already in the
          // head, so offering the button read as "your funds are stuck" for a
          // deposit that was behaving exactly as designed.
          const recoverableFrom =
            topup.deadline == null ? null : new Date(topup.deadline).getTime();
          const isRecoverable = recoverableFrom === null || Date.now() >= recoverableFrom;

          return (
            <li key={topup.id} className="space-y-1 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {/* Confirmed is about the transaction, not about the head. Between
                  the two the money is on chain, committed to this head, and
                  unusable, which read as success when both said "Confirmed". */}
                  <Badge
                    variant="outline"
                    // Green only where something proves it. `Absorbed` is set from
                    // on-chain evidence that the head spent the deposit output;
                    // everything before it is amber, because the times only say
                    // when a deposit became eligible, never that it arrived.
                    className={
                      topup.status === 'Failed'
                        ? 'text-red-600 dark:text-red-400'
                        : topup.status === 'Recovered' || topup.status === 'Absorbed'
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-amber-600 dark:text-amber-400'
                    }
                  >
                    {(topup.status === 'Pending' || topup.status === 'Preparing') && (
                      <Spinner className="mr-1 h-3 w-3" />
                    )}
                    {topup.status === 'Recovered'
                      ? 'Returned'
                      : topup.status === 'Absorbed'
                        ? 'In the head'
                        : topup.status === 'Failed'
                          ? 'Expired'
                          : topup.status === 'Preparing'
                            ? 'Preparing'
                            : topup.status === 'Pending'
                              ? 'Sending'
                              : isUsable(topup)
                                ? 'Submitted'
                                : 'Settling'}
                  </Badge>
                  {/* Tokens first, carrier ADA second, as the withdrawal rows do.
                  A native-asset deposit commits a UTxO that holds both, and
                  showing only the lovelace named a different asset and a
                  different amount than the one that was actually sent. */}
                  <span className="flex flex-wrap items-baseline gap-x-2 font-mono text-sm">
                    {Object.entries(topup.committedAssets ?? {}).map(([unit, quantity]) => (
                      <span key={unit}>{formatAssetAmount(quantity, unit, network)}</span>
                    ))}
                    {/* A whole-UTxO top-up commits whatever the selection turns out
                    to hold, so the amount is unknown until the deposit is built.
                    Zero would read as "nothing moved". */}
                    <span
                      className={
                        Object.keys(topup.committedAssets ?? {}).length > 0
                          ? 'text-xs text-muted-foreground'
                          : undefined
                      }
                    >
                      {topup.status === 'Preparing' && topup.committedLovelace === '0'
                        ? 'amount pending'
                        : formatLovelace(topup.committedLovelace, network)}
                    </span>
                  </span>
                </div>
                {/* One transaction per row, named for what it is. The hash used to
                sit between two different notes depending on state, "splitting"
                before it, "back in the wallet" after, so the same column read
                in a different order on every line. */}
                <TxLink
                  label={topup.depositTxHash === null ? 'split' : 'deposit'}
                  hash={topup.depositTxHash ?? topup.splitTxHash ?? null}
                  network={network}
                  fallback={topup.depositTxHash === null ? 'building the split' : null}
                />
              </div>

              {/* Everything that is a note about the row, on its own line and in one
              place, rather than trailing the hash. */}
              <div className="flex w-full flex-wrap items-center gap-2">
                {topup.status === 'Recovered' && (
                  <span className="text-xs text-muted-foreground">Back in the wallet.</span>
                )}
                {topup.status === 'Confirmed' && !isUsable(topup) && topup.usableFrom != null && (
                  <span className="text-xs text-muted-foreground">
                    Usable {new Date(topup.usableFrom).toLocaleTimeString()}.
                  </span>
                )}
                {/* Expired rows can hold funds too. A deposit reaches Failed on our
                own evidence that its transaction was absent past its deadline,
                and that evidence can be wrong — a lagging or rolled-back chain
                view reads the same as an absence. The reconciler already treats
                a Failed row as one that may still turn out absorbed or
                recovered; hiding the button meant the one case where funds sit
                at the deposit script had no way to ask for them back. */}
                {(topup.status === 'Confirmed' || topup.status === 'Failed') &&
                  topup.depositTxHash !== null &&
                  !isRecoverable &&
                  recoverableFrom !== null && (
                    <span className="text-xs text-muted-foreground">
                      The node can only send it back after{' '}
                      {new Date(recoverableFrom).toLocaleTimeString()}, once the head can no longer
                      take it in.
                    </span>
                  )}
                {(topup.status === 'Confirmed' || topup.status === 'Failed') &&
                  topup.depositTxHash !== null &&
                  isRecoverable &&
                  (topup.recoveryRequestedAt != null ? (
                    <span className="text-xs text-muted-foreground">
                      Recovery posted {new Date(topup.recoveryRequestedAt).toLocaleTimeString()}.
                      Waiting for it on chain.
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={recoveringId === topup.id}
                      onClick={() => void handleRecover(topup.id)}
                      title="Ask the node to return this deposit, if the head never took it"
                    >
                      {recoveringId === topup.id && <Spinner className="mr-1 h-3 w-3" />}
                      Recover
                    </Button>
                  ))}
                {topup.status === 'Failed' &&
                  Object.keys(topup.committedAssets ?? {}).length === 0 && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onRetry(topup)}
                      title="Fills this amount back into the form. Nothing is sent until you press Add funds"
                    >
                      Try again
                    </Button>
                  )}
              </div>

              {topup.status === 'Failed' &&
                (topup.depositTxHash === null ? (
                  // Failed while preparing, so no deposit was ever signed. There
                  // is nothing on chain under any reading of the evidence.
                  <p className="w-full text-xs text-muted-foreground">
                    The deposit was never built, so nothing left the wallet. Adding the funds again
                    is safe.
                  </p>
                ) : (
                  // Expiry itself is a ledger rule: past its invalid-hereafter
                  // slot the transaction can never be included. What is inferred
                  // rather than proven is that it was absent before then, and that
                  // came from our own chain lookup, so the row no longer promises
                  // the funds are home. Recover is the answer if it did land.
                  <p className="w-full text-xs text-muted-foreground">
                    The deposit transaction was not on chain by its deadline, so it can never be
                    included now and the funds should still be in the wallet. If it did land and the
                    head never took it in, Recover asks the node to return it.
                  </p>
                ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function HydraHeadTopupButton({ headId, isOpen }: HydraHeadTopupButtonProps) {
  const { apiClient, network } = useAppContext();
  const resync = useResync();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [asset, setAsset] = useState<AssetChoice>('ada');
  const [customUnit, setCustomUnit] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Only the head being Open matters. Requiring a prior commit hid the button
  // on exactly the heads that need it: one opened with an empty commit has no
  // funds and no other way to get them.
  if (!isOpen) return null;

  const adaLabel = network?.toLowerCase() === 'mainnet' ? 'ADA' : 'tADA';

  const presets = PRESET_ASSETS[network === 'Mainnet' ? 'Mainnet' : 'Preprod'];
  const isAda = asset === 'ada';
  const isCustom = asset === 'custom';
  const selectedUnit = isCustom ? customUnit.trim() : isAda ? '' : asset;
  const unitLabel = isAda
    ? adaLabel
    : (presets.find((preset) => preset.unit === asset)?.label ?? 'tokens');

  const handleTopup = async () => {
    if (!isAda && !/^[0-9a-fA-F]{56,120}$/.test(selectedUnit)) {
      toast.error('Enter a valid asset unit (policyId + assetName in hex)');
      return;
    }

    // An amount is the whole point of the control, whichever asset it is in.
    // Native assets have their own decimals, so the ADA conversion applies only
    // to ADA; a token amount is taken as its own base unit.
    let exact: string | null;
    if (isAda) {
      exact = adaToLovelace(amount);
      if (exact === null) {
        toast.error(`Enter how much ${adaLabel} to move into the head`);
        return;
      }
    } else {
      const trimmed = amount.trim();
      if (!/^\d+$/.test(trimmed) || trimmed === '0') {
        toast.error(`Enter how many ${unitLabel} to move into the head, as a whole number`);
        return;
      }
      exact = trimmed;
    }

    const payload: HydraTopupRequest = isAda
      ? { headId, assetFilter: 'ada-only' }
      : { headId, assetUnit: selectedUnit };
    payload.exactAmount = exact;

    setIsSubmitting(true);
    try {
      await topupHydraHead(apiClient, payload);
      toast.success('Deposit started.');
      await resync('hydra', 'wallets');
      setAmount('');
      // The request returns before the deposit row exists: the work is
      // fire-and-forget, so a single refetch here races it and finds nothing.
      // Telling the operator it "appears below" and then not showing it is
      // worse than waiting the second it actually takes.
      //
      // Waited on the count, not on emptiness. Asking "are there any rows" is
      // answered instantly by an earlier deposit, which is the normal case for
      // every head after its first: the wait ended before the new row existed,
      // the poll then saw nothing preparing and stayed off, and the deposit
      // stayed invisible until the dialog was reopened.
      const rowsBefore =
        queryClient.getQueryData<HydraTopup[]>(['hydra-topups', headId])?.length ?? 0;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await queryClient.invalidateQueries({ queryKey: ['hydra-topups', headId] });
        const rows = queryClient.getQueryData<HydraTopup[]>(['hydra-topups', headId]);
        if ((rows?.length ?? 0) > rowsBefore) break;
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    } catch (error) {
      // The API layer has already toasted the cause; what is left is to stop
      // the rejection escaping an event handler, where it becomes an unhandled
      // rejection and a dev-overlay error rather than a failed top-up.
      console.error('Hydra top-up failed', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border p-4">
      <div>
        <h4 className="text-sm font-medium">Add funds</h4>
        <p className="text-xs text-muted-foreground">Arrives once the deposit confirms on chain.</p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <Label htmlFor={`hydra-topup-asset-${headId}`}>Asset</Label>
          <Select value={asset} onValueChange={setAsset}>
            <SelectTrigger id={`hydra-topup-asset-${headId}`} className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ada">{adaLabel}</SelectItem>
              {presets.map((preset) => (
                <SelectItem key={preset.unit} value={preset.unit}>
                  {preset.label}
                </SelectItem>
              ))}
              <SelectItem value="custom">Custom asset…</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`hydra-topup-${headId}`}>Amount</Label>
          <div className="relative">
            <Input
              id={`hydra-topup-${headId}`}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder={isAda ? '0.00' : '0'}
              inputMode={isAda ? 'decimal' : 'numeric'}
              className="w-44 pr-16 font-mono"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 max-w-14 truncate text-xs text-muted-foreground">
              {unitLabel}
            </span>
          </div>
          {!isAda && (
            /* The ticker beside the field is the token's display name, but the
               number sent is its smallest unit — 1 tUSDM is 1000000 here, and
               the balances above are shown converted. Said for every token, not
               only the hand-typed ones: a preset is exactly as easy to get
               wrong by a factor of a million. */
            <p className="max-w-sm text-xs text-muted-foreground">
              Enter a whole number in {unitLabel}&apos;s smallest unit, not {adaLabel}.
            </p>
          )}
        </div>

        <Button onClick={() => void handleTopup()} disabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <Spinner className="mr-2 h-4 w-4" /> Adding…
            </>
          ) : (
            'Add funds'
          )}
        </Button>
      </div>

      {isCustom && (
        <div className="space-y-1.5">
          <Label htmlFor={`hydra-topup-unit-${headId}`}>Asset unit</Label>
          <Input
            id={`hydra-topup-unit-${headId}`}
            value={customUnit}
            onChange={(event) => setCustomUnit(event.target.value)}
            placeholder="policyId + assetName, in hex"
            className="w-full max-w-md font-mono text-xs"
          />
        </div>
      )}

      <HydraTopupList
        headId={headId}
        isOpen={isOpen}
        network={network}
        onRetry={(failed) => {
          // Refills the form rather than resubmitting silently: a deposit moves
          // real funds, and the amount should be confirmed by the person doing
          // it, not replayed behind their back.
          setAsset('ada');
          setAmount((Number(failed.committedLovelace) / 1_000_000).toString());
          toast.info('Amount filled in. Press Add funds to try the deposit again.');
        }}
      />
    </div>
  );
}
