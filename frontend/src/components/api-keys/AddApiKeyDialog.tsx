import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { useState, useEffect, useMemo } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postApiKey, type ApiKey } from '@/lib/api/generated';
import { useX402Networks } from '@/lib/hooks/useX402';
import { toast } from 'react-toastify';
import { handleApiCall, shortenAddress } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Badge } from '@/components/ui/badge';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { useAllWallets } from '@/lib/queries/useWallets';
import {
  getActiveStablecoinConfig,
  getActiveStablecoinSymbol,
} from '@/lib/constants/defaultWallets';
import { convertDecimalToBaseUnits } from '@/lib/convertDecimalToBaseUnits';
import { extractApiPayload } from '@/lib/api-response';
import { CopyButton } from '@/components/ui/copy-button';
import { KeyRound } from 'lucide-react';

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
  });

type ApiKeyFormValues = z.infer<typeof apiKeySchema>;

type CreateStep = 'form' | 'reveal';

/** POST /api-key returns the plaintext token once; list endpoints return `*****` + last 4. */
function isRevealedApiKeyToken(token: string): boolean {
  return token.length > 0 && !token.startsWith('*****');
}

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
  const [isLoading, setIsLoading] = useState(false);
  const [step, setStep] = useState<CreateStep>('form');
  const [createdKey, setCreatedKey] = useState<ApiKey | null>(null);
  const { apiClient, network } = useAppContext();
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
    },
  });

  const permissionPreset = useWatch({ control, name: 'permissionPreset', defaultValue: 'Read' });
  const canAdmin = useWatch({ control, name: 'canAdmin', defaultValue: false });
  const canPay = useWatch({ control, name: 'canPay', defaultValue: false });
  const usageLimited = useWatch({ control, name: 'usageLimited', defaultValue: true });
  const walletScopeEnabled = useWatch({ control, name: 'walletScopeEnabled', defaultValue: false });
  const walletScopeIds = useWatch({ control, name: 'walletScopeIds', defaultValue: [] });

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
    } else if (!flags.canPay) {
      // Read-only: always usage limited
      setValue('usageLimited', true);
      setValue('evmChains', []);
    }
  }, [permissionPreset, setValue]);

  const finishClose = () => {
    reset();
    setStep('form');
    setCreatedKey(null);
    onClose();
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (nextOpen) return;
    // Reveal step: only Done closes — backdrop/Escape must not dismiss before copy.
    if (step === 'reveal') return;
    finishClose();
  };

  const onSubmit = async (data: ApiKeyFormValues) => {
    setIsLoading(true);
    const isReadOnly = !data.canPay && !data.canAdmin;
    const defaultCredits = [
      {
        unit: 'lovelace',
        amount: '1000000000', // 1000 ADA
      },
    ];
    await handleApiCall(
      () =>
        postApiKey({
          client: apiClient,
          body: {
            // Send flag-based permissions
            canRead: data.canRead,
            canPay: data.canPay,
            canAdmin: data.canAdmin,
            usageLimited: isReadOnly ? 'true' : data.usageLimited.toString(),
            NetworkLimit: data.networks,
            ChainIdLimit: data.canPay && !data.canAdmin ? data.evmChains : [],
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
            walletScopeEnabled: data.walletScopeEnabled.toString(),
            WalletScopeHotWalletIds: data.walletScopeEnabled ? data.walletScopeIds : [],
          },
        }),
      {
        onSuccess: (response) => {
          const created = extractApiPayload<ApiKey>(response);
          onSuccess();
          toast.success('API key created successfully');
          if (created && isRevealedApiKeyToken(created.token)) {
            setCreatedKey(created);
            setStep('reveal');
            return;
          }
          finishClose();
        },
        onFinally: () => {
          setIsLoading(false);
        },
        errorMessage: 'Failed to create API key',
      },
    );
  };

  const handleClose = () => {
    handleDialogOpenChange(false);
  };

  const isReadOnly = !canPay && !canAdmin;
  const showReveal = step === 'reveal' && createdKey != null;

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent hideClose={showReveal}>
        {showReveal ? (
          <div className="space-y-5">
            <DialogHeader className="space-y-2 text-center sm:text-center">
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20">
                <KeyRound className="h-5 w-5 text-primary" />
              </div>
              <DialogTitle>Save your API key</DialogTitle>
              <DialogDescription>
                This is the only time the full key is shown. Store it securely. It cannot be
                recovered later.
              </DialogDescription>
            </DialogHeader>

            {createdKey.canAdmin && (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs leading-snug text-amber-800 dark:text-amber-200">
                Admin keys unlock this dashboard. Paste this key on the sign-in screen to access the
                admin interface.
              </p>
            )}

            <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2.5">
              <code className="flex-1 break-all font-mono text-xs leading-relaxed">
                {createdKey.token}
              </code>
              <CopyButton value={createdKey.token} className="h-8 w-8 shrink-0" />
            </div>

            <DialogFooter className="pt-1 sm:justify-end">
              <Button onClick={finishClose}>Done</Button>
            </DialogFooter>
          </div>
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

              {canPay && !canAdmin && evmChainOptions.length > 0 && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">EVM chains (x402)</label>
                  <p className="text-xs text-muted-foreground">
                    Grant this key access to settle and fetch x402 payments on these chains.
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
                  <div className="space-y-2">
                    <label htmlFor="apikey-ada-limit" className="text-sm font-medium">
                      ADA Limit
                    </label>
                    <Input
                      id="apikey-ada-limit"
                      type="number"
                      placeholder="0.00"
                      {...register('credits.lovelace')}
                    />
                    <p className="text-xs text-muted-foreground">
                      Amount in ADA (will be converted to lovelace)
                    </p>
                    {errors.credits && 'lovelace' in errors.credits && errors.credits.lovelace && (
                      <p className="text-xs text-destructive mt-1">
                        {(errors.credits.lovelace as any).message}
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <label htmlFor="apikey-usdcx-limit" className="text-sm font-medium">
                      {getActiveStablecoinSymbol(network)} Limit
                    </label>
                    <Input
                      id="apikey-usdcx-limit"
                      type="number"
                      placeholder="0.00"
                      {...register('credits.usdcx')}
                    />
                    {errors.credits && 'usdcx' in errors.credits && errors.credits.usdcx && (
                      <p className="text-xs text-destructive mt-1">
                        {(errors.credits.usdcx as any).message}
                      </p>
                    )}
                  </div>
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
                </>
              )}
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <Button variant="outline" onClick={handleClose}>
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
