import { useEffect } from 'react';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'react-toastify';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
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
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useX402Networks, useX402Wallets } from '@/lib/hooks/useX402';
import { isTestnetEnv, resolveX402ChainEnvironment } from '@/lib/x402-rail';
import { shortenAddress } from '@/lib/utils';
import { useApiMutation } from '@/lib/hooks/useApiMutation';
import { postX402Networks, X402Network, PostX402NetworksData } from '@/lib/api/generated';

const NO_FACILITATOR = '__none__';

const chainSchema = z
  .object({
    caip2Id: z
      .string()
      .regex(/^eip155:\d+$/, 'Must be a CAIP-2 EVM chain id, for example eip155:8453'),
    displayName: z.string().min(1, 'Enter a display name').max(120),
    rpcUrl: z
      .string()
      .url('Enter a URL that starts with https://')
      .regex(/^https?:\/\//, 'RPC URL must use HTTP or HTTPS'),
    isTestnet: z.boolean(),
    isEnabled: z.boolean(),
    defaultAsset: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, 'Must be an EVM token address')
      .or(z.literal(''))
      .optional(),
    defaultAssetDecimals: z.string().max(3).optional(),
    // A chain settles either through an owned Selling wallet (self-hosted) or a remote
    // facilitator URL — exactly one, enforced by the backend and by the mode toggle here.
    facilitatorMode: z.enum(['wallet', 'remote']),
    facilitatorWalletId: z.string().optional(),
    facilitatorUrl: z
      .string()
      .url('Must be a valid URL')
      .regex(/^https:\/\//, 'Remote facilitator URL must use HTTPS')
      .or(z.literal(''))
      .optional(),
    facilitatorAuth: z.string().optional(),
    clearFacilitatorAuth: z.boolean(),
  })
  // An enabled chain becomes a live payment source the moment it is saved, so it must be
  // fully configured: a facilitator is required to settle on it. Leave the chain disabled
  // to save an incomplete draft instead of exposing a half-configured rail.
  .superRefine((data, ctx) => {
    const decimals = Number(data.defaultAssetDecimals);
    if (data.defaultAsset && !data.defaultAssetDecimals) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Decimals are required for the default asset',
        path: ['defaultAssetDecimals'],
      });
    } else if (
      data.defaultAssetDecimals &&
      (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Must be a whole number between 0 and 255',
        path: ['defaultAssetDecimals'],
      });
    } else if (!data.defaultAsset && data.defaultAssetDecimals) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a default asset before its decimals',
        path: ['defaultAssetDecimals'],
      });
    }

    if (!data.isEnabled) return;
    if (data.facilitatorMode === 'wallet') {
      if (!data.facilitatorWalletId || data.facilitatorWalletId === NO_FACILITATOR) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Select a Selling wallet or switch to a remote facilitator',
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

export function ChainForm({
  editing,
  defaultFacilitatorMode = 'wallet',
  lockEnvironment = false,
  includeFacilitator = true,
  variant = 'dialog',
  onClose,
  onSaved,
}: {
  editing: X402Network | null;
  defaultFacilitatorMode?: 'wallet' | 'managed' | 'remote';
  lockEnvironment?: boolean;
  /**
   * False edits only the chain itself: the facilitator fields and the Enabled switch are
   * hidden and left untouched on save. The setup wizard sets the facilitator and enables the
   * chain in its own receive step.
   */
  includeFacilitator?: boolean;
  /** 'inline' renders plain actions instead of a DialogFooter (used inside the setup wizard). */
  variant?: 'dialog' | 'inline';
  onClose: () => void;
  onSaved: (network: X402Network) => void;
}) {
  const { apiClient, network } = useAppContext();
  // Only load the wallet set while the form is open (it feeds the picker). A facilitator
  // settles inbound payments and must be bound to THIS chain (the backend rejects any other
  // binding), so only this chain's Selling wallets are selectable. A chain being created has
  // no id yet — and can have no bound wallets — so the picker stays empty until it is saved.
  const { wallets } = useX402Wallets(!!editing && includeFacilitator, 'Selling', editing?.id);
  // The upsert is keyed by caip2Id, so "adding" an existing id would overwrite that chain.
  // Submit waits for the list; a failed fetch toasts instead of failing silently.
  const { networks: knownChains, isLoading: isLoadingKnownChains } = useX402Networks({
    allEnvironments: true,
    enabled: !editing,
  });
  const saveChain = useApiMutation({
    mutationFn: (body: NonNullable<PostX402NetworksData['body']>) =>
      postX402Networks({ client: apiClient, body }),
    errorMessage: 'Failed to save chain',
  });
  const isSaving = saveChain.isPending;
  const isSubmitBlocked = isSaving || (!editing && isLoadingKnownChains);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    setError,
    formState: { errors },
  } = useForm<ChainFormValues>({
    resolver: zodResolver(chainSchema),
    defaultValues: {
      caip2Id: editing?.caip2Id ?? '',
      displayName: editing?.displayName ?? '',
      rpcUrl: editing?.rpcUrl ?? '',
      // A new chain should land in the environment it is created from (testnet chains
      // pair with Preprod), otherwise it is invisible in the active env after saving.
      isTestnet: lockEnvironment
        ? isTestnetEnv(network)
        : (editing?.isTestnet ?? isTestnetEnv(network)),
      // A new self-hosted chain cannot have a bound facilitator wallet until the network row
      // exists. Save it disabled first; remote-facilitator users may enable it in this form.
      // A chain-only edit never sends isEnabled from the form, so keep it false there: the
      // "enabled needs a facilitator" rule must not block editing a live chain's RPC URL.
      isEnabled: includeFacilitator ? (editing?.isEnabled ?? false) : false,
      defaultAsset: editing?.defaultAsset ?? '',
      defaultAssetDecimals:
        editing?.defaultAssetDecimals != null ? String(editing.defaultAssetDecimals) : '',
      // Existing remote-facilitator chains open in remote mode; everything else defaults to
      // the owned-wallet mode. facilitatorAuth is write-only, so it is never prefilled.
      facilitatorMode: editing?.facilitatorUrl
        ? 'remote'
        : editing?.facilitatorWalletId
          ? 'wallet'
          : defaultFacilitatorMode === 'managed'
            ? 'wallet'
            : defaultFacilitatorMode,
      facilitatorWalletId: editing?.facilitatorWalletId ?? NO_FACILITATOR,
      facilitatorUrl: editing?.facilitatorUrl ?? '',
      facilitatorAuth: '',
      clearFacilitatorAuth: false,
    },
  });

  const facilitatorMode = useWatch({ control, name: 'facilitatorMode' });
  const clearFacilitatorAuth = useWatch({ control, name: 'clearFacilitatorAuth' });
  const defaultAsset = useWatch({ control, name: 'defaultAsset' });
  const hasExistingRemoteFacilitator = !!editing?.facilitatorUrl;

  // The decimals input is disabled while no default asset is set; clear its
  // RHF state too when the asset is removed, otherwise stale decimals behind
  // the disabled input make superRefine block submit on a field the user
  // can't edit.
  useEffect(() => {
    if (!defaultAsset) {
      setValue('defaultAssetDecimals', '');
    }
  }, [defaultAsset, setValue]);

  const onSubmit = async (data: ChainFormValues) => {
    const existing = editing ? null : knownChains.find((chain) => chain.caip2Id === data.caip2Id);
    if (existing) {
      setError('caip2Id', {
        message: `${existing.displayName} already uses this chain ID. Edit that chain instead.`,
      });
      return;
    }
    // Send exactly one facilitator mode; null the other so the backend's exactly-one rule is met.
    const isRemote = data.facilitatorMode === 'remote';
    const chainFields = {
      caip2Id: data.caip2Id,
      displayName: data.displayName,
      rpcUrl: data.rpcUrl,
      isTestnet: resolveX402ChainEnvironment(network, data.isTestnet, lockEnvironment),
      defaultAsset: data.defaultAsset ? data.defaultAsset : null,
      defaultAssetDecimals: data.defaultAsset ? Number(data.defaultAssetDecimals) : null,
    };
    // Chain-only saves omit every facilitator field, which the upsert then leaves unchanged.
    // An edit also omits isEnabled so the stored value is kept; a new chain starts disabled
    // because it has no facilitator yet.
    const body = !includeFacilitator
      ? editing
        ? chainFields
        : { ...chainFields, isEnabled: false }
      : {
          ...chainFields,
          isEnabled: data.isEnabled,
          facilitatorWalletId:
            !isRemote && data.facilitatorWalletId && data.facilitatorWalletId !== NO_FACILITATOR
              ? data.facilitatorWalletId
              : null,
          facilitatorUrl: isRemote && data.facilitatorUrl ? data.facilitatorUrl : null,
          // Auth is write-only and never prefilled. Blank preserves it for same-origin edits,
          // explicit clear sends null, and a retyped value sets/rotates it for the submitted URL.
          facilitatorAuth: !isRemote
            ? undefined
            : data.clearFacilitatorAuth
              ? null
              : data.facilitatorAuth || undefined,
        };
    const response = await saveChain.mutateAsync(body).catch(() => null);
    if (!response) return;
    const savedNetwork = response.data?.data;
    if (!savedNetwork) return;
    toast.success(editing ? 'Chain updated' : 'Chain added');
    onSaved(savedNetwork);
  };

  return (
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
        <Input id="chain-rpcUrl" placeholder="https://mainnet.base.org" {...register('rpcUrl')} />
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
        <label htmlFor="chain-defaultAssetDecimals" className="text-sm font-medium">
          Default asset decimals
        </label>
        <Input
          id="chain-defaultAssetDecimals"
          type="number"
          inputMode="numeric"
          min="0"
          max="255"
          placeholder="6"
          disabled={!defaultAsset}
          {...register('defaultAssetDecimals')}
        />
        {errors.defaultAssetDecimals && (
          <p className="text-xs text-destructive">{errors.defaultAssetDecimals.message}</p>
        )}
      </div>

      {includeFacilitator && (
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
                  <SelectGroup>
                    <SelectItem value="wallet">Owned Selling wallet (self-hosted)</SelectItem>
                    <SelectItem value="remote">Remote facilitator URL</SelectItem>
                  </SelectGroup>
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
                      <SelectGroup>
                        <SelectItem value={NO_FACILITATOR}>None</SelectItem>
                        {wallets.map((wallet) => (
                          <SelectItem key={wallet.id} value={wallet.id} className="font-mono">
                            {shortenAddress(wallet.address, 8)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
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
                  Save the chain first, then create a Selling wallet bound to it and assign it here
                  as the facilitator.
                </p>
              )}
            </>
          ) : (
            <>
              <label htmlFor="chain-facilitatorUrl" className="block pt-1 text-sm font-medium">
                Facilitator URL
              </label>
              <Input
                id="chain-facilitatorUrl"
                placeholder="https://facilitator.example"
                aria-invalid={!!errors.facilitatorUrl}
                {...register('facilitatorUrl')}
              />
              {errors.facilitatorUrl && (
                <p className="text-xs text-destructive">{errors.facilitatorUrl.message}</p>
              )}
              <label htmlFor="chain-facilitatorAuth" className="block pt-1 text-sm font-medium">
                Authorization header (optional)
              </label>
              <Input
                id="chain-facilitatorAuth"
                type="password"
                placeholder={
                  hasExistingRemoteFacilitator ? 'Blank keeps the stored value' : 'Bearer …'
                }
                autoComplete="new-password"
                spellCheck={false}
                disabled={clearFacilitatorAuth}
                {...register('facilitatorAuth')}
              />
              {hasExistingRemoteFacilitator && (
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <p className="text-sm font-medium">Clear stored authorization</p>
                    <p className="text-xs text-muted-foreground">
                      Stop sending the existing Authorization header after this save.
                    </p>
                  </div>
                  <Controller
                    control={control}
                    name="clearFacilitatorAuth"
                    render={({ field }) => (
                      <Switch
                        aria-label="Clear stored facilitator authorization"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    )}
                  />
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                A remote facilitator settles inbound payments over HTTPS. The node holds no key on
                this chain. Auth is stored encrypted and never shown again
                {hasExistingRemoteFacilitator
                  ? clearFacilitatorAuth
                    ? '; the stored value will be cleared when saved.'
                    : '; blank preserves it only while the URL origin stays unchanged.'
                  : '.'}
              </p>
            </>
          )}
        </div>
      )}

      {/* The wizard fixes the environment, so the switch only shows where it can change. */}
      {!lockEnvironment && (
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <p className="text-sm font-medium">Testnet</p>
            <p className="text-xs text-muted-foreground">Pairs with the Preprod environment.</p>
          </div>
          <Controller
            control={control}
            name="isTestnet"
            render={({ field }) => (
              <Switch aria-label="Testnet" checked={field.value} onCheckedChange={field.onChange} />
            )}
          />
        </div>
      )}

      {includeFacilitator && (
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <p className="text-sm font-medium">Enabled</p>
            <p className="text-xs text-muted-foreground">Allow x402 payments on this chain.</p>
          </div>
          <Controller
            control={control}
            name="isEnabled"
            render={({ field }) => (
              <Switch aria-label="Enabled" checked={field.value} onCheckedChange={field.onChange} />
            )}
          />
        </div>
      )}

      {variant === 'dialog' ? (
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitBlocked}>
            {isSaving ? 'Saving…' : editing ? 'Save changes' : 'Add chain'}
          </Button>
        </DialogFooter>
      ) : (
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitBlocked}>
            {isSaving ? 'Saving…' : editing ? 'Save chain' : 'Add chain'}
          </Button>
        </div>
      )}
    </form>
  );
}

export function ChainDialog({
  open,
  editing,
  defaultFacilitatorMode = 'wallet',
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: X402Network | null;
  defaultFacilitatorMode?: 'wallet' | 'managed' | 'remote';
  onClose: () => void;
  onSaved: (network: X402Network) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit chain' : 'Add chain'}</DialogTitle>
          <DialogDescription>
            Configure an EVM chain for the x402 payment rail. The CAIP-2 id is the unique key.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <ChainForm
            editing={editing}
            defaultFacilitatorMode={defaultFacilitatorMode}
            onClose={onClose}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
