import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'react-toastify';
import { Plus, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
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
import { useX402Networks, useX402Wallets } from '@/lib/hooks/useX402';
import { handleApiCall, shortenAddress } from '@/lib/utils';
import { postX402Networks, X402Network } from '@/lib/api/generated';

const NO_FACILITATOR = '__none__';

const chainSchema = z.object({
  caip2Id: z
    .string()
    .regex(/^eip155:\d+$/, 'Must be a CAIP-2 EVM chain id, for example eip155:8453'),
  displayName: z.string().min(1, 'Required').max(120),
  rpcUrl: z.string().url('Must be a valid URL'),
  isTestnet: z.boolean(),
  isEnabled: z.boolean(),
  defaultAsset: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Must be an EVM token address')
    .or(z.literal(''))
    .optional(),
  facilitatorWalletId: z.string().optional(),
});

type ChainFormValues = z.infer<typeof chainSchema>;

export function ChainsTab() {
  const { networks, isLoading, isRefetching, refetch } = useX402Networks();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<X402Network | null>(null);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (network: X402Network) => {
    setEditing(network);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          EVM chains available to the x402 payment rail. Testnet chains pair with the Preprod
          environment.
        </p>
        <div className="flex items-center gap-2">
          <RefreshButton onRefresh={refetch} isRefreshing={isRefetching} />
          <Button onClick={openCreate} className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Add chain
          </Button>
        </div>
      </div>

      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b">
              <th className="p-4 text-left text-sm font-medium">Chain</th>
              <th className="p-4 text-left text-sm font-medium">RPC URL</th>
              <th className="p-4 text-left text-sm font-medium">Status</th>
              <th className="p-4 text-left text-sm font-medium">Default asset</th>
              <th className="p-4 text-left text-sm font-medium">Facilitator</th>
              <th className="p-4 text-right text-sm font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={6} className="py-10">
                  <div className="flex justify-center">
                    <Spinner />
                  </div>
                </td>
              </tr>
            ) : networks.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState
                    title="No chains configured"
                    description="Add an EVM chain to start accepting x402 payments."
                  />
                </td>
              </tr>
            ) : (
              networks.map((network) => (
                <tr key={network.id} className="border-b last:border-0">
                  <td className="p-4">
                    <div className="font-medium">{network.displayName}</div>
                    <div className="text-xs text-muted-foreground font-mono">{network.caip2Id}</div>
                  </td>
                  <td
                    className="p-4 text-sm font-mono max-w-[260px] truncate"
                    title={network.rpcUrl}
                  >
                    {network.rpcUrl}
                  </td>
                  <td className="p-4">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={network.isEnabled ? 'success' : 'secondary'}>
                        {network.isEnabled ? 'Enabled' : 'Disabled'}
                      </Badge>
                      <Badge variant="outline">{network.isTestnet ? 'Testnet' : 'Mainnet'}</Badge>
                    </div>
                  </td>
                  <td className="p-4 text-sm font-mono">
                    {network.defaultAsset ? shortenAddress(network.defaultAsset, 6) : '—'}
                  </td>
                  <td className="p-4 text-sm">
                    {network.facilitatorWalletId ? (
                      <FacilitatorLabel
                        address={network.facilitatorWalletAddress}
                        walletId={network.facilitatorWalletId}
                      />
                    ) : (
                      <span className="text-amber-600 dark:text-amber-400">Not set</span>
                    )}
                  </td>
                  <td className="p-4 text-right">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(network)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <ChainDialog
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

function FacilitatorLabel({ address, walletId }: { address: string | null; walletId: string }) {
  // Address is denormalized onto the network response, so labelling no longer
  // requires loading the full managed-wallet set.
  return <span className="font-mono">{address ? shortenAddress(address, 6) : walletId}</span>;
}

export function ChainDialog({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: X402Network | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { apiClient } = useAppContext();
  // Only load the wallet set while the form is open (it feeds the picker). A facilitator
  // settles inbound payments, so only Selling wallets are selectable.
  const { wallets } = useX402Wallets(open, 'Selling');
  const [isSaving, setIsSaving] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<ChainFormValues>({
    resolver: zodResolver(chainSchema),
    defaultValues: {
      caip2Id: editing?.caip2Id ?? '',
      displayName: editing?.displayName ?? '',
      rpcUrl: editing?.rpcUrl ?? '',
      isTestnet: editing?.isTestnet ?? false,
      isEnabled: editing?.isEnabled ?? true,
      defaultAsset: editing?.defaultAsset ?? '',
      facilitatorWalletId: editing?.facilitatorWalletId ?? NO_FACILITATOR,
    },
  });

  const onSubmit = async (data: ChainFormValues) => {
    setIsSaving(true);
    await handleApiCall(
      () =>
        postX402Networks({
          client: apiClient,
          body: {
            caip2Id: data.caip2Id,
            displayName: data.displayName,
            rpcUrl: data.rpcUrl,
            isTestnet: data.isTestnet,
            isEnabled: data.isEnabled,
            defaultAsset: data.defaultAsset ? data.defaultAsset : null,
            facilitatorWalletId:
              data.facilitatorWalletId && data.facilitatorWalletId !== NO_FACILITATOR
                ? data.facilitatorWalletId
                : null,
          },
        }),
      {
        onSuccess: () => {
          toast.success(editing ? 'Chain updated' : 'Chain added');
          onSaved();
        },
        onFinally: () => setIsSaving(false),
        errorMessage: 'Failed to save chain',
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit chain' : 'Add chain'}</DialogTitle>
          <DialogDescription>
            Configure an EVM chain for the x402 payment rail. The CAIP-2 id is the unique key.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">CAIP-2 chain id</label>
            <Input
              placeholder="eip155:8453"
              className="font-mono"
              readOnly={!!editing}
              {...register('caip2Id')}
            />
            {errors.caip2Id && <p className="text-xs text-destructive">{errors.caip2Id.message}</p>}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Display name</label>
            <Input placeholder="Base" {...register('displayName')} />
            {errors.displayName && (
              <p className="text-xs text-destructive">{errors.displayName.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">RPC URL</label>
            <Input placeholder="https://mainnet.base.org" {...register('rpcUrl')} />
            {errors.rpcUrl && <p className="text-xs text-destructive">{errors.rpcUrl.message}</p>}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Default asset (optional)</label>
            <Input
              placeholder="0x… token contract"
              className="font-mono"
              {...register('defaultAsset')}
            />
            {errors.defaultAsset && (
              <p className="text-xs text-destructive">{errors.defaultAsset.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Facilitator wallet (optional)</label>
            <Controller
              control={control}
              name="facilitatorWalletId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a managed wallet" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_FACILITATOR}>None</SelectItem>
                    {wallets.map((wallet) => (
                      <SelectItem key={wallet.id} value={wallet.id} className="font-mono">
                        {shortenAddress(wallet.address, 8)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <p className="text-xs text-muted-foreground">
              Signs settlements for inbound payments on this chain.
            </p>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Testnet</p>
              <p className="text-xs text-muted-foreground">Pairs with the Preprod environment.</p>
            </div>
            <Controller
              control={control}
              name="isTestnet"
              render={({ field }) => (
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              )}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Enabled</p>
              <p className="text-xs text-muted-foreground">Allow x402 payments on this chain.</p>
            </div>
            <Controller
              control={control}
              name="isEnabled"
              render={({ field }) => (
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              )}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? 'Saving…' : editing ? 'Save changes' : 'Add chain'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
