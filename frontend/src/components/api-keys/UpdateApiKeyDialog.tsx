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
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useState, useRef } from 'react';
import { Eye, EyeOff, X } from 'lucide-react';
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
  const [showToken, setShowToken] = useState(false);
  const tokenInputRef = useRef<HTMLInputElement | null>(null);
  const { apiClient } = useAppContext();

  const {
    register,
    handleSubmit,
    control,
    reset,
    setValue,
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

  const tokenValue = useWatch({ control, name: 'newToken' });

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
    setShowToken(false);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update API key</DialogTitle>
          <DialogDescription>
            Modify the token, status, or usage credits for this key.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2.5 text-sm">
          <span className="text-muted-foreground">Permission:</span>
          <Badge
            variant={
              apiKey.permission === 'Admin'
                ? 'default'
                : apiKey.permission === 'ReadAndPay'
                  ? 'secondary'
                  : 'outline'
            }
          >
            {apiKey.permission}
          </Badge>
          <Separator orientation="vertical" className="mx-1 h-4" />
          <span className="text-muted-foreground">Networks:</span>
          <div className="flex gap-1">
            {apiKey.networkLimit.map((net) => (
              <Badge key={net} variant="outline" className="font-normal">
                {net}
              </Badge>
            ))}
          </div>
        </div>

        <Separator />

        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="newToken">
                Replace Token <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
            </div>
            <div className="relative">
              <Input
                id="newToken"
                type={showToken ? 'text' : 'password'}
                placeholder="Enter new token to replace current"
                className="pr-16"
                {...register('newToken')}
                ref={(e) => {
                  register('newToken').ref(e);
                  tokenInputRef.current = e;
                }}
              />
              <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center">
                {tokenValue && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => {
                      setValue('newToken', '');
                      if (tokenInputRef.current) tokenInputRef.current.value = '';
                    }}
                  >
                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setShowToken((v) => !v)}
                >
                  {showToken ? (
                    <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </Button>
              </div>
            </div>
            {errors.newToken ? (
              <p className="text-xs text-destructive">{errors.newToken.message}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Minimum 15 characters. Leave empty to keep the current token.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="status">Status</Label>
            <Controller
              control={control}
              name="status"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Active">Active</SelectItem>
                    <SelectItem value="Revoked">Revoked</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
            {errors.status && <p className="text-xs text-destructive">{errors.status.message}</p>}
          </div>

          <Separator />
          <div>
            <Label className="text-sm">
              {apiKey.usageLimited ? 'Adjust Usage Credits' : 'Add Usage Credits'}
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5 mb-3">
              {apiKey.usageLimited
                ? 'Enter a positive value to add credits, or negative to remove.'
                : 'This key is unlimited, but you can still add tracked credits.'}
            </p>
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
                <Label htmlFor="credits-usdm" className="text-xs text-muted-foreground">
                  USDM
                </Label>
                <Input
                  id="credits-usdm"
                  type="number"
                  placeholder="0.00"
                  {...register('credits.usdm')}
                />
                {errors.credits && 'usdm' in errors.credits && errors.credits.usdm && (
                  <p className="text-xs text-destructive">{(errors.credits.usdm as any).message}</p>
                )}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button disabled={isLoading} onClick={handleSubmit(onSubmit)}>
            {isLoading ? 'Updating...' : 'Update'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
