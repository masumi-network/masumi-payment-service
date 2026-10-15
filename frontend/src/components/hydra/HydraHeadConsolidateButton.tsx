/**
 * Merge this node's in-head UTxOs into one.
 *
 * Payouts and refunds leave a wallet holding many small UTxOs inside the head.
 * Merging them is a free in-head self-send that confirms in about a second, so
 * this is a single button with no amount and no list of what is in flight.
 */

import { useState } from 'react';
import { toast } from 'react-toastify';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useResync } from '@/lib/hooks/useResync';
import { consolidateHydraHead, useHydraHeadBalance } from '@/lib/hooks/useHydraHeads';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { InfoHint } from '@/components/ui/info-hint';

/**
 * Fewer than this and a round changes nothing: two UTxOs become the merged one
 * plus the collateral one. The backend refuses that, so the button does too.
 */
const MIN_UTXOS_TO_MERGE = 3;

interface HydraHeadConsolidateButtonProps {
  headId: string;
  /** An in-head transaction needs an Open head. */
  isOpen: boolean;
}

export function HydraHeadConsolidateButton({ headId, isOpen }: HydraHeadConsolidateButtonProps) {
  const { apiClient } = useAppContext();
  const resync = useResync();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { data: balance, refetch: refetchBalance } = useHydraHeadBalance(headId, isOpen);

  if (!isOpen) return null;

  const utxoCount = balance?.utxoCount ?? null;

  const handleConsolidate = async () => {
    setIsSubmitting(true);
    try {
      const result = await consolidateHydraHead(apiClient, { headId });
      toast.success(
        result.remainingCount > 0
          ? `Merged ${result.inputCount} UTxOs. ${result.remainingCount} remain; consolidate again to merge them.`
          : `Merged ${result.inputCount} UTxOs into ${result.outputCount}.`,
      );
      await resync('hydra', 'wallets');
      await refetchBalance();
    } catch (error) {
      // The API layer toasts the cause; catching keeps it from escaping the handler.
      console.error('Hydra consolidation failed', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border p-4">
      <div>
        <h4 className="flex items-center gap-1.5 text-sm font-medium">
          Consolidate UTxOs
          <InfoHint label="About consolidating UTxOs">
            <p>
              Spends up to 100 of this wallet&apos;s UTxOs in the head and produces one that carries
              everything, plus a 5 ADA UTxO kept as collateral when the funds allow it. It costs
              nothing and nothing leaves the head.
            </p>
            <p>
              UTxOs still arriving from a deposit, and UTxOs holding a reference script, stay as
              they are. Escrow payouts arrive tagged with a datum. Merging them also clears the
              tags, so new purchases can spend those funds.
            </p>
          </InfoHint>
        </h4>
        <p className="text-xs text-muted-foreground">
          {utxoCount === null
            ? 'Merges this wallet’s in-head UTxOs.'
            : `This wallet holds ${utxoCount} UTxO${utxoCount === 1 ? '' : 's'} in the head.`}
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={() => void handleConsolidate()}
        disabled={isSubmitting || (utxoCount !== null && utxoCount < MIN_UTXOS_TO_MERGE)}
      >
        {isSubmitting && <Spinner className="mr-2 h-4 w-4" />}
        Consolidate
      </Button>
    </div>
  );
}
