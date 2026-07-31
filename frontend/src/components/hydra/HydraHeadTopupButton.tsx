/**
 * Put more funds into an open head.
 *
 * An amount, and nothing else. The previous form asked which UTxOs to commit
 * and then, separately, for an exact amount in lovelace — which is the
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

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { useAppContext } from '@/lib/contexts/AppContext';
import { topupHydraHead, type HydraTopupRequest } from '@/lib/hooks/useHydraHeads';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

export function HydraHeadTopupButton({ headId, isOpen }: HydraHeadTopupButtonProps) {
  const { apiClient, network } = useAppContext();
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
      const result = await topupHydraHead(apiClient, payload);
      toast.success(
        result.confirmed
          ? 'Funds are in the head'
          : 'Deposit submitted — the funds appear once it confirms on chain',
      );
      setAmount('');
      await queryClient.invalidateQueries({ queryKey: ['hydra-head-balance', headId] });
      await queryClient.invalidateQueries({ queryKey: ['hydra-heads'] });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border p-4">
      <div>
        <h4 className="text-sm font-medium">Add funds</h4>
        <p className="text-xs text-muted-foreground">
          Moves funds from this head&apos;s wallet into the head. They arrive once the deposit
          confirms on chain.
        </p>
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
              inputMode="decimal"
              className="w-44 pr-16 font-mono"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 max-w-14 truncate text-xs text-muted-foreground">
              {unitLabel}
            </span>
          </div>
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
          <p className="text-xs text-muted-foreground">
            Amounts for a native asset are in its own smallest unit, not {adaLabel}.
          </p>
        </div>
      )}
    </div>
  );
}
