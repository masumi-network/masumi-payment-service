import { useState } from 'react';
import { useRouter } from 'next/router';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'react-toastify';
import { Plus, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
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
import { useX402Networks, useX402Wallets } from '@/lib/hooks/useX402';
import { isTestnetEnv } from '@/lib/x402-rail';
import { shortenAddress } from '@/lib/utils';
import { useApiMutation } from '@/lib/hooks/useApiMutation';
import { postX402Networks, X402Network, PostX402NetworksData } from '@/lib/api/generated';

const NO_FACILITATOR = '__none__';

const chainSchema = z
  .object({
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
    // A chain settles either through an owned Selling wallet (self-hosted) or a remote
    // facilitator URL — exactly one, enforced by the backend and by the mode toggle here.
    facilitatorMode: z.enum(['wallet', 'remote']),
    facilitatorWalletId: z.string().optional(),
    facilitatorUrl: z.string().url('Must be a valid URL').or(z.literal('')).optional(),
    facilitatorAuth: z.string().optional(),
  })
  // An enabled chain becomes a live payment source the moment it is saved, so it must be
  // fully configured: a facilitator is required to settle on it. Leave the chain disabled
  // to save an incomplete draft instead of exposing a half-configured rail.
  .superRefine((data, ctx) => {
    if (!data.isEnabled) return;
    if (data.facilitatorMode === 'wallet') {
      if (!data.facilitatorWalletId || data.facilitatorWalletId === NO_FACILITATOR) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A facilitator wallet is required to enable a chain',
          path: ['facilitatorWalletId'],
        });
      }
    } else if (!data.facilitatorUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A facilitator URL is required to enable a chain',
        path: ['facilitatorUrl'],
      });
    }
  });

type ChainFormValues = z.infer<typeof chainSchema>;

export function ChainsTab() {
  const router = useRouter();
  const { networks, isLoading, isRefetching, refetch } = useX402Networks();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<X402Network | null>(null);

  // Adding a chain goes through the guided setup wizard instead of the raw form, so a new
  // chain is always created complete (wallet → facilitator) rather than as a bare row. The
  // inline dialog stays only for editing an already-configured chain.
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
          <Button onClick={() => router.push('/x402-setup')} className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Add chain
          </Button>
        </div>
      </div>

      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full">
          <thead className="bg-muted/30 dark:bg-muted/15">
            <tr className="border-b">
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Chain
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                RPC URL
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Status
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Default asset
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Facilitator
              </th>
              <th scope="col" className="p-4 text-right text-sm font-medium text-muted-foreground">
                Actions
              </th>
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
                    {network.defaultAsset ? (
                      <div className="flex items-center gap-1">
                        <span title={network.defaultAsset}>
                          {shortenAddress(network.defaultAsset, 6)}
                        </span>
                        <CopyButton value={network.defaultAsset} />
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="p-4 text-sm">
                    {network.facilitatorUrl ? (
                      <span className="flex items-center gap-1.5">
                        <Badge variant="outline">Remote</Badge>
                        <span
                          className="font-mono text-xs max-w-[180px] truncate"
                          title={network.facilitatorUrl}
                        >
                          {network.facilitatorUrl}
                        </span>
                      </span>
                    ) : network.facilitatorWalletId ? (
                      <FacilitatorLabel
                        address={network.facilitatorWalletAddress}
                        walletId={network.facilitatorWalletId}
                      />
                    ) : (
                      <Badge variant="warning">Not set</Badge>
                    )}
                  </td>
                  <td className="p-4 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Edit chain"
                      onClick={() => openEdit(network)}
                    >
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
        key={dialogOpen ? (editing?.id ?? 'new') : 'closed'}
        open={dialogOpen}
        editing={editing}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSaved={() => {
          setDialogOpen(false);
          setEditing(null);
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
  const { apiClient, network } = useAppContext();
  // Only load the wallet set while the form is open (it feeds the picker). A facilitator
  // settles inbound payments and must be bound to THIS chain (the backend rejects any other
  // binding), so only this chain's Selling wallets are selectable. A chain being created has
  // no id yet — and can have no bound wallets — so the picker stays empty until it is saved.
  const { wallets } = useX402Wallets(open && !!editing, 'Selling', editing?.id);
  const saveChain = useApiMutation({
    mutationFn: (body: NonNullable<PostX402NetworksData['body']>) =>
      postX402Networks({ client: apiClient, body }),
    errorMessage: 'Failed to save chain',
  });
  const isSaving = saveChain.isPending;

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
      // A new chain should land in the environment it is created from (testnet chains
      // pair with Preprod), otherwise it is invisible in the active env after saving.
      isTestnet: editing?.isTestnet ?? isTestnetEnv(network),
      isEnabled: editing?.isEnabled ?? true,
      defaultAsset: editing?.defaultAsset ?? '',
      // Existing remote-facilitator chains open in remote mode; everything else defaults to
      // the owned-wallet mode. facilitatorAuth is write-only, so it is never prefilled.
      facilitatorMode: editing?.facilitatorUrl ? 'remote' : 'wallet',
      facilitatorWalletId: editing?.facilitatorWalletId ?? NO_FACILITATOR,
      facilitatorUrl: editing?.facilitatorUrl ?? '',
      facilitatorAuth: '',
    },
  });

  const facilitatorMode = useWatch({ control, name: 'facilitatorMode' });

  const onSubmit = async (data: ChainFormValues) => {
    // Send exactly one facilitator mode; null the other so the backend's exactly-one rule is met.
    const isRemote = data.facilitatorMode === 'remote';
    const response = await saveChain
      .mutateAsync({
        caip2Id: data.caip2Id,
        displayName: data.displayName,
        rpcUrl: data.rpcUrl,
        isTestnet: data.isTestnet,
        isEnabled: data.isEnabled,
        defaultAsset: data.defaultAsset ? data.defaultAsset : null,
        facilitatorWalletId:
          !isRemote && data.facilitatorWalletId && data.facilitatorWalletId !== NO_FACILITATOR
            ? data.facilitatorWalletId
            : null,
        facilitatorUrl: isRemote && data.facilitatorUrl ? data.facilitatorUrl : null,
        // Auth is write-only and never prefilled, so an empty field means "leave the stored auth
        // as-is" — send undefined (omit) to keep it, not null (which would clear it) and silently
        // unauthenticate every later settle. A retyped value sets/rotates it.
        facilitatorAuth: isRemote && data.facilitatorAuth ? data.facilitatorAuth : undefined,
      })
      .catch(() => null);
    if (!response) return;
    toast.success(editing ? 'Chain updated' : 'Chain added');
    onSaved();
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
            <label htmlFor="chain-caip2Id" className="text-sm font-medium">
              CAIP-2 chain id
            </label>
            <Input
              id="chain-caip2Id"
              placeholder="eip155:8453"
              className="font-mono"
              readOnly={!!editing}
              {...register('caip2Id')}
            />
            {errors.caip2Id && <p className="text-xs text-destructive">{errors.caip2Id.message}</p>}
          </div>

          <div className="space-y-2">
            <label htmlFor="chain-displayName" className="text-sm font-medium">
              Display name
            </label>
            <Input id="chain-displayName" placeholder="Base" {...register('displayName')} />
            {errors.displayName && (
              <p className="text-xs text-destructive">{errors.displayName.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="chain-rpcUrl" className="text-sm font-medium">
              RPC URL
            </label>
            <Input
              id="chain-rpcUrl"
              placeholder="https://mainnet.base.org"
              {...register('rpcUrl')}
            />
            {errors.rpcUrl && <p className="text-xs text-destructive">{errors.rpcUrl.message}</p>}
          </div>

          <div className="space-y-2">
            <label htmlFor="chain-defaultAsset" className="text-sm font-medium">
              Default asset (optional)
            </label>
            <Input
              id="chain-defaultAsset"
              placeholder="0x… token contract"
              className="font-mono"
              {...register('defaultAsset')}
            />
            {errors.defaultAsset && (
              <p className="text-xs text-destructive">{errors.defaultAsset.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Facilitator</label>
            <Controller
              control={control}
              name="facilitatorMode"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger aria-label="Facilitator mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="wallet">Owned Selling wallet (self-hosted)</SelectItem>
                    <SelectItem value="remote">Remote facilitator URL</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />

            {facilitatorMode === 'wallet' ? (
              <>
                <Controller
                  control={control}
                  name="facilitatorWalletId"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger aria-label="Facilitator wallet">
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
                {errors.facilitatorWalletId ? (
                  <p className="text-xs text-destructive">{errors.facilitatorWalletId.message}</p>
                ) : editing ? (
                  <p className="text-xs text-muted-foreground">
                    An owned Selling wallet bound to this chain signs settlements locally and pays
                    gas. Required to enable the chain.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Save the chain first, then create a Selling wallet bound to it and assign it
                    here as the facilitator.
                  </p>
                )}
              </>
            ) : (
              <>
                <Input
                  placeholder="https://facilitator.example"
                  aria-label="Facilitator URL"
                  {...register('facilitatorUrl')}
                />
                {errors.facilitatorUrl && (
                  <p className="text-xs text-destructive">{errors.facilitatorUrl.message}</p>
                )}
                <Input
                  placeholder={
                    editing
                      ? 'Authorization header value (leave blank to keep current)'
                      : 'Authorization header value (optional)'
                  }
                  aria-label="Facilitator auth"
                  {...register('facilitatorAuth')}
                />
                <p className="text-xs text-muted-foreground">
                  A remote facilitator settles inbound payments over HTTP — the node holds no key on
                  this chain. Auth is stored encrypted and never shown again
                  {editing ? '; leave this blank to keep the stored value unchanged.' : '.'}
                </p>
              </>
            )}
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
                <Switch
                  aria-label="Testnet"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
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
                <Switch
                  aria-label="Enabled"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
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
