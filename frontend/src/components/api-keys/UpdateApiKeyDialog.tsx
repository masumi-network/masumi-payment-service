import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useState } from 'react';
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
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

interface UpdateApiKeyDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  apiKey: {
    id: string;
    token: string;
    permission: 'Read' | 'ReadAndPay' | 'Admin';
    networkLimit: Array<'Preprod' | 'Mainnet'>;
    usageLimited: boolean;
    status: 'Active' | 'Revoked';
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
      usdm: z.string().optional(),
    }),
  })
  .superRefine((val, ctx) => {
    // At least one field must be changed
    const { newToken, status, credits } = val;
    const { apiKey } = (ctx as any)?.context?.apiKeyContext || {};
    const changed =
      (newToken && newToken.length >= 15) ||
      (status && apiKey && status !== apiKey.status) ||
      (credits && (credits.lovelace || credits.usdm));
    if (!changed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Please make at least one change to update',
        path: [],
      });
    }
    if (credits?.lovelace && isNaN(parseFloat(credits.lovelace))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid ADA amount',
        path: ['credits', 'lovelace'],
      });
    }
    if (credits?.usdm && isNaN(parseFloat(credits.usdm))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid USDM amount',
        path: ['credits', 'usdm'],
      });
    }
  });

type UpdateApiKeyFormValues = z.infer<typeof updateApiKeySchema>;

export function UpdateApiKeyDialog({ open, onClose, onSuccess, apiKey }: UpdateApiKeyDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const { apiClient } = useAppContext();

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors },
  } = useForm<UpdateApiKeyFormValues, { apiKeyContext: { apiKey: typeof apiKey } }>({
    resolver: zodResolver(updateApiKeySchema),
    defaultValues: {
      newToken: '',
      status: apiKey.status,
      credits: { lovelace: '', usdm: '' },
    },
    context: { apiKeyContext: { apiKey } },
  });

  const onSubmit = async (data: UpdateApiKeyFormValues) => {
    const usageCredits: Array<{ unit: string; amount: string }> = [];
    if (data.credits.lovelace) {
      usageCredits.push({
        unit: 'lovelace',
        amount: (parseFloat(data.credits.lovelace) * 1000000).toString(),
      });
    }
    if (data.credits.usdm) {
      usageCredits.push({
        unit: 'usdm',
        amount: data.credits.usdm,
      });
    }
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

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">New Token (Optional)</label>
            <Input
              type="text"
              placeholder="Leave empty to keep current token"
              {...register('newToken')}
            />
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

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Add/Remove ADA Credits</label>
              <Input
                type="number"
                placeholder="Enter amount (positive to add, negative to remove)"
                {...register('credits.lovelace')}
              />
              {errors.credits && 'lovelace' in errors.credits && errors.credits.lovelace && (
                <p className="text-xs text-destructive mt-1">
                  {(errors.credits.lovelace as any).message}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Amount in ADA (will be converted to lovelace)
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Add/Remove USDM Credits</label>
              <Input
                type="number"
                placeholder="Enter amount (positive to add, negative to remove)"
                {...register('credits.usdm')}
              />
              {errors.credits && 'usdm' in errors.credits && errors.credits.usdm && (
                <p className="text-xs text-destructive mt-1">
                  {(errors.credits.usdm as any).message}
                </p>
              )}
            </div>
          </div>
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
