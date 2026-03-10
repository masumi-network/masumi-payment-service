import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useState, useRef, useMemo } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { patchApiKey } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PatchApiKeyResponse } from '@/lib/api/generated/types.gen';
import { handleApiCall } from '@/lib/utils';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Checkbox } from '@/components/ui/checkbox';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { shortenAddress } from '@/lib/utils';
import {
  getActiveStablecoinConfig,
  getActiveStablecoinSymbol,
} from '@/lib/constants/defaultWallets';

interface UpdateApiKeyDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  apiKey: {
    id: string;
    token: string;
    // Flag-based permissions
    canRead: boolean;
    canPay: boolean;
    canAdmin: boolean;
    // Legacy permission (for display)
    permission: 'Read' | 'ReadAndPay' | 'Admin';
    NetworkLimit: Array<'Preprod' | 'Mainnet'>;
    usageLimited: boolean;
    status: 'Active' | 'Revoked';
    walletScopeEnabled: boolean;
    WalletScopes: Array<{ hotWalletId: string }>;
  };
}

const updateApiKeySchema = z
  .object({
    newToken: z
      .string()
      .min(15, 'Token must be at least 15 characters')
      .optional()
      .or(z.literal('')),
    status: z.enum(['Active', 'Revoked']),
    credits: z.object({
      lovelace: z.string().optional(),
      usdcx: z.string().optional(),
    }),
    walletScopeEnabled: z.boolean(),
    walletScopeIds: z.array(z.string()),
  })
  .superRefine((val, ctx) => {
    if (val.credits?.lovelace && isNaN(parseFloat(val.credits.lovelace))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid ADA amount',
        path: ['credits', 'lovelace'],
      });
    }
    if (val.credits?.usdcx && isNaN(parseFloat(val.credits.usdcx))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid USDCx amount',
        path: ['credits', 'usdcx'],
      });
    }
  });

type UpdateApiKeyFormValues = z.infer<typeof updateApiKeySchema>;

/**
 * Get a human-readable permission label from flags.
 */
function getPermissionLabel(canRead: boolean, canPay: boolean, canAdmin: boolean): string {
  if (canAdmin) return 'Admin';
  if (canPay) return 'Read and Pay';
  return 'Read Only';
}

export function UpdateApiKeyDialog({ open, onClose, onSuccess, apiKey }: UpdateApiKeyDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const tokenInputRef = useRef<HTMLInputElement | null>(null);
  const { apiClient, network } = useAppContext();
  const { paymentSources } = usePaymentSourceExtendedAll();

  const allWallets = useMemo(() => {
    const wallets: Array<{
      id: string;
      type: 'Purchasing' | 'Selling';
      network: string;
      walletAddress: string;
      note: string | null;
    }> = [];
    for (const ps of paymentSources) {
      for (const w of ps.PurchasingWallets ?? []) {
        wallets.push({
          id: w.id,
          type: 'Purchasing',
          network: ps.network,
          walletAddress: w.walletAddress,
          note: w.note,
        });
      }
      for (const w of ps.SellingWallets ?? []) {
        wallets.push({
          id: w.id,
          type: 'Selling',
          network: ps.network,
          walletAddress: w.walletAddress,
          note: w.note,
        });
      }
    }
    return wallets;
  }, [paymentSources]);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setValue,
    formState: { errors },
  } = useForm<UpdateApiKeyFormValues>({
    resolver: zodResolver(updateApiKeySchema),
    defaultValues: {
      newToken: '',
      status: apiKey.status,
      credits: { lovelace: '', usdcx: '' },
      walletScopeEnabled: apiKey.walletScopeEnabled,
      walletScopeIds: apiKey.WalletScopes.map((ws) => ws.hotWalletId),
    },
  });

  const walletScopeEnabled = useWatch({
    control,
    name: 'walletScopeEnabled',
    defaultValue: apiKey.walletScopeEnabled,
  });
  const walletScopeIds = useWatch({
    control,
    name: 'walletScopeIds',
    defaultValue: apiKey.WalletScopes.map((ws) => ws.hotWalletId),
  });

  const onSubmit = async (data: UpdateApiKeyFormValues) => {
    const usageCredits: Array<{ unit: string; amount: string }> = [];
    if (data.credits.lovelace) {
      usageCredits.push({
        unit: 'lovelace',
        amount: (parseFloat(data.credits.lovelace) * 1000000).toString(),
      });
    }
    if (data.credits.usdcx) {
      usageCredits.push({
        unit: getActiveStablecoinConfig(network).fullAssetId,
        amount: (parseFloat(data.credits.usdcx) * 1000000).toString(),
      });
    }

    const walletScopeChanged =
      data.walletScopeEnabled !== apiKey.walletScopeEnabled ||
      JSON.stringify([...data.walletScopeIds].sort()) !==
        JSON.stringify([...apiKey.WalletScopes.map((ws) => ws.hotWalletId)].sort());

    await handleApiCall(
      () =>
        patchApiKey({
          client: apiClient,
          body: {
            id: apiKey.id,
            ...(data.newToken && { token: data.newToken }),
            ...(data.status !== apiKey.status && { status: data.status }),
            ...(usageCredits.length > 0 && {
              UsageCreditsToAddOrRemove: usageCredits,
            }),
            ...(walletScopeChanged && {
              walletScopeEnabled: data.walletScopeEnabled,
              WalletScopeHotWalletIds: data.walletScopeEnabled ? data.walletScopeIds : [],
            }),
          },
        }),
      {
        onSuccess: (response) => {
          const responseData = response?.data as PatchApiKeyResponse;
          if (!responseData?.data?.id) {
            toast.error('Failed to update API key: Invalid response from server');
            return;
          }
          toast.success('API key updated successfully');
          onSuccess();
          handleClose();
        },
        onFinally: () => {
          setIsLoading(false);
        },
        errorMessage: 'Failed to update API key',
      },
    );
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update API key</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2.5 text-sm">
          <span className="text-muted-foreground">Permission:</span>
          <Badge variant={apiKey.canAdmin ? 'default' : apiKey.canPay ? 'secondary' : 'outline'}>
            {getPermissionLabel(apiKey.canRead, apiKey.canPay, apiKey.canAdmin)}
          </Badge>
          <Separator orientation="vertical" className="mx-1 h-4" />
          <span className="text-muted-foreground">Networks:</span>
          <div className="flex gap-1">
            {apiKey.NetworkLimit.map((net) => (
              <Badge key={net} variant="outline" className="font-normal">
                {net}
              </Badge>
            ))}
          </div>
        </div>

        <Separator />

        <div className="space-y-4">
          {/* Display current permission level */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Permission Level</label>
            <div className="p-2 bg-muted rounded-md text-sm">
              {getPermissionLabel(apiKey.canRead, apiKey.canPay, apiKey.canAdmin)}
            </div>
            <p className="text-xs text-muted-foreground">
              Permission level cannot be changed after creation
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">New Token (Optional)</label>
            <div className="relative">
              <Input
                type={showToken ? 'text' : 'password'}
                placeholder="Leave empty to keep current token"
                {...register('newToken')}
                ref={(el) => {
                  tokenInputRef.current = el;
                  const { ref } = register('newToken');
                  if (typeof ref === 'function') ref(el);
                }}
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowToken((v) => !v)}
                tabIndex={-1}
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {errors.newToken && (
              <p className="text-xs text-destructive mt-1">{errors.newToken.message}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Must be at least 15 characters if provided
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Status</label>
            <Controller
              control={control}
              name="status"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Active">Active</SelectItem>
                    <SelectItem value="Revoked">Revoked</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
            {errors.status && (
              <p className="text-xs text-destructive mt-1">{errors.status.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Add/Remove Credits</label>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="credits-ada" className="text-xs text-muted-foreground">
                  ADA
                </Label>
                <Input
                  id="credits-ada"
                  type="number"
                  placeholder="0.00"
                  {...register('credits.lovelace')}
                />
                {errors.credits && 'lovelace' in errors.credits && errors.credits.lovelace && (
                  <p className="text-xs text-destructive">
                    {(errors.credits.lovelace as any).message}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="credits-usdcx" className="text-xs text-muted-foreground">
                  {getActiveStablecoinSymbol(network)}
                </Label>
                <Input
                  id="credits-usdcx"
                  type="number"
                  placeholder="0.00"
                  {...register('credits.usdcx')}
                />
                {errors.credits && 'usdcx' in errors.credits && errors.credits.usdcx && (
                  <p className="text-xs text-destructive">
                    {(errors.credits.usdcx as any).message}
                  </p>
                )}
              </div>
            </div>
          </div>

          {!apiKey.canAdmin && (
            <>
              <Separator />
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Controller
                    control={control}
                    name="walletScopeEnabled"
                    render={({ field }) => (
                      <Checkbox
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
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
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
            {isLoading ? 'Updating...' : 'Update'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
