import { useState } from 'react';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'react-toastify';
import { Plus, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { useApiKey } from '@/lib/hooks/useApiKey';
import { useX402Budgets, useX402Networks, useX402Wallets } from '@/lib/hooks/useX402';
import { handleApiCall, shortenAddress } from '@/lib/utils';
import { postX402Budgets, X402Budget } from '@/lib/api/generated';

const budgetFormSchema = z.object({
  apiKeyId: z.string().min(1, 'Required'),
  evmWalletId: z.string().min(1, 'Required'),
  caip2Network: z.string().regex(/^eip155:\d+$/, 'Required'),
  asset: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be an EVM token address'),
  remainingAmount: z.string().regex(/^\d+$/, 'Whole number in token base units'),
});

type BudgetFormValues = z.infer<typeof budgetFormSchema>;

export function BudgetsTab() {
  const { budgets, isLoading, isRefetching, refetch } = useX402Budgets();
  const { networks } = useX402Networks();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<X402Budget | null>(null);

  const chainLabel = (caip2: string) =>
    networks.find((n) => n.caip2Id === caip2)?.displayName ?? caip2;

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (budget: X402Budget) => {
    setEditing(budget);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Per-API-key spend limits for managed wallets. Amounts are in the token&apos;s base units.
        </p>
        <div className="flex items-center gap-2">
          <RefreshButton onRefresh={refetch} isRefreshing={isRefetching} />
          <Button onClick={openCreate} className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Set budget
          </Button>
        </div>
      </div>

      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b">
              <th className="p-4 text-left text-sm font-medium">API key</th>
              <th className="p-4 text-left text-sm font-medium">Wallet</th>
              <th className="p-4 text-left text-sm font-medium">Chain</th>
              <th className="p-4 text-left text-sm font-medium">Asset</th>
              <th className="p-4 text-right text-sm font-medium">Remaining</th>
              <th className="p-4 text-right text-sm font-medium">Spent</th>
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
            ) : budgets.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <EmptyState
                    title="No budgets set"
                    description="Grant an API key a spend budget against a managed wallet."
                  />
                </td>
              </tr>
            ) : (
              budgets.map((budget) => (
                <tr key={budget.id} className="border-b last:border-0">
                  <td className="p-4 font-mono text-xs">{budget.apiKeyId}</td>
                  <td className="p-4 font-mono text-sm">
                    {shortenAddress(budget.evmWalletAddress, 6)}
                  </td>
                  <td className="p-4 text-sm">{chainLabel(budget.caip2Network)}</td>
                  <td className="p-4 font-mono text-sm">{shortenAddress(budget.asset, 6)}</td>
                  <td className="p-4 text-right font-mono text-sm">{budget.remainingAmount}</td>
                  <td className="p-4 text-right font-mono text-sm text-muted-foreground">
                    {budget.spentAmount}
                  </td>
                  <td className="p-4 text-right">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(budget)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <BudgetDialog
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

export function BudgetDialog({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: X402Budget | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { apiClient } = useAppContext();
  const { allApiKeys } = useApiKey();
  const { networks } = useX402Networks();
  // Only load the wallet set while the form is open (it feeds the picker). Budgets fund
  // outbound payments, so only Purchasing wallets are selectable.
  const { wallets } = useX402Wallets(open, 'Purchasing');
  const [isSaving, setIsSaving] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors },
  } = useForm<BudgetFormValues>({
    resolver: zodResolver(budgetFormSchema),
    defaultValues: {
      apiKeyId: editing?.apiKeyId ?? '',
      evmWalletId: editing?.evmWalletId ?? '',
      caip2Network: editing?.caip2Network ?? '',
      asset: editing?.asset ?? '',
      remainingAmount: editing?.remainingAmount ?? '',
    },
  });

  const selectedNetwork = useWatch({ control, name: 'caip2Network' });

  const onSelectNetwork = (caip2: string) => {
    setValue('caip2Network', caip2, { shouldValidate: true });
    // Prefill the asset with the chain default when the asset field is still empty.
    const chain = networks.find((n) => n.caip2Id === caip2);
    if (chain?.defaultAsset && !editing) {
      setValue('asset', chain.defaultAsset, { shouldValidate: true });
    }
  };

  const onSubmit = async (data: BudgetFormValues) => {
    setIsSaving(true);
    await handleApiCall(
      () =>
        postX402Budgets({
          client: apiClient,
          body: {
            apiKeyId: data.apiKeyId,
            evmWalletId: data.evmWalletId,
            caip2Network: data.caip2Network,
            asset: data.asset,
            remainingAmount: data.remainingAmount,
          },
        }),
      {
        onSuccess: () => {
          toast.success(editing ? 'Budget updated' : 'Budget set');
          onSaved();
        },
        onFinally: () => setIsSaving(false),
        errorMessage: 'Failed to save budget',
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Update budget' : 'Set budget'}</DialogTitle>
          <DialogDescription>
            Grant an API key a spendable budget against a managed wallet for a specific chain and
            token. Setting a budget replaces the remaining amount.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">API key</label>
            <Controller
              control={control}
              name="apiKeyId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange} disabled={!!editing}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select an API key" />
                  </SelectTrigger>
                  <SelectContent>
                    {allApiKeys.map((key) => (
                      <SelectItem key={key.id} value={key.id}>
                        <span className="font-mono text-xs">{key.token}</span>
                        <span className="ml-2 text-muted-foreground">{key.id}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.apiKeyId && (
              <p className="text-xs text-destructive">{errors.apiKeyId.message}</p>
            )}
          </div>

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
            <Select value={selectedNetwork} onValueChange={onSelectNetwork} disabled={!!editing}>
              <SelectTrigger>
                <SelectValue placeholder="Select a chain" />
              </SelectTrigger>
              <SelectContent>
                {networks.map((network) => (
                  <SelectItem key={network.id} value={network.caip2Id}>
                    {network.displayName}
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {network.caip2Id}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.caip2Network && (
              <p className="text-xs text-destructive">{errors.caip2Network.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Asset (token contract)</label>
            <Input
              placeholder="0x…"
              className="font-mono"
              readOnly={!!editing}
              {...register('asset')}
            />
            {errors.asset && <p className="text-xs text-destructive">{errors.asset.message}</p>}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Remaining amount (base units)</label>
            <Input placeholder="1000000" className="font-mono" {...register('remainingAmount')} />
            {errors.remainingAmount && (
              <p className="text-xs text-destructive">{errors.remainingAmount.message}</p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? 'Saving…' : editing ? 'Update budget' : 'Set budget'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
