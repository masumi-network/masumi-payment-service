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
import { useState, useEffect } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postApiKey } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { handleApiCall } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

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
      usdm: z.string().optional(),
    }),
  })
  .superRefine((val, ctx) => {
    if (
      val.permission === 'ReadAndPay' &&
      val.usageLimited &&
      !val.credits.lovelace &&
      !val.credits.usdm
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
  const { apiClient } = useAppContext();

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
      credits: { lovelace: '', usdm: '' },
    },
  });

  const permission = useWatch({ control, name: 'permission', defaultValue: 'Read' });
  const usageLimited = useWatch({ control, name: 'usageLimited', defaultValue: true });

  useEffect(() => {
    if (permission === 'Admin') {
      setValue('usageLimited', false);
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
            networkLimit: data.networks,
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
                    ...(data.credits.usdm
                      ? [
                          {
                            unit: 'usdm',
                            amount: data.credits.usdm,
                          },
                        ]
                      : []),
                  ]
                : [],
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
                    disabled={permission === 'Read'}
                  />
                )}
              />
              <label className="text-sm font-medium">Limit Usage</label>
            </div>
          </div>

          {usageLimited && permission !== 'Read' && (
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
                <label className="text-sm font-medium">USDM Limit</label>
                <Input type="number" placeholder="0.00" {...register('credits.usdm')} />
                {errors.credits && 'usdm' in errors.credits && errors.credits.usdm && (
                  <p className="text-xs text-destructive mt-1">
                    {(errors.credits.usdm as any).message}
                  </p>
                )}
              </div>
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
