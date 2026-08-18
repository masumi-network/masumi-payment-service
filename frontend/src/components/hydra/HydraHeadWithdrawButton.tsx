/**
 * Take funds back out of an open head.
 *
 * The counterpart to Add funds, and shaped the same way on purpose: an amount,
 * a button, and a list of what is in flight. What differs is what the operator
 * has to be told, because the two directions fail differently.
 *
 * Adding funds is forgiving, a deposit the head never takes sits at a script
 * and can be recovered. Withdrawing is not: once the head signs the removal the
 * value is out of it, and there is no equivalent of recovery. So the copy here
 * leads with what stays behind rather than what leaves, and the one genuinely
 * dangerous option, taking the collateral too, is not a checkbox sitting next
 * to the amount.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { useResync } from '@/lib/hooks/useResync';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  useHydraHeadBalance,
  useHydraWithdrawals,
  withdrawFromHydraHead,
  type HydraWithdrawal,
} from '@/lib/hooks/useHydraHeads';
import { formatAssetAmount, formatFundUnit } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { InHeadTxId, TxLink } from '@/components/hydra/TxLink';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { HydraNotice } from '@/components/hydra/HydraNotice';
import { InfoHint } from '@/components/ui/info-hint';

/** Radix refuses an empty Select value, so ADA needs a name of its own. */
const ADA_CHOICE = 'ada';

interface HydraHeadWithdrawButtonProps {
  headId: string;
  /** Withdrawing is an incremental decommit, only possible on an Open head. */
  isOpen: boolean;
}

/** Same conversion as the top-up form: string concatenation, never floats. */
function adaToLovelace(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  const lovelace = `${whole}${fraction.padEnd(6, '0')}`.replace(/^0+(?=\d)/, '');
  return lovelace === '0' ? null : lovelace;
}

function formatLovelace(lovelace: string, network: string | undefined): string {
  const ticker = network?.toLowerCase() === 'mainnet' ? 'ADA' : 'tADA';
  const padded = lovelace.padStart(7, '0');
  const whole = padded.slice(0, -6).replace(/^0+(?=\d)/, '');
  const fraction = padded.slice(-6).replace(/0+$/, '') || '00';
  return `${Number(whole).toLocaleString()}.${fraction} ${ticker}`;
}

/**
 * Where a withdrawal has got to.
 *
 * Deliberately not a progress bar. The two stages are not "half done" and
 * "done": at Approved the money has already left the head, and only its arrival
 * on L1 is outstanding. An operator reading this needs to know which side of
 * that line they are on, because it decides whether cancelling is even a
 * question.
 */
function statusLabel(row: HydraWithdrawal): { label: string; tone: string; spinning: boolean } {
  switch (row.status) {
    case 'Preparing':
      return { label: 'Splitting', tone: 'text-amber-600 dark:text-amber-400', spinning: true };
    case 'Pending':
      return {
        label: 'Awaiting the head',
        tone: 'text-amber-600 dark:text-amber-400',
        spinning: true,
      };
    case 'Approved':
      return { label: 'Paying out', tone: 'text-amber-600 dark:text-amber-400', spinning: true };
    case 'Finalized':
      return { label: 'Settled', tone: 'text-green-600 dark:text-green-400', spinning: false };
    default:
      return { label: 'Refused', tone: 'text-red-600 dark:text-red-400', spinning: false };
  }
}

function HydraWithdrawalList({
  headId,
  isOpen,
  network,
  startedAt,
}: {
  headId: string;
  isOpen: boolean;
  network: string | undefined;
  /** When one was last started here, so a new row is watched for. */
  startedAt: number | null;
}) {
  const { withdrawals, isError, refetch } = useHydraWithdrawals(headId, isOpen, startedAt);

  // Told apart from having none, for the same reason the deposits list does it:
  // a withdrawal takes minutes across two systems, and a section that vanishes
  // while one is in flight reads as "it never started".
  if (isError && withdrawals.length === 0) {
    return (
      <div className="space-y-2 border-t pt-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Withdrawals
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-destructive/40 px-3 py-2">
          <span className="text-sm text-muted-foreground">
            Could not read this head&apos;s withdrawals. Any that are in flight are unaffected.
          </span>
          <Button type="button" size="sm" variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (withdrawals.length === 0) return null;

  return (
    <div className="space-y-2 border-t pt-3">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Withdrawals
        <InfoHint label="About withdrawals">
          <p>
            Funds leave in two steps. First both nodes sign a snapshot that removes them from the
            head, then this head&apos;s node posts the transaction that pays them out on chain.
          </p>
          <p>
            After the first step the money is out of the head whatever happens next, so a withdrawal
            that is paying out cannot be called back.
          </p>
        </InfoHint>
      </p>
      <ul className="divide-y rounded-md border">
        {withdrawals.map((row) => {
          const status = statusLabel(row);
          return (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <Badge variant="outline" className={status.tone}>
                  {status.spinning && <Spinner className="mr-1 h-3 w-3" />}
                  {status.label}
                </Badge>
                {/* What settled once L1 has it, what was asked for until then.
                    Both are on the row and they differ routinely: a decommit
                    takes whole outputs, and the decrement's fee comes out of
                    the value that travels. */}
                <span className="flex flex-wrap items-baseline gap-x-2 font-mono text-sm">
                  {Object.entries(row.settledAssets ?? row.requestedAssets ?? {}).map(
                    ([unit, quantity]) => (
                      <span key={unit}>{formatAssetAmount(quantity, unit, network)}</span>
                    ),
                  )}
                  <span
                    className={
                      Object.keys(row.settledAssets ?? row.requestedAssets ?? {}).length > 0
                        ? 'text-xs text-muted-foreground'
                        : undefined
                    }
                  >
                    {formatLovelace(row.settledLovelace ?? row.requestedLovelace, network)}
                  </span>
                </span>
              </div>
              {/* The payout when there is one, and the in-head id otherwise.
                  Never the in-head id as a link: it names a transaction that
                  only existed inside the head, so an explorer 404s on it. */}
              <span className="flex items-center gap-1">
                {row.l1TxId !== null ? (
                  <TxLink label="Paid out by" hash={row.l1TxId} network={network} fallback={null} />
                ) : row.decommitTxId === null ? (
                  <span className="text-xs text-muted-foreground">building</span>
                ) : (
                  <InHeadTxId label="In head" hash={row.decommitTxId} />
                )}
              </span>
              {row.status === 'Failed' && (
                // Nothing left the head, which is the part to hear first. The
                // node's own wording follows, because it names the rule that was
                // broken and that decides what to do differently.
                <p className="w-full text-xs text-muted-foreground">
                  Nothing left the head, so it is safe to try again.
                  {row.failureReason ? ` The node said: ${row.failureReason}` : ''}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function HydraHeadWithdrawButton({ headId, isOpen }: HydraHeadWithdrawButtonProps) {
  const { apiClient, network } = useAppContext();
  const resync = useResync();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [isDraining, setIsDraining] = useState(false);
  // Offered from what the head actually holds rather than typed from memory: a
  // policy id and asset name is 100+ characters, and the head already knows
  // which ones are there to take.
  // 'ada' rather than '' because Radix refuses an empty Select value, and the
  // whole panel throws rather than the field misbehaving.
  const [assetUnit, setAssetUnit] = useState(ADA_CHOICE);
  const {
    data: balance,
    isPending: isBalancePending,
    refetch: refetchBalance,
  } = useHydraHeadBalance(headId, isOpen);
  // Nothing is offered from a balance nobody could read. The asset list is
  // derived from it, so an unread balance looks exactly like a head holding
  // only ADA — which silently turns a token amount already typed into the field
  // into that many lovelace.
  const isBalanceKnown = balance != null;
  const heldAssets = (balance?.balance ?? []).filter((asset) => asset.unit !== '');
  // Withdrawing the last of a token unmounts the Select that chose it, so a
  // remembered choice would leave the form submitting an asset the head no
  // longer holds, with no control left to change it back. Derived rather than
  // stored, so the selection can never outlive the option.
  const selectedUnit =
    assetUnit === ADA_CHOICE || heldAssets.some((asset) => asset.unit === assetUnit)
      ? assetUnit
      : ADA_CHOICE;

  if (!isOpen) return null;

  const adaLabel = network?.toLowerCase() === 'mainnet' ? 'ADA' : 'tADA';

  async function submit(payload: {
    lovelace?: string;
    assetUnit?: string;
    assetAmount?: string;
    drain?: boolean;
  }) {
    setIsSubmitting(true);
    try {
      await withdrawFromHydraHead(apiClient, { headId, ...payload });
      toast.success('Withdrawal started. It appears below, and on chain once the head signs it.');
      await resync('hydra', 'wallets');
      setAmount('');
      setIsDraining(false);
      setStartedAt(Date.now());
      await queryClient.invalidateQueries({ queryKey: ['hydra-withdrawals', headId] });
    } catch (error) {
      // The API layer toasts the cause. Catching keeps a failed withdrawal from
      // leaving the handler as an unhandled rejection, and keeps the form's
      // amount intact so it can be tried again.
      console.error('Hydra withdrawal failed', error);
    } finally {
      setIsSubmitting(false);
    }
  }

  const handleWithdraw = async () => {
    if (selectedUnit !== ADA_CHOICE) {
      // A native asset is counted in its own smallest unit, so there is no
      // decimal conversion to do and a fraction would be meaningless.
      const assetAmount = amount.trim();
      if (!/^\d+$/.test(assetAmount) || assetAmount === '0') {
        toast.error('Enter how much to take out, as a whole number');
        return;
      }
      await submit({ assetUnit: selectedUnit, assetAmount });
      return;
    }
    const lovelace = adaToLovelace(amount);
    if (lovelace === null) {
      toast.error(`Enter how much ${adaLabel} to take out of the head`);
      return;
    }
    await submit({ lovelace });
  };

  return (
    <div className="space-y-3 rounded-md border p-4">
      <div>
        <h4 className="flex items-center gap-1.5 text-sm font-medium">
          Take funds out
          <InfoHint label="About taking funds out">
            <p>
              Moves funds from the head back to this head&apos;s wallet on chain, without closing
              the head. Both nodes have to sign, so this needs the counterparty to be reachable.
            </p>
            <p>
              5 {adaLabel} stays behind as collateral. Spending an escrow inside the head requires
              it, so a wallet without any can no longer settle payments here.
            </p>
          </InfoHint>
        </h4>
        <p className="text-xs text-muted-foreground">
          The head keeps working. Funds arrive in the wallet once the payout confirms on chain.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        {heldAssets.length > 0 && (
          <div className="space-y-1.5">
            <Label htmlFor={`hydra-withdraw-asset-${headId}`}>Asset</Label>
            <Select value={selectedUnit} onValueChange={setAssetUnit}>
              <SelectTrigger id={`hydra-withdraw-asset-${headId}`} className="w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ADA_CHOICE}>{adaLabel}</SelectItem>
                {heldAssets.map((asset) => (
                  <SelectItem key={asset.unit} value={asset.unit}>
                    {formatFundUnit(asset.unit, network)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor={`hydra-withdraw-${headId}`}>Amount</Label>
          <div className="relative">
            <Input
              id={`hydra-withdraw-${headId}`}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder={selectedUnit === ADA_CHOICE ? '0.00' : '0'}
              inputMode={selectedUnit === ADA_CHOICE ? 'decimal' : 'numeric'}
              className="w-44 pr-16 font-mono"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 max-w-14 truncate text-xs text-muted-foreground">
              {selectedUnit === ADA_CHOICE ? adaLabel : formatFundUnit(selectedUnit, network)}
            </span>
          </div>
          {selectedUnit !== ADA_CHOICE && (
            /* Worth saying before the click, not after: the number is the
               token's smallest unit even though the field is labelled with its
               ticker, and a token cannot travel alone, so the payout arrives
               with roughly 2 ADA carrying it and the rest of the ADA it was
               sitting on stays in the head. */
            <p className="max-w-sm text-xs text-muted-foreground">
              Enter a whole number in {formatFundUnit(selectedUnit, network)}&apos;s smallest unit,
              not {adaLabel}. The token is moved onto its own UTxO first, so about 2 {adaLabel} goes
              out with it to carry it. Any other {adaLabel} it shares a UTxO with stays in the head.
            </p>
          )}
        </div>

        <Button onClick={() => void handleWithdraw()} disabled={isSubmitting || !isBalanceKnown}>
          {isSubmitting && !isDraining ? (
            <>
              <Spinner className="mr-2 h-4 w-4" /> Taking out…
            </>
          ) : (
            'Take out'
          )}
        </Button>
      </div>

      {/* The first fetch is not a failure. `data` is undefined until it lands, so
          reading that alone told every operator opening the panel that the head's
          contents could not be read — for the second or two before they were. */}
      {!isBalanceKnown && isBalancePending && (
        <p className="text-xs text-muted-foreground">Reading what this head holds…</p>
      )}

      {!isBalanceKnown && !isBalancePending && (
        <p className="text-xs text-muted-foreground">
          What this head holds could not be read, so there is nothing to take out from.{' '}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => void refetchBalance()}
          >
            Try again
          </button>
        </p>
      )}

      {/* Behind a confirmation rather than a checkbox beside the amount. Taking
          the collateral is not a variation on withdrawing, it ends this
          wallet's ability to settle anything in the head, and the balance gives
          no hint of that afterwards. */}
      {isDraining ? (
        <HydraNotice tone="warn">
          <p>
            Taking everything leaves no collateral, so this wallet can no longer submit results,
            collect, or refund inside this head. That is why the service refuses the drain outright
            while any escrow is still live here — settle those first, or withdraw an amount instead.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={isSubmitting || !isBalanceKnown}
              onClick={() => void submit({ drain: true })}
            >
              {isSubmitting && <Spinner className="mr-2 h-4 w-4" />}
              Take everything out
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isSubmitting}
              onClick={() => setIsDraining(false)}
            >
              Cancel
            </Button>
          </div>
        </HydraNotice>
      ) : (
        <button
          type="button"
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => setIsDraining(true)}
        >
          Winding this head down? Take everything out, including the collateral
        </button>
      )}

      <HydraWithdrawalList
        headId={headId}
        isOpen={isOpen}
        network={network}
        startedAt={startedAt}
      />
    </div>
  );
}
