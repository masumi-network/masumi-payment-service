import { useState } from 'react';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'react-toastify';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
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
import { useX402LowBalanceRules, useX402Networks, useX402Wallets } from '@/lib/hooks/useX402';
import { cn, handleApiCall, shortenAddress } from '@/lib/utils';
import {
  deleteX402LowBalance,
  patchX402LowBalance,
  postX402LowBalance,
  X402LowBalanceRule,
} from '@/lib/api/generated';

const NATIVE = 'native';

const STATUS_STYLE: Record<X402LowBalanceRule['status'], string> = {
  Healthy: 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400',
  Low: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  Unknown: 'text-muted-foreground',
};

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
  const { networks } = useX402Networks();
  const { apiClient } = useAppContext();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<X402LowBalanceRule | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const chainLabel = (caip2: string) =>
    networks.find((n) => n.caip2Id === caip2)?.displayName ?? caip2;

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

  const remove = async (rule: X402LowBalanceRule) => {
    if (!window.confirm('Delete this low-balance alert?')) return;
    setBusyId(rule.id);
    await handleApiCall(
      () => deleteX402LowBalance({ client: apiClient, body: { ruleId: rule.id } }),
      {
        onSuccess: () => {
          toast.success('Alert deleted');
          refetch();
        },
        onFinally: () => setBusyId(null),
        errorMessage: 'Failed to delete rule',
      },
    );
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
          <thead>
            <tr className="border-b">
              <th className="p-4 text-left text-sm font-medium">Wallet</th>
              <th className="p-4 text-left text-sm font-medium">Chain</th>
              <th className="p-4 text-left text-sm font-medium">Asset</th>
              <th className="p-4 text-right text-sm font-medium">Threshold</th>
              <th className="p-4 text-right text-sm font-medium">Last seen</th>
              <th className="p-4 text-left text-sm font-medium">Status</th>
              <th className="p-4 text-right text-sm font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} className="py-10">
                  <div className="flex justify-center">
                    <Spinner />
                  </div>
                </td>
              </tr>
            ) : rules.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <EmptyState
                    title="No alerts configured"
                    description="Add a low-balance alert so a wallet running out of gas or tokens does not silently break settlement."
                  />
                </td>
              </tr>
            ) : (
              rules.map((rule) => (
                <tr
                  key={rule.id}
                  className={cn('border-b last:border-0', !rule.enabled && 'opacity-50')}
                >
                  <td className="p-4 font-mono text-sm">
                    {shortenAddress(rule.evmWalletAddress, 6)}
                  </td>
                  <td className="p-4 text-sm">{chainLabel(rule.caip2Network)}</td>
                  <td className="p-4 font-mono text-sm">{assetLabel(rule.asset)}</td>
                  <td className="p-4 text-right font-mono text-sm">{rule.thresholdAmount}</td>
                  <td className="p-4 text-right font-mono text-sm text-muted-foreground">
                    {rule.lastKnownAmount ?? '—'}
                  </td>
                  <td className="p-4">
                    <Badge variant="outline" className={STATUS_STYLE[rule.status]}>
                      {rule.status}
                    </Badge>
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
                        className="text-destructive hover:text-destructive"
                        disabled={busyId === rule.id}
                        onClick={() => remove(rule)}
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
                  <SelectTrigger>
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
                <Select value={field.value} onValueChange={field.onChange} disabled={!!editing}>
                  <SelectTrigger>
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
                  <SelectTrigger>
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
                placeholder="0x… token contract"
                className="font-mono"
                readOnly={!!editing}
                {...register('asset')}
              />
            )}
            {errors.asset && <p className="text-xs text-destructive">{errors.asset.message}</p>}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Threshold (base units)</label>
            <Input
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
