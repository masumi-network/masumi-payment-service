import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
import { postApiKey } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { handleApiCall } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Badge } from '@/components/ui/badge';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { shortenAddress } from '@/lib/utils';
import {
  getActiveStablecoinConfig,
  getActiveStablecoinSymbol,
} from '@/lib/constants/defaultWallets';

interface AddApiKeyDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

const apiKeySchema = z
  .object({
    permission: z.enum(['Read', 'ReadAndPay', 'Admin']),
    networks: z.array(z.enum(['Preprod', 'Mainnet'])).min(1, 'Select at least one network'),
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
      val.permission === 'ReadAndPay' &&
      val.usageLimited &&
      !val.credits.lovelace &&
      !val.credits.usdcx
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Please specify usage credits for Read and Pay permission',
        path: ['credits', 'lovelace'],
      });
    }
  });

type ApiKeyFormValues = z.infer<typeof apiKeySchema>;

export function AddApiKeyDialog({ open, onClose, onSuccess }: AddApiKeyDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
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
    setValue,
    reset,
    formState: { errors },
  } = useForm<ApiKeyFormValues>({
    resolver: zodResolver(apiKeySchema),
    defaultValues: {
      permission: 'Read',
      usageLimited: true,
      networks: ['Preprod', 'Mainnet'],
      credits: { lovelace: '', usdcx: '' },
      walletScopeEnabled: false,
      walletScopeIds: [],
    },
  });

  const permission = useWatch({ control, name: 'permission', defaultValue: 'Read' });
  const usageLimited = useWatch({ control, name: 'usageLimited', defaultValue: true });
  const walletScopeEnabled = useWatch({ control, name: 'walletScopeEnabled', defaultValue: false });
  const walletScopeIds = useWatch({ control, name: 'walletScopeIds', defaultValue: [] });

  useEffect(() => {
    if (permission === 'Admin') {
      setValue('usageLimited', false);
      setValue('networks', ['Preprod', 'Mainnet']);
      setValue('walletScopeEnabled', false);
      setValue('walletScopeIds', []);
    } else if (permission === 'Read') {
      setValue('usageLimited', true);
    }
  }, [permission, setValue]);

  const onSubmit = async (data: ApiKeyFormValues) => {
    const isReadOnly = data.permission === 'Read';
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
            permission: data.permission,
            usageLimited: isReadOnly ? 'true' : data.usageLimited.toString(),
            NetworkLimit: data.networks,
            UsageCredits: isReadOnly
              ? defaultCredits
              : data.usageLimited
                ? [
                    ...(data.credits.lovelace
                      ? [
                          {
                            unit: 'lovelace',
                            amount: (parseFloat(data.credits.lovelace) * 1000000).toString(),
                          },
                        ]
                      : []),
                    ...(data.credits.usdcx
                      ? [
                          {
                            unit: getActiveStablecoinConfig(network).fullAssetId,
                            amount: (parseFloat(data.credits.usdcx) * 1000000).toString(),
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
        onSuccess: () => {
          toast.success('API key created successfully');
          onSuccess();
          onClose();
        },
        onFinally: () => {
          setIsLoading(false);
        },
        errorMessage: 'Failed to create API key',
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
          <DialogTitle>Add API key</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Permission</label>
            <Controller
              control={control}
              name="permission"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Read">Read</SelectItem>
                    <SelectItem value="ReadAndPay">Read and Pay</SelectItem>
                    <SelectItem value="Admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
            {errors.permission && (
              <p className="text-xs text-destructive mt-1">{errors.permission.message}</p>
            )}
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
                      checked={field.value.includes('Preprod')}
                      disabled={permission === 'Admin'}
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
                      checked={field.value.includes('Mainnet')}
                      disabled={permission === 'Admin'}
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

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Controller
                control={control}
                name="usageLimited"
                render={({ field }) => (
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    disabled={permission === 'Read' || permission === 'Admin'}
                  />
                )}
              />
              <label className="text-sm font-medium">Limit Usage</label>
            </div>
          </div>

          {usageLimited && permission !== 'Read' && permission !== 'Admin' && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">ADA Limit</label>
                <Input type="number" placeholder="0.00" {...register('credits.lovelace')} />
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
                <label className="text-sm font-medium">
                  {getActiveStablecoinSymbol(network)} Limit
                </label>
                <Input type="number" placeholder="0.00" {...register('credits.usdcx')} />
                {errors.credits && 'usdcx' in errors.credits && errors.credits.usdcx && (
                  <p className="text-xs text-destructive mt-1">
                    {(errors.credits.usdcx as any).message}
                  </p>
                )}
              </div>
            </>
          )}

          {permission !== 'Admin' && (
            <>
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
            {isLoading ? 'Creating...' : 'Create'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
