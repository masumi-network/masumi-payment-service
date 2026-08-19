import { useEffect, useMemo, useState } from 'react';
import { useHydraHeadBalance, useHydraTopups, type HydraTopup } from '@/lib/hooks/useHydraHeads';
import { formatAssetAmount } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { HeadBalanceHint } from '@/components/hydra/hydra-hints';

interface HydraHeadInHeadBalanceProps {
  headId: string;
  /** In-head funds are only readable while the head is Open (live snapshot). */
  isOpen: boolean;
  network: string | undefined;
}

/**
 * Shows THIS node's own funds currently inside the head (ADA + native tokens),
 * the local participant's committed balance, not the counterparty's. Read live
 * from the head snapshot via GET /hydra/head/balance.
 */
export function HydraHeadInHeadBalance({ headId, isOpen, network }: HydraHeadInHeadBalanceProps) {
  const { data, isLoading, isError } = useHydraHeadBalance(headId, isOpen);
  const { topups } = useHydraTopups(headId, isOpen);
  // Confirmed on L1 says the deposit transaction landed. It says nothing about
  // the head absorbing it: that takes a snapshot both parties sign, and if it
  // has not happened by the deposit's deadline it never will. Reporting those
  // two states the same way left a head reading "being folded in" indefinitely.
  // The clock is read in an effect rather than during render: a deposit's
  // deadline passes while the page is open, and reading the time mid-render
  // would make the same state render differently on an unrelated re-render.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // Ticked from a timer rather than set on mount: an effect that assigns
    // state synchronously just re-renders immediately for no gain, and one
    // deadline never turns on a single frame's precision.
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    const first = setTimeout(() => setNow(Date.now()), 0);
    return () => {
      clearInterval(timer);
      clearTimeout(first);
    };
  }, []);

  const { hasSettlingDeposit, hasExpiredDeposit } = useMemo(() => {
    // Before the first tick nothing is called expired: claiming a deadline has
    // passed is the assertion that needs evidence.
    //
    // Measured against absorbBy, not the deadline. A node refuses a deposit
    // with less than one deposit period left, so the head stops taking it a
    // whole period before the deadline — and judging by the deadline called a
    // dead deposit "settling" for that entire period.
    const isStillFoldable = (topup: HydraTopup) =>
      now === null || topup.absorbBy == null || new Date(topup.absorbBy).getTime() > now;
    return {
      hasSettlingDeposit: topups.some(
        (topup) =>
          (topup.status === 'Confirmed' ||
            topup.status === 'Pending' ||
            topup.status === 'Preparing') &&
          isStillFoldable(topup),
      ),
      hasExpiredDeposit: topups.some(
        (topup) => topup.status === 'Confirmed' && !isStillFoldable(topup),
      ),
    };
  }, [topups, now]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 font-medium">
          Your in-head balance
          <HeadBalanceHint />
        </h3>
      </div>

      {!isOpen ? (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          In-head balance is available once the head is open.
        </div>
      ) : isLoading ? (
        <div className="flex items-center gap-2 rounded-md border p-4 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" /> Reading head snapshot…
        </div>
      ) : isError || !data ? (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Could not read the in-head balance.
        </div>
      ) : !data.connected ? (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Not connected to the head, so the balance is unavailable.
        </div>
      ) : data.balance.length === 0 ? (
        // A confirmed deposit is on L1 but not yet folded into the L2 ledger,
        // Hydra increments the head separately, and until it does the in-head
        // balance is genuinely zero. Saying "nothing committed" while a deposit
        // sits Confirmed below reads as a contradiction.
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {hasSettlingDeposit
            ? 'A deposit is on chain and waiting for the head to take it. It becomes spendable at the time shown on the deposit below.'
            : hasExpiredDeposit
              ? 'A deposit confirmed on chain but the head never absorbed it before its deadline. The funds are not back in the wallet — they are held at the deposit script until you press Recover on it below, which the node will accept once its deadline passes.'
              : 'Nothing in the head yet. Add funds below.'}
        </div>
      ) : (
        // The amount is the answer; how many UTxOs carry it is a detail, so it
        // is a footnote rather than the headline it used to be.
        <div className="rounded-md border divide-y">
          {data.balance.map((asset) => (
            <div key={asset.unit || 'ada'} className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-muted-foreground">
                {formatFundLabel(asset.unit, network)}
              </span>
              <span className="font-mono text-base font-semibold">
                {formatAssetAmount(asset.quantity, asset.unit || 'lovelace', network)}
              </span>
            </div>
          ))}
          <div className="px-4 py-1.5 text-xs text-muted-foreground">
            held in {data.utxoCount} piece{data.utxoCount === 1 ? '' : 's'}
          </div>
          {/* Said here rather than left to the operator to spot by comparing
              this panel with the deposits list, which is how it was found. */}
          {data.hasUnbackedUtxos === true && (
            <div className="border-t px-4 py-2 text-xs text-amber-600 dark:text-amber-400">
              {formatAssetAmount(data.unbackedLovelace ?? '0', 'lovelace', network)} of this was
              recovered to the wallet on chain, so the head is counting funds it no longer has.
              Closing may fail until it is cleared.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatFundLabel(unit: string, network: string | undefined): string {
  if (unit === '') return network?.toLowerCase() === 'mainnet' ? 'ADA' : 'tADA';
  // formatAssetAmount already appends the friendly unit; keep the left label short.
  return 'Token';
}
