import { useEffect, useMemo, useState } from 'react';
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
import { USDM_CONFIG, PREPROD_USDM_CONFIG, USDCX_CONFIG } from '@/lib/constants/defaultWallets';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { Plus, Trash2, ExternalLink } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { postWalletTransferFunds, getWalletTransferFunds } from '@/lib/api/generated';
import type { WalletFundTransfer } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useApiMutation } from '@/lib/hooks/useApiMutation';
import { extractApiPayload } from '@/lib/api-response';
import { validateCardanoAddress, shortenAddress, getExplorerUrl } from '@/lib/utils';
import { toast } from 'react-toastify';

interface TransferFundsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string;
  network: 'Preprod' | 'Mainnet';
  onSuccess?: () => void;
}

/** How the operator is editing one native-asset row before submit. */
type AssetFormRow = { preset: string; customUnit: string; amount: string };
/** The shape the API stores: unit + smallest-unit integer quantity. */
type AssetPayload = { unit: string; quantity: string };

// A well-known asset the operator can pick by name instead of pasting a hex
// unit. Sourced from the same defaultWallets config the rest of the app uses.
type KnownAsset = { key: string; label: string; unit: string; decimals: number };
const CUSTOM_PRESET = 'custom';

/**
 * Known assets available on a given network. USDM is a stablecoin on both
 * (tUSDM on preprod); USDCx exists only on mainnet.
 */
function knownAssetsForNetwork(network: 'Preprod' | 'Mainnet'): KnownAsset[] {
  if (network === 'Preprod') {
    return [
      {
        key: 'usdm',
        label: 'USDM (tUSDM)',
        unit: PREPROD_USDM_CONFIG.policyId + PREPROD_USDM_CONFIG.assetName,
        decimals: 6,
      },
    ];
  }
  return [
    { key: 'usdm', label: 'USDM', unit: USDM_CONFIG.policyId + USDM_CONFIG.assetName, decimals: 6 },
    {
      key: 'usdcx',
      label: 'USDCx',
      unit: USDCX_CONFIG.policyId + USDCX_CONFIG.assetName,
      decimals: 6,
    },
  ];
}

// Mirror of the API's postWalletFundSchemaInput. Keeping the same limits client
// side turns an async FailedViaManualReset into an inline error the operator
// sees before submitting.
const MIN_ADA = 2;
const ASSET_UNIT_PATTERN = /^[0-9a-fA-F]{56}(?:[0-9a-fA-F]{2})*$/;
const TERMINAL_STATUSES: WalletFundTransfer['status'][] = [
  'Confirmed',
  'FailedViaTimeout',
  'FailedViaManualReset',
  'RolledBack',
];

// BigInt literals need ES2020; the frontend targets lower, so build the
// constant with the BigInt() call form instead.
const LOVELACE_PER_ADA = BigInt(1_000_000);

/**
 * Display amount → smallest-unit integer string. `decimals` is the asset's
 * decimal places (6 for ADA/USDM/USDCx). A custom token has unknown decimals,
 * so it is passed 0 and the field is treated as a raw base-unit integer.
 * Returns null on malformed or non-positive input.
 */
function toBaseUnits(amount: string, decimals: number): string | null {
  const trimmed = amount.trim();
  if (decimals === 0) return /^[1-9][0-9]*$/.test(trimmed) ? trimmed : null;
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  const base =
    BigInt(whole) * BigInt(Math.pow(10, decimals)) + BigInt(fraction.padEnd(decimals, '0'));
  return base > BigInt(0) ? base.toString() : null;
}

function statusBadgeVariant(status: WalletFundTransfer['status']) {
  if (status === 'Confirmed') return 'default' as const;
  if (status === 'Pending') return 'secondary' as const;
  return 'destructive' as const;
}

function TransferStatusCard({
  transfer,
  network,
}: {
  transfer: WalletFundTransfer;
  network: 'Preprod' | 'Mainnet';
}) {
  return (
    <div className="rounded-md border p-3 space-y-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium">{Number(transfer.lovelaceAmount) / 1e6} ADA</span>
        <Badge variant={statusBadgeVariant(transfer.status)}>{transfer.status}</Badge>
      </div>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <span>to {shortenAddress(transfer.toAddress)}</span>
        <CopyButton value={transfer.toAddress} />
      </div>
      {transfer.assets && transfer.assets.length > 0 && (
        <div className="text-xs text-muted-foreground">
          + {transfer.assets.length} native asset{transfer.assets.length > 1 ? 's' : ''}
        </div>
      )}
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

  const knownAssets = useMemo(() => knownAssetsForNetwork(network), [network]);

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
  // operator watches Pending → Confirmed / Failed without refreshing.
  const { data: createdTransfer } = useQuery({
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
      const payload = extractApiPayload(res);
      return payload?.transfers?.[0] ?? null;
    },
  });

  // Recent transfers for this wallet, refreshed while the dialog is open.
  const { data: history } = useQuery({
    queryKey: ['fundTransfers', walletAddress, createdTransferId],
    enabled: isOpen && walletAddress !== '',
    refetchInterval: 6000,
    queryFn: async () => {
      const res = await getWalletTransferFunds({
        client: apiClient,
        query: { walletAddress, limit: 5 },
      });
      return extractApiPayload(res)?.transfers ?? [];
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
    setAssets((rows) => [
      ...rows,
      { preset: knownAssets[0]?.key ?? CUSTOM_PRESET, customUnit: '', amount: '' },
    ]);
  const updateAssetRow = (index: number, patch: Partial<AssetFormRow>) =>
    setAssets((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const removeAssetRow = (index: number) => setAssets((rows) => rows.filter((_, i) => i !== index));

  const validate = (): { lovelaceAmount: string; assets?: AssetPayload[] } | { error: string } => {
    const addressCheck = validateCardanoAddress(toAddress.trim(), network);
    if (!addressCheck.isValid) {
      return { error: addressCheck.error ?? 'Destination address is not valid for this network' };
    }

    const lovelace = toBaseUnits(adaAmount, 6);
    if (lovelace == null) return { error: 'Enter a valid ADA amount (up to 6 decimals)' };
    if (BigInt(lovelace) < BigInt(MIN_ADA) * LOVELACE_PER_ADA) {
      return { error: `Amount must be at least ${MIN_ADA} ADA` };
    }

    const cleaned: AssetPayload[] = [];
    const seen = new Set<string>();
    for (const row of assets) {
      const known = knownAssets.find((asset) => asset.key === row.preset);
      const unit = known ? known.unit : row.customUnit.trim();
      const decimals = known ? known.decimals : 0;

      if (!ASSET_UNIT_PATTERN.test(unit)) {
        return { error: `"${unit || '(empty)'}" is not a valid asset unit (policy id + hex name)` };
      }
      if (unit === 'lovelace') return { error: 'Use the ADA field for lovelace, not an asset row' };
      if (seen.has(unit)) return { error: 'The same asset is listed twice' };
      seen.add(unit);

      const quantity = toBaseUnits(row.amount, decimals);
      if (quantity == null) {
        return known
          ? { error: `Enter a valid ${known.label} amount (up to ${decimals} decimals)` }
          : { error: 'Asset quantity must be a positive whole number' };
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

  const liveTransfer = createdTransfer ?? null;
  const isSubmitting = createTransfer.isPending;
  const submittedId = createdTransferId != null;

  const recentTransfers = useMemo(
    () => (history ?? []).filter((t) => t.id !== createdTransferId),
    [history, createdTransferId],
  );

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer funds</DialogTitle>
          <DialogDescription>
            Send ADA (and optional native tokens) from this wallet to any {network} address. The
            transfer is queued and broadcast by the background processor.
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
              disabled={isSubmitting || submittedId}
              autoComplete="off"
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
              disabled={isSubmitting || submittedId}
            />
            <p className="text-xs text-muted-foreground">Minimum {MIN_ADA} ADA.</p>
          </div>

          {assets.length > 0 && (
            <div className="space-y-3">
              <Label className="text-xs text-muted-foreground">Native assets</Label>
              {assets.map((row, index) => {
                const isCustom = row.preset === CUSTOM_PRESET;
                return (
                  <div key={index} className="space-y-2 rounded-md border p-2">
                    <div className="flex items-center gap-2">
                      <Select
                        value={row.preset}
                        onValueChange={(preset) => updateAssetRow(index, { preset })}
                        disabled={isSubmitting || submittedId}
                      >
                        <SelectTrigger className="h-8 flex-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {knownAssets.map((asset) => (
                            <SelectItem key={asset.key} value={asset.key}>
                              {asset.label}
                            </SelectItem>
                          ))}
                          <SelectItem value={CUSTOM_PRESET}>Custom token</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        className="w-28"
                        inputMode="decimal"
                        placeholder="amount"
                        value={row.amount}
                        onChange={(e) => updateAssetRow(index, { amount: e.target.value })}
                        disabled={isSubmitting || submittedId}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-destructive"
                        onClick={() => removeAssetRow(index)}
                        disabled={isSubmitting || submittedId}
                        aria-label="Remove asset"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    {isCustom && (
                      <Input
                        className="font-mono text-xs"
                        placeholder="policyId + hex asset name"
                        value={row.customUnit}
                        onChange={(e) => updateAssetRow(index, { customUnit: e.target.value })}
                        disabled={isSubmitting || submittedId}
                      />
                    )}
                  </div>
                );
              })}
              <p className="text-xs text-muted-foreground">
                A token output also carries ~2 ADA to satisfy min-UTxO. Custom amounts are in the
                token&apos;s smallest unit.
              </p>
            </div>
          )}

          {!submittedId && (
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

          {submittedId && liveTransfer && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">This transfer</Label>
              <TransferStatusCard transfer={liveTransfer} network={network} />
            </div>
          )}

          {recentTransfers.length > 0 && (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Recent transfers</Label>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {recentTransfers.map((transfer) => (
                  <TransferStatusCard key={transfer.id} transfer={transfer} network={network} />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>
            {submittedId ? 'Close' : 'Cancel'}
          </Button>
          {!submittedId && (
            <Button onClick={handleSubmit} disabled={isSubmitting}>
              {isSubmitting ? <Spinner size={16} /> : 'Queue transfer'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
