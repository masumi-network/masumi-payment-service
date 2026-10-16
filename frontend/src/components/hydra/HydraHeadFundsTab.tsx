/**
 * The Funds tab: what this node holds in the head, and moving it.
 *
 * The balance is always shown. Below it, one action at a time: adding funds,
 * taking them out, or merging UTxOs. Each form carries its own history, so a
 * deposit is listed under the form that started it. Stacking all three forms
 * and both histories in one column made the dialog a wall of inputs.
 *
 * A head that is not Open still shows the histories. A deposit the head never
 * absorbed comes back only through Recover on its row, so the list must stay
 * reachable after the head closes.
 */

import { useState } from 'react';
import { HydraHeadInHeadBalance } from '@/components/hydra/HydraHeadInHeadBalance';
import { HydraHeadTopupButton } from '@/components/hydra/HydraHeadTopupButton';
import { HydraHeadWithdrawButton } from '@/components/hydra/HydraHeadWithdrawButton';
import { HydraHeadConsolidateButton } from '@/components/hydra/HydraHeadConsolidateButton';
import { cn } from '@/lib/utils';

type FundsAction = 'add' | 'withdraw' | 'merge';

export function HydraHeadFundsTab({
  headId,
  isOpen,
  network,
}: {
  headId: string;
  isOpen: boolean;
  network: string;
}) {
  const [action, setAction] = useState<FundsAction>('add');
  const options: Array<{ value: FundsAction; label: string }> = isOpen
    ? [
        { value: 'add', label: 'Add funds' },
        { value: 'withdraw', label: 'Withdraw' },
        { value: 'merge', label: 'Merge UTxOs' },
      ]
    : [
        { value: 'add', label: 'Deposits' },
        { value: 'withdraw', label: 'Withdrawals' },
      ];
  // Merging needs an Open head, so a head that closed while it was selected
  // falls back to the first option rather than to an empty panel.
  const current = options.some((option) => option.value === action) ? action : 'add';

  return (
    <div className="space-y-6">
      <HydraHeadInHeadBalance headId={headId} isOpen={isOpen} network={network} />

      <div className="space-y-3">
        <div
          role="tablist"
          aria-label="Funds action"
          className="inline-flex rounded-lg border bg-muted/40 p-0.5"
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={current === option.value}
              onClick={() => setAction(option.value)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm transition-colors',
                current === option.value
                  ? 'bg-background font-medium text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        {current === 'add' && <HydraHeadTopupButton headId={headId} isOpen={isOpen} />}
        {current === 'withdraw' && <HydraHeadWithdrawButton headId={headId} isOpen={isOpen} />}
        {current === 'merge' && <HydraHeadConsolidateButton headId={headId} isOpen={isOpen} />}
      </div>
    </div>
  );
}
