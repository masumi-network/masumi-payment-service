/**
 * The Activity tab: what this head has done.
 *
 * Two questions, kept apart: where the head itself stands on chain (opened,
 * closed, fanned out) and what moved through it (payments, deposits, node
 * fuel). The first is three fixed steps, so it is a short checklist; the
 * second grows without bound, so it pages.
 */

import { Check, Circle } from 'lucide-react';
import { HydraHeadTransactions } from '@/components/hydra/HydraHeadTransactions';
import { HydraInfoSection } from '@/components/hydra/HydraHeadInfoTab';
import { TxLink } from '@/components/hydra/TxLink';
import type { HydraHead } from '@/lib/hooks/useHydraHeads';

function LifecycleStep({
  label,
  hash,
  network,
  pendingReason,
}: {
  label: string;
  hash: string | null | undefined;
  network: string;
  /**
   * What to say instead when the step has not happened yet. These arrive in
   * order, so on a live head most are legitimately absent, and "no hash
   * recorded" for a step that has not happened reads as missing data.
   */
  pendingReason: string;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
      <span className="flex items-center gap-2 text-sm">
        {hash ? (
          <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
        ) : (
          <Circle className="h-4 w-4 text-muted-foreground/50" />
        )}
        <span className={hash ? undefined : 'text-muted-foreground'}>{label}</span>
      </span>
      {hash ? (
        <TxLink hash={hash} network={network} fallback={null} />
      ) : (
        <span className="text-xs text-muted-foreground">{pendingReason}</span>
      )}
    </li>
  );
}

export function HydraHeadActivityTab({ head, network }: { head: HydraHead; network: string }) {
  const isClosing = head.status === 'Closed' || head.status === 'FanoutPossible';

  return (
    <div className="space-y-8">
      <HydraInfoSection title="On chain">
        <ol className="divide-y rounded-lg border">
          <LifecycleStep
            label="Opened"
            hash={head.initTxHash}
            network={network}
            pendingReason="Not opened yet"
          />
          <LifecycleStep
            label="Closed"
            hash={head.closeTxHash}
            network={network}
            pendingReason={isClosing ? 'Closing, hash not observed yet' : 'Still open'}
          />
          <LifecycleStep
            label="Fanned out"
            hash={head.fanoutTxHash}
            network={network}
            pendingReason={
              head.status === 'FanoutPossible'
                ? 'Ready to fan out'
                : 'After close and the dispute window'
            }
          />
        </ol>
      </HydraInfoSection>

      {/* The steps above are the head's own L1 history. This is everything
          that moved through it: ledger rows, deposits and node funding. */}
      <HydraInfoSection title="Transactions">
        <HydraHeadTransactions headId={head.id} network={network} />
      </HydraInfoSection>
    </div>
  );
}
