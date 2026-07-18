import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { CopyButton } from '@/components/ui/copy-button';
import { Plus, Trash2, ExternalLink } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { postWalletTransferFunds, getWalletTransferFunds } from '@/lib/api/generated';
import type { WalletFundTransfer } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useApiMutation } from '@/lib/hooks/useApiMutation';
import { extractApiPayload } from '@/lib/api-response';
import { validateCardanoAddress, shortenAddress, getExplorerUrl } from '@/lib/utils';
import {
  getStablecoinRuleMeta,
  getRuleAssetMetaFromPreset,
  parseDecimalToRawAmount,
} from '@/components/wallets/wallet-details-utils';
import { FundTransferStatusBadge } from '@/components/wallets/FundTransferStatusBadge';
import { formatAda, formatAssetAmount } from '@/components/wallets/fund-transfer-format';
import { toast } from 'react-toastify';

interface TransferFundsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string;
  network: 'Preprod' | 'Mainnet';
  onSuccess?: () => void;
}

// The operator picks the network stablecoin (tUSDM on preprod, USDCx on
// mainnet) by name, or a custom token by hex unit. This mirrors the low-balance
// rule asset model exactly, so the same units and decimals are used everywhere.
type AssetPreset = 'stablecoin' | 'custom';
type AssetFormRow = { preset: AssetPreset; customUnit: string; amount: string };
type AssetPayload = { unit: string; quantity: string };

// Client-side mirror of the API's postWalletFundSchemaInput, so a bad input is
// an inline error before submit rather than an async FailedViaManualReset.
const MIN_ADA = 2;
const MIN_LOVELACE = BigInt(MIN_ADA) * BigInt(1_000_000);
const ASSET_UNIT_PATTERN = /^[0-9a-fA-F]{56}(?:[0-9a-fA-F]{2})*$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const TERMINAL_STATUSES: WalletFundTransfer['status'][] = [
  'Confirmed',
  'FailedViaTimeout',
  'FailedViaManualReset',
  'RolledBack',
];

function TransferSummaryCard({
  transfer,
  network,
}: {
  transfer: WalletFundTransfer;
  network: 'Preprod' | 'Mainnet';
}) {
  return (
    <div className="rounded-lg border p-3 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <div className="text-sm font-medium tabular-nums">
            {formatAda(transfer.lovelaceAmount)} ADA
          </div>
          {transfer.assets?.map((asset) => (
            <div key={asset.unit} className="text-xs text-muted-foreground tabular-nums">
              {formatAssetAmount(asset, network)}
            </div>
          ))}
        </div>
        <FundTransferStatusBadge status={transfer.status} />
      </div>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <span className="truncate">to {shortenAddress(transfer.toAddress)}</span>
        <CopyButton value={transfer.toAddress} />
      </div>
      {transfer.txHash && (
        <a
          href={getExplorerUrl(transfer.txHash, network, 'transaction')}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          {shortenAddress(transfer.txHash)} <ExternalLink className="h-3 w-3" />
        </a>
      )}
      {transfer.errorNote && <p className="text-xs text-destructive">{transfer.errorNote}</p>}
    </div>
  );
}

export function TransferFundsDialog({
  isOpen,
  onClose,
  walletAddress,
  network,
  onSuccess,
}: TransferFundsDialogProps) {
  const { apiClient } = useAppContext();
  const stablecoinLabel = getStablecoinRuleMeta(network).label;

  const [toAddress, setToAddress] = useState('');
  const [adaAmount, setAdaAmount] = useState('');
  const [assets, setAssets] = useState<AssetFormRow[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [createdTransferId, setCreatedTransferId] = useState<string | null>(null);

  // Reset the form whenever the dialog opens for a different wallet. Resetting
  // in an effect (rather than on close) keeps the closing animation showing the
  // last state instead of an empty flash.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (isOpen) {
      setToAddress('');
      setAdaAmount('');
      setAssets([]);
      setFormError(null);
      setCreatedTransferId(null);
    }
  }, [isOpen, walletAddress]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Poll the just-created transfer until it reaches a terminal state so the
  // operator watches Pending → Confirmed / Failed without leaving the dialog.
  const { data: liveTransfer } = useQuery({
    queryKey: ['fundTransfer', createdTransferId],
    enabled: isOpen && createdTransferId != null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && TERMINAL_STATUSES.includes(status) ? false : 4000;
    },
    queryFn: async () => {
      const res = await getWalletTransferFunds({
        client: apiClient,
        query: { id: createdTransferId ?? undefined },
      });
      return extractApiPayload(res)?.transfers?.[0] ?? null;
    },
  });

  const createTransfer = useApiMutation({
    mutationFn: (body: {
      fromWalletAddress: string;
      toAddress: string;
      lovelaceAmount: string;
      assets?: AssetPayload[];
    }) => postWalletTransferFunds({ client: apiClient, body }),
    errorMessage: 'Failed to queue fund transfer',
  });

  const addAssetRow = () =>
    setAssets((rows) => [...rows, { preset: 'stablecoin', customUnit: '', amount: '' }]);
  const updateAssetRow = (index: number, patch: Partial<AssetFormRow>) =>
    setAssets((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const removeAssetRow = (index: number) => setAssets((rows) => rows.filter((_, i) => i !== index));

  const validate = (): { lovelaceAmount: string; assets?: AssetPayload[] } | { error: string } => {
    const addressCheck = validateCardanoAddress(toAddress.trim(), network);
    if (!addressCheck.isValid) {
      return { error: addressCheck.error ?? 'Destination address is not valid for this network' };
    }

    const lovelace = parseDecimalToRawAmount(adaAmount.trim(), 6);
    if (lovelace == null) return { error: 'Enter a valid ADA amount (up to 6 decimals)' };
    if (BigInt(lovelace) < MIN_LOVELACE) return { error: `Amount must be at least ${MIN_ADA} ADA` };

    const cleaned: AssetPayload[] = [];
    const seen = new Set<string>();
    for (const row of assets) {
      const meta = getRuleAssetMetaFromPreset(row.preset, network, row.customUnit);
      const unit = meta.assetUnit.trim();

      if (!ASSET_UNIT_PATTERN.test(unit)) {
        return { error: `"${unit || '(empty)'}" is not a valid asset unit (policy id + hex name)` };
      }
      if (unit === 'lovelace') return { error: 'Use the ADA field for lovelace, not an asset row' };
      if (seen.has(unit)) return { error: 'The same asset is listed twice' };
      seen.add(unit);

      const amount = row.amount.trim();
      let quantity: string | null;
      if (meta.decimals == null) {
        quantity = POSITIVE_INTEGER_PATTERN.test(amount) ? amount : null;
      } else {
        const raw = parseDecimalToRawAmount(amount, meta.decimals);
        quantity = raw != null && BigInt(raw) > BigInt(0) ? raw : null;
      }
      if (quantity == null) {
        return meta.decimals == null
          ? { error: `Enter a whole-number amount for ${meta.label}` }
          : { error: `Enter a valid ${meta.label} amount (up to ${meta.decimals} decimals)` };
      }
      cleaned.push({ unit, quantity });
    }

    return { lovelaceAmount: lovelace, assets: cleaned.length > 0 ? cleaned : undefined };
  };

  const handleSubmit = async () => {
    setFormError(null);
    const result = validate();
    if ('error' in result) {
      setFormError(result.error);
      return;
    }

    try {
      const response = await createTransfer.mutateAsync({
        fromWalletAddress: walletAddress,
        toAddress: toAddress.trim(),
        lovelaceAmount: result.lovelaceAmount,
        assets: result.assets,
      });
      const transfer = extractApiPayload(response);
      if (transfer?.id) {
        setCreatedTransferId(transfer.id);
        toast.success('Fund transfer queued');
        onSuccess?.();
      }
    } catch {
      // useApiMutation already surfaced the error as a toast.
    }
  };

  const isSubmitting = createTransfer.isPending;
  const submitted = createdTransferId != null;
  const locked = isSubmitting || submitted;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer funds</DialogTitle>
          <DialogDescription>
            Send ADA and optional native tokens from this wallet to any {network} address. The
            transfer is queued, then broadcast by the background processor.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">From</Label>
            <div className="flex items-center gap-1 text-sm">
              <span className="font-mono">{shortenAddress(walletAddress)}</span>
              <CopyButton value={walletAddress} />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="transfer-to">Destination address</Label>
            <Input
              id="transfer-to"
              placeholder={network === 'Mainnet' ? 'addr1...' : 'addr_test1...'}
              value={toAddress}
              onChange={(e) => setToAddress(e.target.value)}
              disabled={locked}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="transfer-ada">Amount (ADA)</Label>
            <Input
              id="transfer-ada"
              inputMode="decimal"
              placeholder="e.g. 5"
              value={adaAmount}
              onChange={(e) => setAdaAmount(e.target.value)}
              disabled={locked}
            />
            <p className="text-xs text-muted-foreground">Minimum {MIN_ADA} ADA.</p>
          </div>

          {assets.length > 0 && (
            <div className="space-y-3">
              <Label className="text-xs text-muted-foreground">Native assets</Label>
              {assets.map((row, index) => {
                const isCustom = row.preset === 'custom';
                const meta = getRuleAssetMetaFromPreset(row.preset, network, row.customUnit);
                return (
                  <div key={index} className="space-y-2 rounded-lg border p-2">
                    <div className="flex items-center gap-2">
                      <Select
                        value={row.preset}
                        onValueChange={(preset) =>
                          updateAssetRow(index, { preset: preset as AssetPreset })
                        }
                        disabled={locked}
                      >
                        <SelectTrigger className="h-8 flex-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="stablecoin">{stablecoinLabel}</SelectItem>
                          <SelectItem value="custom">Custom token</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        className="w-28"
                        inputMode="decimal"
                        aria-label={`Amount (${meta.label})`}
                        placeholder={isCustom ? '5000000' : '5.0'}
                        value={row.amount}
                        onChange={(e) => updateAssetRow(index, { amount: e.target.value })}
                        disabled={locked}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-destructive"
                        onClick={() => removeAssetRow(index)}
                        disabled={locked}
                        aria-label="Remove asset"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    {isCustom && (
                      <Input
                        className="font-mono text-xs"
                        aria-label="Custom asset unit"
                        placeholder="policyId + hex asset name"
                        value={row.customUnit}
                        onChange={(e) => updateAssetRow(index, { customUnit: e.target.value })}
                        disabled={locked}
                        spellCheck={false}
                      />
                    )}
                  </div>
                );
              })}
              <p className="text-xs text-muted-foreground">
                Each token output carries ~2 ADA to satisfy min-UTxO. Custom amounts are in the
                token&apos;s smallest unit.
              </p>
            </div>
          )}

          {!submitted && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addAssetRow}
              disabled={isSubmitting}
            >
              <Plus className="h-3.5 w-3.5" /> Add native asset
            </Button>
          )}

          {formError && <p className="text-xs text-destructive">{formError}</p>}

          {submitted && liveTransfer && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">This transfer</Label>
              <TransferSummaryCard transfer={liveTransfer} network={network} />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>
            {submitted ? 'Close' : 'Cancel'}
          </Button>
          {!submitted && (
            <Button onClick={handleSubmit} disabled={isSubmitting}>
              {isSubmitting ? <Spinner size={16} /> : 'Queue transfer'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
