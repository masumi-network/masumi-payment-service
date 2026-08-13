import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useState, useEffect, useMemo, useRef } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postApiKey } from '@/lib/api/generated';
import { useX402Networks } from '@/lib/hooks/useX402';
import { toast } from 'react-toastify';
import { useApiMutation } from '@/lib/hooks/useApiMutation';
import { FormField } from '@/components/ui/form-field';
import { Checkbox } from '@/components/ui/checkbox';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Badge } from '@/components/ui/badge';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { useAllWallets } from '@/lib/queries/useWallets';
import { X402WalletScopeField } from '@/components/api-keys/X402WalletScopeField';
import { shortenAddress } from '@/lib/utils';
import { CopyButton } from '@/components/ui/copy-button';
import { extractApiPayload } from '@/lib/api-response';
import {
  getActiveStablecoinConfig,
  getActiveStablecoinSymbol,
} from '@/lib/constants/defaultWallets';
import { convertDecimalToBaseUnits, isValidDecimalAmount } from '@/lib/convertDecimalToBaseUnits';
import type { ApiKey, PostApiKeyData } from '@/lib/api/generated';

interface AddApiKeyDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

// Permission presets for convenient selection
type PermissionPreset = 'Read' | 'ReadAndPay' | 'Admin';

const apiKeySchema = z
  .object({
    // UI selection for permission preset
    permissionPreset: z.enum(['Read', 'ReadAndPay', 'Admin']),
    // Flag-based permissions (derived from preset)
    canRead: z.boolean(),
    canPay: z.boolean(),
    canAdmin: z.boolean(),
    networks: z.array(z.enum(['Preprod', 'Mainnet'])).min(1, 'Select at least one network'),
    evmChains: z.array(z.string()),
    usageLimited: z.boolean(),
    credits: z.object({
      lovelace: z.string().optional(),
      usdcx: z.string().optional(),
    }),
    walletScopeEnabled: z.boolean(),
    walletScopeIds: z.array(z.string()),
    x402WalletScopeEnabled: z.boolean(),
    x402WalletScopeIds: z.array(z.string()),
  })
  .superRefine((val, ctx) => {
    if (
      val.canPay &&
      !val.canAdmin &&
      val.usageLimited &&
      !val.credits.lovelace &&
      !val.credits.usdcx
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Please specify usage credits for payment permission',
        path: ['credits', 'lovelace'],
      });
    }
    // Reject amounts with more fractional digits than the unit supports (ADA /
    // USDCx both have 6). Without this, convertDecimalToBaseUnits silently
    // TRUNCATES the extra digits, granting fewer credits than the operator
    // typed. Add-credits are positive, so negatives are not allowed here.
    if (val.credits.lovelace && !isValidDecimalAmount(val.credits.lovelace)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid ADA amount',
        path: ['credits', 'lovelace'],
      });
    }
    if (val.credits.usdcx && !isValidDecimalAmount(val.credits.usdcx)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid USDCx amount',
        path: ['credits', 'usdcx'],
      });
    }
  });

type ApiKeyFormValues = z.infer<typeof apiKeySchema>;

/**
 * Maps a permission preset to flag values.
 */
function presetToFlags(preset: PermissionPreset): {
  canRead: boolean;
  canPay: boolean;
  canAdmin: boolean;
} {
  switch (preset) {
    case 'Admin':
      return { canRead: true, canPay: true, canAdmin: true };
    case 'ReadAndPay':
      return { canRead: true, canPay: true, canAdmin: false };
    case 'Read':
    default:
      return { canRead: true, canPay: false, canAdmin: false };
  }
}

export function AddApiKeyDialog({ open, onClose, onSuccess }: AddApiKeyDialogProps) {
  const [createdApiKey, setCreatedApiKey] = useState<ApiKey | null>(null);
  const { apiClient, network } = useAppContext();

  const createApiKey = useApiMutation({
    mutationFn: (body: NonNullable<PostApiKeyData['body']>) =>
      postApiKey({ client: apiClient, body }),
    errorMessage: 'Failed to create API key',
  });
  const isLoading = createApiKey.isPending;
  const { paymentSources } = usePaymentSourceExtendedAll();
  const { wallets: managedWallets } = useAllWallets(open);
  // A key's NetworkLimit can span both Cardano networks, so offer EVM chains from every
  // environment, not just the active top-selector one, or chains for the other network
  // can't be added to ChainIdLimit in one flow.
  const { networks: evmChainOptions } = useX402Networks({
    silentErrors: true,
    allEnvironments: true,
  });

  const allWallets = useMemo(() => {
    // Wallets come from /wallet/list now; join to the source for its network.
    const networkBySourceId = new Map(paymentSources.map((ps) => [ps.id, ps.network]));
    return managedWallets.map((wallet) => ({
      id: wallet.id,
      type: wallet.type,
      network: networkBySourceId.get(wallet.paymentSourceId) ?? '',
      walletAddress: wallet.walletAddress,
      note: wallet.note,
    }));
  }, [managedWallets, paymentSources]);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    reset,
    formState: { errors },
  } = useForm<ApiKeyFormValues>({
    resolver: zodResolver(apiKeySchema),
    defaultValues: {
      permissionPreset: 'Read',
      canRead: true,
      canPay: false,
      canAdmin: false,
      usageLimited: true,
      networks: ['Preprod', 'Mainnet'],
      evmChains: [],
      credits: { lovelace: '', usdcx: '' },
      walletScopeEnabled: false,
      walletScopeIds: [],
      x402WalletScopeEnabled: false,
      x402WalletScopeIds: [],
    },
  });

  const permissionPreset = useWatch({ control, name: 'permissionPreset', defaultValue: 'Read' });
  const canAdmin = useWatch({ control, name: 'canAdmin', defaultValue: false });
  const canPay = useWatch({ control, name: 'canPay', defaultValue: false });
  const selectedNetworks = useWatch({
    control,
    name: 'networks',
    defaultValue: ['Preprod', 'Mainnet'],
  });
  const currentEvmChains = useWatch({ control, name: 'evmChains', defaultValue: [] });
  const usageLimited = useWatch({ control, name: 'usageLimited', defaultValue: true });
  const walletScopeEnabled = useWatch({ control, name: 'walletScopeEnabled', defaultValue: false });
  const walletScopeIds = useWatch({ control, name: 'walletScopeIds', defaultValue: [] });
  const x402WalletScopeEnabled = useWatch({
    control,
    name: 'x402WalletScopeEnabled',
    defaultValue: false,
  });
  const x402WalletScopeIds = useWatch({ control, name: 'x402WalletScopeIds', defaultValue: [] });

  // Update flags when preset changes
  useEffect(() => {
    const flags = presetToFlags(permissionPreset);
    setValue('canRead', flags.canRead);
    setValue('canPay', flags.canPay);
    setValue('canAdmin', flags.canAdmin);

    // Auto-adjust usageLimited based on permission
    if (flags.canAdmin) {
      setValue('usageLimited', false);
      setValue('networks', ['Preprod', 'Mainnet']);
      setValue('evmChains', []);
      setValue('walletScopeEnabled', false);
      setValue('walletScopeIds', []);
      setValue('x402WalletScopeEnabled', false);
      setValue('x402WalletScopeIds', []);
    } else if (!flags.canPay) {
      // Read-only: always usage limited. EVM chains are deliberately KEPT — the
      // x402 read surfaces (chains, wallets, payment history) are chain-limited
      // too, so clearing them here shipped read keys whose x402 pages were
      // permanently empty, with no way to repair it from the update dialog.
      setValue('usageLimited', true);
    }
  }, [permissionPreset, setValue]);

  // Start every non-admin key with the configured EVM chains of its selected
  // Cardano environments ticked (Preprod selects testnet chains, Mainnet selects
  // mainnet chains) — the twin of `networks` defaulting to both Cardano networks,
  // and the same environment coupling the backend applies when ChainIdLimit is
  // omitted. The grant is visible and can be narrowed, instead of the key silently
  // getting no EVM access at all. Seeded once per session so unticking a chain is
  // not undone on the next render.
  const seededEvmChains = useRef(false);
  useEffect(() => {
    if (!open || canAdmin) {
      seededEvmChains.current = false;
      return;
    }
    if (evmChainOptions.length === 0) return;
    const allowedChainIds = new Set(
      evmChainOptions
        .filter((chain) =>
          chain.isTestnet
            ? selectedNetworks.includes('Preprod')
            : selectedNetworks.includes('Mainnet'),
        )
        .map((chain) => chain.caip2Id),
    );
    if (seededEvmChains.current) {
      // Already seeded: never re-add (that would undo the admin's unticks), but DO
      // prune chains whose environment has since been deselected. The seed runs
      // while `networks` still holds its default of both environments, so without
      // this pruning the coupling was dead on arrival — narrowing to Preprod after
      // the list loaded still submitted the mainnet chains, which is exactly the
      // case the backend's environment-coupled default exists to prevent.
      const pruned = currentEvmChains.filter((chainId) => allowedChainIds.has(chainId));
      if (pruned.length !== currentEvmChains.length) {
        setValue('evmChains', pruned);
      }
      return;
    }
    seededEvmChains.current = true;
    setValue(
      'evmChains',
      evmChainOptions
        .filter((chain) =>
          chain.isTestnet
            ? selectedNetworks.includes('Preprod')
            : selectedNetworks.includes('Mainnet'),
        )
        .map((chain) => chain.caip2Id),
    );
  }, [open, canAdmin, evmChainOptions, selectedNetworks, currentEvmChains, setValue]);

  const onSubmit = async (data: ApiKeyFormValues) => {
    const isReadOnly = !data.canPay && !data.canAdmin;
    const defaultCredits = [
      {
        unit: 'lovelace',
        amount: '1000000000', // 1000 ADA
      },
    ];
    // Errors are toasted by the mutation hook; nothing further to do here.
    const response = await createApiKey
      .mutateAsync({
        // Send flag-based permissions
        canRead: data.canRead,
        canPay: data.canPay,
        canAdmin: data.canAdmin,
        usageLimited: isReadOnly ? 'true' : data.usageLimited.toString(),
        NetworkLimit: data.networks,
        // Every non-admin key carries its EVM chain grant — read keys need it for
        // the x402 read surfaces, not just pay keys for settling. Admins are
        // unrestricted by canAdmin, so their explicit list is irrelevant.
        //
        // When the chain list could not be loaded (the query errors silently, or
        // has not settled) the EVM section is hidden and evmChains is empty. Send
        // UNDEFINED rather than [] in that case: [] means "grant none" and would
        // mint a key permanently barred from every x402 surface without the admin
        // ever seeing the choice, whereas omitting it lets the server apply its
        // environment-coupled default.
        ChainIdLimit: data.canAdmin
          ? []
          : evmChainOptions.length === 0
            ? undefined
            : data.evmChains,
        UsageCredits: isReadOnly
          ? defaultCredits
          : data.usageLimited
            ? [
                ...(data.credits.lovelace
                  ? [
                      {
                        unit: 'lovelace',
                        amount: convertDecimalToBaseUnits(data.credits.lovelace),
                      },
                    ]
                  : []),
                ...(data.credits.usdcx
                  ? [
                      {
                        unit: getActiveStablecoinConfig(network).fullAssetId,
                        amount: convertDecimalToBaseUnits(data.credits.usdcx),
                      },
                    ]
                  : []),
              ]
            : [],
        walletScopeEnabled: data.walletScopeEnabled,
        WalletScopeHotWalletIds: data.walletScopeEnabled ? data.walletScopeIds : [],
        x402WalletScopeEnabled: data.x402WalletScopeEnabled,
        X402WalletScopeEvmWalletIds: data.x402WalletScopeEnabled ? data.x402WalletScopeIds : [],
      })
      .catch(() => null);
    if (!response) return;

    const created = extractApiPayload<ApiKey>(response);
    if (!created?.token || created.token.startsWith('*****')) {
      toast.error(
        'API key was created but the full token was not returned. Delete it and create a new one.',
      );
      onSuccess();
      onClose();
      return;
    }

    toast.success('API key created successfully');
    setCreatedApiKey(created);
  };

  const handleClose = () => {
    // Block closing while creation is in flight: the key may already be created
    // server-side, and closing would skip the one-time token screen.
    if (createdApiKey || isLoading) return;
    reset();
    onClose();
  };

  const handleDone = () => {
    setCreatedApiKey(null);
    reset();
    onSuccess();
    onClose();
  };

  const isReadOnly = !canPay && !canAdmin;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent hideClose={Boolean(createdApiKey)}>
        {createdApiKey ? (
          <>
            <DialogHeader>
              <DialogTitle>API key created</DialogTitle>
              <DialogDescription>Copy this key now. It will only be shown once.</DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="text-sm text-amber-800 dark:text-amber-200">
                  Store this token securely. After you close this dialog, only the redacted key will
                  be visible in the API keys table.
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">API key</label>
                <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                  <span className="min-w-0 flex-1 break-all font-mono text-xs">
                    {createdApiKey.token}
                  </span>
                  <CopyButton value={createdApiKey.token} className="h-8 w-8 shrink-0" />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <Button type="button" onClick={handleDone}>
                Done
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add API key</DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Permission Level</label>
                <Controller
                  control={control}
                  name="permissionPreset"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger aria-label="Permission level">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Read">Read Only</SelectItem>
                        <SelectItem value="ReadAndPay">Read and Pay</SelectItem>
                        <SelectItem value="Admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
                <p className="text-xs text-muted-foreground">
                  {permissionPreset === 'Read' && 'Can read data but cannot make payments'}
                  {permissionPreset === 'ReadAndPay' && 'Can read data and make payments/purchases'}
                  {permissionPreset === 'Admin' && 'Full access to all operations'}
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Networks</label>
                <div className="flex gap-4">
                  <div className="flex items-center gap-2">
                    <Controller
                      control={control}
                      name="networks"
                      render={({ field }) => (
                        <Checkbox
                          aria-label="Preprod"
                          checked={field.value.includes('Preprod')}
                          disabled={canAdmin}
                          onCheckedChange={() => {
                            if (field.value.includes('Preprod')) {
                              field.onChange(field.value.filter((n: string) => n !== 'Preprod'));
                            } else {
                              field.onChange([...field.value, 'Preprod']);
                            }
                          }}
                        />
                      )}
                    />
                    <label className="text-sm">Preprod</label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Controller
                      control={control}
                      name="networks"
                      render={({ field }) => (
                        <Checkbox
                          aria-label="Mainnet"
                          checked={field.value.includes('Mainnet')}
                          disabled={canAdmin}
                          onCheckedChange={() => {
                            if (field.value.includes('Mainnet')) {
                              field.onChange(field.value.filter((n: string) => n !== 'Mainnet'));
                            } else {
                              field.onChange([...field.value, 'Mainnet']);
                            }
                          }}
                        />
                      )}
                    />
                    <label className="text-sm">Mainnet</label>
                  </div>
                </div>
                {errors.networks && (
                  <p className="text-xs text-destructive mt-1">{errors.networks.message}</p>
                )}
              </div>

              {!canAdmin && evmChainOptions.length > 0 && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">EVM chains (x402)</label>
                  <p className="text-xs text-muted-foreground">
                    Grant this key access to x402 chains: read keys can view wallets and payment
                    activity there; pay keys can also settle and pay.
                  </p>
                  <Controller
                    control={control}
                    name="evmChains"
                    render={({ field }) => (
                      <div className="flex flex-col gap-2">
                        {evmChainOptions.map((chain) => (
                          <div key={chain.id} className="flex items-center gap-2">
                            <Checkbox
                              aria-label={chain.displayName}
                              checked={field.value.includes(chain.caip2Id)}
                              onCheckedChange={() => {
                                if (field.value.includes(chain.caip2Id)) {
                                  field.onChange(
                                    field.value.filter((c: string) => c !== chain.caip2Id),
                                  );
                                } else {
                                  field.onChange([...field.value, chain.caip2Id]);
                                }
                              }}
                            />
                            <label className="text-sm">
                              {chain.displayName}{' '}
                              <span className="font-mono text-xs text-muted-foreground">
                                {chain.caip2Id}
                              </span>
                            </label>
                          </div>
                        ))}
                      </div>
                    )}
                  />
                </div>
              )}

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Controller
                    control={control}
                    name="usageLimited"
                    render={({ field }) => (
                      <Checkbox
                        aria-label="Limit usage"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        disabled={isReadOnly || canAdmin}
                      />
                    )}
                  />
                  <label className="text-sm font-medium">Limit Usage</label>
                </div>
                {canAdmin && (
                  <p className="text-xs text-muted-foreground">Admin keys are not usage limited</p>
                )}
              </div>

              {usageLimited && !isReadOnly && (
                <>
                  <FormField
                    label="ADA Limit"
                    htmlFor="apikey-ada-limit"
                    error={
                      errors.credits && 'lovelace' in errors.credits
                        ? errors.credits.lovelace?.message
                        : undefined
                    }
                    className="space-y-2"
                  >
                    <Input
                      id="apikey-ada-limit"
                      type="number"
                      placeholder="0.00"
                      {...register('credits.lovelace')}
                    />
                    <p className="text-xs text-muted-foreground">
                      Amount in ADA (will be converted to lovelace)
                    </p>
                  </FormField>

                  <FormField
                    label={`${getActiveStablecoinSymbol(network)} Limit`}
                    htmlFor="apikey-usdcx-limit"
                    error={
                      errors.credits && 'usdcx' in errors.credits
                        ? errors.credits.usdcx?.message
                        : undefined
                    }
                    className="space-y-2"
                  >
                    <Input
                      id="apikey-usdcx-limit"
                      type="number"
                      placeholder="0.00"
                      {...register('credits.usdcx')}
                    />
                  </FormField>
                </>
              )}

              {!canAdmin && (
                <>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Controller
                        control={control}
                        name="walletScopeEnabled"
                        render={({ field }) => (
                          <Checkbox
                            aria-label="Restrict to specific wallets"
                            checked={field.value}
                            onCheckedChange={(checked) => {
                              field.onChange(checked);
                              if (!checked) {
                                setValue('walletScopeIds', []);
                              }
                            }}
                          />
                        )}
                      />
                      <label className="text-sm font-medium">Restrict to specific wallets</label>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      When enabled, this API key can only access data for the selected wallets.
                    </p>
                  </div>

                  {walletScopeEnabled && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Wallets in scope</label>
                      <div className="border rounded-md max-h-48 overflow-y-auto">
                        {allWallets.length === 0 ? (
                          <p className="text-xs text-muted-foreground p-3">No wallets available</p>
                        ) : (
                          allWallets.map((wallet) => (
                            <label
                              key={wallet.id}
                              className="flex items-center gap-2 px-3 py-2 hover:bg-muted/50 cursor-pointer border-b last:border-b-0"
                            >
                              <Checkbox
                                checked={walletScopeIds.includes(wallet.id)}
                                onCheckedChange={(checked) => {
                                  if (checked) {
                                    setValue('walletScopeIds', [...walletScopeIds, wallet.id]);
                                  } else {
                                    setValue(
                                      'walletScopeIds',
                                      walletScopeIds.filter((id) => id !== wallet.id),
                                    );
                                  }
                                }}
                              />
                              <span className="flex items-center gap-2 min-w-0">
                                <Badge
                                  variant="outline"
                                  className="text-[10px] px-1.5 py-0 shrink-0"
                                >
                                  {wallet.type}
                                </Badge>
                                <span className="text-xs text-muted-foreground shrink-0">
                                  {wallet.network}
                                </span>
                                <span className="font-mono text-xs truncate">
                                  {shortenAddress(wallet.walletAddress)}
                                </span>
                                {wallet.note && (
                                  <span className="text-xs text-muted-foreground truncate max-w-[120px]">
                                    ({wallet.note})
                                  </span>
                                )}
                              </span>
                            </label>
                          ))
                        )}
                      </div>
                      {walletScopeIds.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          {walletScopeIds.length} wallet{walletScopeIds.length !== 1 ? 's' : ''}{' '}
                          selected
                        </p>
                      )}
                    </div>
                  )}

                  <X402WalletScopeField
                    active={open}
                    enabled={x402WalletScopeEnabled}
                    onEnabledChange={(next) => setValue('x402WalletScopeEnabled', next)}
                    selectedIds={x402WalletScopeIds}
                    onSelectedIdsChange={(ids) => setValue('x402WalletScopeIds', ids)}
                  />
                </>
              )}
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <Button variant="outline" disabled={isLoading} onClick={handleClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={isLoading} onClick={handleSubmit(onSubmit)}>
                {isLoading ? 'Creating...' : 'Create'}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
