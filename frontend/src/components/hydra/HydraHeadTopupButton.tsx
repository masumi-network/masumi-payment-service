import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { useAppContext } from '@/lib/contexts/AppContext';
import { topupHydraHead, type HydraTopupRequest } from '@/lib/hooks/useHydraHeads';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface HydraHeadTopupButtonProps {
  headId: string;
  /** Top-ups are incremental commits — only possible on an Open head. */
  isOpen: boolean;
  /** The initial commit must be done before a top-up can add more funds. */
  hasCommitted: boolean;
}

type FilterMode = 'all' | 'ada-only' | 'token';

/**
 * Add more of the local participant's L1 wallet funds into an already-open head
 * (a repeatable incremental commit). Optionally restrict to ADA-only UTxOs or
 * UTxOs holding a specific native-asset unit.
 */
export function HydraHeadTopupButton({ headId, isOpen, hasCommitted }: HydraHeadTopupButtonProps) {
  const { apiClient } = useAppContext();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<FilterMode>('all');
  const [assetUnit, setAssetUnit] = useState('');
  const [exactAmount, setExactAmount] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen || !hasCommitted) return null;

  const handleTopup = async () => {
    const trimmedUnit = assetUnit.trim();
    if (mode === 'token' && !/^[0-9a-fA-F]{56,120}$/.test(trimmedUnit)) {
      toast.error('Enter a valid asset unit (policyId + assetName hex) to top up a specific token');
      return;
    }
    const trimmedExact = exactAmount.trim();
    if (trimmedExact && !/^\d+$/.test(trimmedExact)) {
      toast.error('Exact amount must be a whole number in the base unit (lovelace for ADA)');
      return;
    }

    const payload: HydraTopupRequest =
      mode === 'token'
        ? { headId, assetUnit: trimmedUnit }
        : { headId, assetFilter: mode === 'ada-only' ? 'ada-only' : 'all' };
    if (trimmedExact) payload.exactAmount = trimmedExact;

    setIsSubmitting(true);
    try {
      const result = await topupHydraHead(apiClient, payload);
      toast.success(
        result.confirmed
          ? 'Top-up confirmed on L1'
          : 'Top-up deposit submitted — awaiting L1 confirmation',
      );
      await queryClient.invalidateQueries({ queryKey: ['hydra-head-balance', headId] });
      await queryClient.invalidateQueries({ queryKey: ['hydra-heads'] });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="rounded-md border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">Top up the head</h4>
        <span className="text-xs text-muted-foreground">Commits more of your L1 wallet funds</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={mode} onValueChange={(value) => setMode(value as FilterMode)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All plain UTxOs</SelectItem>
            <SelectItem value="ada-only">ADA-only UTxOs</SelectItem>
            <SelectItem value="token">Specific token…</SelectItem>
          </SelectContent>
        </Select>
        {mode === 'token' && (
          <input
            value={assetUnit}
            onChange={(event) => setAssetUnit(event.target.value)}
            placeholder="policyId + assetName (hex)"
            className="flex h-9 w-[280px] rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        )}
        <input
          value={exactAmount}
          onChange={(event) => setExactAmount(event.target.value)}
          placeholder="exact amount (optional)"
          className="flex h-9 w-[180px] rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button onClick={() => void handleTopup()} disabled={isSubmitting} size="sm">
          {isSubmitting ? (
            <>
              <Spinner className="mr-2 h-4 w-4" /> Topping up…
            </>
          ) : (
            'Top up'
          )}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Each top-up submits an L1 deposit; funds appear in the head once the deposit is confirmed.
      </p>
    </div>
  );
}
