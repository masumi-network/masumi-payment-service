import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'react-toastify';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RefreshButton } from '@/components/RefreshButton';
import { useAppContext } from '@/lib/contexts/AppContext';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useX402LowBalanceRules, useX402Networks, useX402Wallets } from '@/lib/hooks/useX402';
import { cn, formatX402Amount, groupDigits, handleApiCall, shortenAddress } from '@/lib/utils';
import {
  deleteX402LowBalance,
  patchX402LowBalance,
  postX402LowBalance,
  X402LowBalanceRule,
} from '@/lib/api/generated';

const NATIVE = 'native';

const STATUS_VARIANT: Record<X402LowBalanceRule['status'], BadgeProps['variant']> = {
  Healthy: 'success',
  Low: 'warning',
  Unknown: 'secondary',
};

// The native gas token has known 18 decimals, so show it in ETH; an ERC-20 threshold's
// decimals aren't stored on the rule, so label the grouped value explicitly as base units
// rather than render a misleading bare number that reads like a whole-token amount.
const formatRuleAmount = (amount: string | null | undefined, asset: string) =>
  asset === NATIVE ? `${formatX402Amount(amount, 18)} ETH` : `${groupDigits(amount)} base units`;

const ruleFormSchema = z
  .object({
    evmWalletId: z.string().min(1, 'Required'),
    caip2Network: z.string().regex(/^eip155:\d+$/, 'Required'),
    assetKind: z.enum(['native', 'token']),
    asset: z.string(),
    thresholdAmount: z.string().regex(/^\d+$/, 'Whole number in base units'),
  })
  .refine((v) => v.assetKind === 'native' || /^0x[a-fA-F0-9]{40}$/.test(v.asset), {
    message: 'Must be an EVM token address',
    path: ['asset'],
  });

type RuleFormValues = z.infer<typeof ruleFormSchema>;

const assetLabel = (asset: string) =>
  asset === NATIVE ? 'Native (gas)' : shortenAddress(asset, 6);

export function AlertsTab() {
  const { rules, isLoading, isRefetching, refetch } = useX402LowBalanceRules();
  const { networks, isLoading: networksLoading } = useX402Networks();
  const { apiClient } = useAppContext();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<X402LowBalanceRule | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [ruleToDelete, setRuleToDelete] = useState<X402LowBalanceRule | null>(null);

  const chainLabel = (caip2: string) =>
    networks.find((n) => n.caip2Id === caip2)?.displayName ?? caip2;

  // Rules are fetched across all environments, but `networks` (and the edit dialog's chain
  // picker) are scoped to the active env. Scope the list to the active env's chains so the
  // Preprod/Mainnet selector governs this tab like every other x402 surface.
  const envChainIds = useMemo(() => new Set(networks.map((n) => n.caip2Id)), [networks]);
  const envRules = useMemo(
    () => rules.filter((rule) => envChainIds.has(rule.caip2Network)),
    [rules, envChainIds],
  );

  const toggleEnabled = async (rule: X402LowBalanceRule) => {
    setBusyId(rule.id);
    await handleApiCall(
      () =>
        patchX402LowBalance({
          client: apiClient,
          body: { ruleId: rule.id, enabled: !rule.enabled },
        }),
      {
        onSuccess: () => refetch(),
        onFinally: () => setBusyId(null),
        errorMessage: 'Failed to update rule',
      },
    );
  };

  const confirmDelete = async () => {
    if (!ruleToDelete) return;
    const ruleId = ruleToDelete.id;
    setBusyId(ruleId);
    await handleApiCall(() => deleteX402LowBalance({ client: apiClient, body: { ruleId } }), {
      onSuccess: () => {
        toast.success('Alert deleted');
        refetch();
      },
      onFinally: () => {
        setBusyId(null);
        setRuleToDelete(null);
      },
      errorMessage: 'Failed to delete rule',
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Get alerted when a managed wallet runs low. Selling wallets need native gas to settle;
          Purchasing wallets need their payment token plus gas. Alerts fire as webhooks.
        </p>
        <div className="flex items-center gap-2">
          <RefreshButton onRefresh={refetch} isRefreshing={isRefetching} />
          <Button
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
            className="flex items-center gap-2"
          >
            <Plus className="h-4 w-4" />
            Add alert
          </Button>
        </div>
      </div>

      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full">
          <thead className="bg-muted/30 dark:bg-muted/15">
            <tr className="border-b">
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Wallet
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Chain
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Asset
              </th>
              <th scope="col" className="p-4 text-right text-sm font-medium text-muted-foreground">
                Threshold
              </th>
              <th scope="col" className="p-4 text-right text-sm font-medium text-muted-foreground">
                Last seen
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Status
              </th>
              <th scope="col" className="p-4 text-right text-sm font-medium text-muted-foreground">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading || networksLoading ? (
              <tr>
                <td colSpan={7} className="py-10">
                  <div className="flex justify-center">
                    <Spinner />
                  </div>
                </td>
              </tr>
            ) : envRules.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <EmptyState
                    title="No alerts configured"
                    description="Add a low-balance alert so a wallet running out of gas or tokens does not silently break settlement. You need a managed wallet first."
                    action={
                      <Button asChild variant="outline" size="sm">
                        <Link href={{ pathname: '/x402', query: { tab: 'Wallets' } }}>
                          Go to Wallets
                        </Link>
                      </Button>
                    }
                  />
                </td>
              </tr>
            ) : (
              envRules.map((rule) => (
                <tr
                  key={rule.id}
                  className={cn('border-b last:border-0', !rule.enabled && 'opacity-50')}
                >
                  <td className="p-4">
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-sm" title={rule.evmWalletAddress}>
                        {shortenAddress(rule.evmWalletAddress, 6)}
                      </span>
                      <CopyButton value={rule.evmWalletAddress} />
                    </div>
                  </td>
                  <td className="p-4 text-sm">{chainLabel(rule.caip2Network)}</td>
                  <td className="p-4 font-mono text-sm">{assetLabel(rule.asset)}</td>
                  <td className="p-4 text-right font-mono text-sm">
                    {formatRuleAmount(rule.thresholdAmount, rule.asset)}
                  </td>
                  <td className="p-4 text-right font-mono text-sm text-muted-foreground">
                    {rule.lastKnownAmount != null
                      ? formatRuleAmount(rule.lastKnownAmount, rule.asset)
                      : '—'}
                  </td>
                  <td className="p-4">
                    <Badge variant={STATUS_VARIANT[rule.status]}>{rule.status}</Badge>
                  </td>
                  <td className="p-4 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === rule.id}
                        onClick={() => toggleEnabled(rule)}
                      >
                        {rule.enabled ? 'Disable' : 'Enable'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Edit alert"
                        onClick={() => {
                          setEditing(rule);
                          setDialogOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Delete alert"
                        className="text-destructive hover:text-destructive"
                        disabled={busyId === rule.id}
                        onClick={() => setRuleToDelete(rule)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <AlertDialog
        key={editing?.id ?? 'new'}
        open={dialogOpen}
        editing={editing}
        onClose={() => setDialogOpen(false)}
        onSaved={() => {
          setDialogOpen(false);
          refetch();
        }}
      />

      <ConfirmDialog
        open={ruleToDelete !== null}
        onClose={() => setRuleToDelete(null)}
        title="Delete low-balance alert"
        description="This removes the alert rule. The wallet will no longer be monitored for this asset on this chain."
        onConfirm={confirmDelete}
        isLoading={busyId !== null && busyId === ruleToDelete?.id}
      />
    </div>
  );
}

function AlertDialog({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: X402LowBalanceRule | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { apiClient } = useAppContext();
  const { networks } = useX402Networks();
  const { wallets } = useX402Wallets(open);
  const [isSaving, setIsSaving] = useState(false);

  const editingAssetKind =
    editing == null ? 'native' : editing.asset === NATIVE ? 'native' : 'token';

  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors },
  } = useForm<RuleFormValues>({
    resolver: zodResolver(ruleFormSchema),
    defaultValues: {
      evmWalletId: editing?.evmWalletId ?? '',
      caip2Network: editing?.caip2Network ?? '',
      assetKind: editingAssetKind,
      asset: editing && editing.asset !== NATIVE ? editing.asset : '',
      thresholdAmount: editing?.thresholdAmount ?? '',
    },
  });

  const assetKind = useWatch({ control, name: 'assetKind' });
  const selectedNetwork = useWatch({ control, name: 'caip2Network' });

  const onSubmit = async (data: RuleFormValues) => {
    setIsSaving(true);
    const asset = data.assetKind === 'native' ? NATIVE : data.asset;
    // An existing rule is keyed by (wallet, chain, asset); only the threshold is editable in
    // place, so patch it. Creating goes through the upserting POST.
    const call = editing
      ? () =>
          patchX402LowBalance({
            client: apiClient,
            body: { ruleId: editing.id, thresholdAmount: data.thresholdAmount },
          })
      : () =>
          postX402LowBalance({
            client: apiClient,
            body: {
              evmWalletId: data.evmWalletId,
              caip2Network: data.caip2Network,
              asset,
              thresholdAmount: data.thresholdAmount,
            },
          });
    await handleApiCall(call, {
      onSuccess: () => {
        toast.success(editing ? 'Alert updated' : 'Alert added');
        onSaved();
      },
      onFinally: () => setIsSaving(false),
      errorMessage: 'Failed to save alert',
    });
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Update alert' : 'Add low-balance alert'}</DialogTitle>
          <DialogDescription>
            Alert when a wallet&apos;s balance for an asset drops below a threshold. Use the native
            gas token for facilitators, or a token contract for payment funds.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Managed wallet</label>
            <Controller
              control={control}
              name="evmWalletId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange} disabled={!!editing}>
                  <SelectTrigger aria-label="Managed wallet">
                    <SelectValue placeholder="Select a wallet" />
                  </SelectTrigger>
                  <SelectContent>
                    {wallets.map((wallet) => (
                      <SelectItem key={wallet.id} value={wallet.id} className="font-mono">
                        {shortenAddress(wallet.address, 8)}
                        <span className="ml-2 text-muted-foreground">{wallet.type}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.evmWalletId && (
              <p className="text-xs text-destructive">{errors.evmWalletId.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Chain</label>
            <Controller
              control={control}
              name="caip2Network"
              render={({ field }) => (
                <Select
                  value={field.value}
                  onValueChange={(caip2) => {
                    field.onChange(caip2);
                    // Token contracts are chain-specific, so re-sync the asset to the new
                    // chain's default (or clear it) when an ERC-20 is selected — otherwise a
                    // contract from the previously chosen chain could be saved against this one.
                    if (assetKind === 'token') {
                      const chain = networks.find((n) => n.caip2Id === caip2);
                      setValue('asset', chain?.defaultAsset ?? '', { shouldValidate: true });
                    }
                  }}
                  disabled={!!editing}
                >
                  <SelectTrigger aria-label="Chain">
                    <SelectValue placeholder="Select a chain" />
                  </SelectTrigger>
                  <SelectContent>
                    {networks.map((network) => (
                      <SelectItem key={network.id} value={network.caip2Id}>
                        {network.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.caip2Network && (
              <p className="text-xs text-destructive">{errors.caip2Network.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Asset</label>
            <Controller
              control={control}
              name="assetKind"
              render={({ field }) => (
                <Select
                  value={field.value}
                  onValueChange={(value) => {
                    field.onChange(value);
                    if (value === 'native') setValue('asset', '');
                    else {
                      const chain = networks.find((n) => n.caip2Id === selectedNetwork);
                      if (chain?.defaultAsset) setValue('asset', chain.defaultAsset);
                    }
                  }}
                  disabled={!!editing}
                >
                  <SelectTrigger aria-label="Asset kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="native">Native gas token</SelectItem>
                    <SelectItem value="token">ERC-20 token</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
            {assetKind === 'token' && (
              <Input
                aria-label="Token contract address"
                placeholder="0x… token contract"
                className="font-mono"
                readOnly={!!editing}
                {...register('asset')}
              />
            )}
            {errors.asset && <p className="text-xs text-destructive">{errors.asset.message}</p>}
          </div>

          <div className="space-y-2">
            <label htmlFor="alert-thresholdAmount" className="text-sm font-medium">
              Threshold (base units)
            </label>
            <Input
              id="alert-thresholdAmount"
              placeholder="10000000000000000"
              className="font-mono"
              {...register('thresholdAmount')}
            />
            {errors.thresholdAmount && (
              <p className="text-xs text-destructive">{errors.thresholdAmount.message}</p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? 'Saving…' : editing ? 'Update alert' : 'Add alert'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
