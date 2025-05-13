/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useState, useEffect } from 'react';
import { Badge } from '../ui/badge';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postRegistry, getPaymentSource } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { shortenAddress } from '@/lib/utils';
import { Trash2 } from 'lucide-react';
import { useForm, Controller, useFieldArray } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

interface AddAIAgentDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

interface SellingWallet {
  id: string;
  walletVkey: string;
  walletAddress: string;
  note: string | null;
}

const priceSchema = z.object({
  unit: z.enum(['lovelace', 'USDM'], { required_error: 'Token is required' }),
  amount: z.string().min(1, 'Amount is required'),
});

const agentSchema = z.object({
  apiUrl: z
    .string()
    .url('API URL must be a valid URL')
    .min(1, 'API URL is required')
    .refine((val) => val.startsWith('http://') || val.startsWith('https://'), {
      message: 'API URL must start with http:// or https://',
    }),
  name: z.string().min(1, 'Name is required'),
  description: z.string().min(1, 'Description is required'),
  selectedWallet: z.string().min(1, 'Wallet is required'),
  prices: z.array(priceSchema).min(1, 'At least one price is required'),
  tags: z.array(z.string().min(1)).min(1, 'At least one tag is required'),
});

type AgentFormValues = z.infer<typeof agentSchema>;

export function AddAIAgentDialog({
  open,
  onClose,
  onSuccess,
}: AddAIAgentDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [sellingWallets, setSellingWallets] = useState<SellingWallet[]>([]);
  const { apiClient, state } = useAppContext();

  const {
    register,
    handleSubmit,
    control,
    setValue,
    reset,
    formState: { errors },
    watch,
  } = useForm<AgentFormValues>({
    resolver: zodResolver(agentSchema),
    defaultValues: {
      apiUrl: '',
      name: '',
      description: '',
      selectedWallet: '',
      prices: [{ unit: 'lovelace', amount: '' }],
      tags: [],
    },
  });

  const {
    fields: priceFields,
    append: appendPrice,
    remove: removePrice,
  } = useFieldArray({
    control,
    name: 'prices',
  });

  const tags = watch('tags');
  const [tagInput, setTagInput] = useState('');

  useEffect(() => {
    if (open) {
      fetchSellingWallets();
      reset();
    }
  }, [open]);

  const fetchSellingWallets = async () => {
    try {
      const response = await getPaymentSource({
        client: apiClient,
      });

      if (response.data?.data?.PaymentSources) {
        const paymentSource = response.data.data.PaymentSources[0];
        if (paymentSource) {
          setSellingWallets(paymentSource.SellingWallets);
        }
      }
    } catch (error) {
      console.error('Error fetching selling wallets:', error);
      toast.error('Failed to load selling wallets');
    }
  };

  const onSubmit = async (data: AgentFormValues) => {
    try {
      setIsLoading(true);
      const response = await postRegistry({
        client: apiClient,
        body: {
          network: state.network,
          sellingWalletVkey: data.selectedWallet,
          name: data.name,
          description: data.description,
          apiBaseUrl: data.apiUrl,
          Tags: data.tags,
          Capability: {
            name: 'Custom Agent',
            version: '1.0.0',
          },
          AgentPricing: {
            pricingType: 'Fixed',
            Pricing: data.prices.map((price) => ({
              unit: price.unit,
              amount:
                price.unit === 'lovelace'
                  ? (parseFloat(price.amount) * 1000000).toString()
                  : price.amount,
            })),
          },
          Author: {
            name: 'Admin',
          },
          ExampleOutputs: [],
        },
      });

      if (!response.data?.data?.id) {
        throw new Error(
          'Failed to create AI agent: Invalid response from server',
        );
      }

      toast.success('AI agent created successfully');
      onSuccess();
      onClose();
      reset();
    } catch (error: any) {
      console.error('Error creating AI agent:', error);
      toast.error(error?.message ?? 'Failed to create AI agent');
    } finally {
      setIsLoading(false);
    }
  };

  // Tag management
  const handleAddTag = () => {
    const tag = tagInput.trim();
    if (tag && !tags.includes(tag)) {
      setValue('tags', [...tags, tag]);
    }
    setTagInput('');
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setValue(
      'tags',
      tags.filter((tag) => tag !== tagToRemove),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Add AI agent</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium">
              API URL <span className="text-red-500">*</span>
            </label>
            <Input
              {...register('apiUrl')}
              placeholder="Enter the API URL for your agent"
              className={errors.apiUrl ? 'border-red-500' : ''}
            />
            {errors.apiUrl && (
              <p className="text-sm text-red-500">{errors.apiUrl.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Name <span className="text-red-500">*</span>
            </label>
            <Input
              {...register('name')}
              placeholder="Enter a name for your agent"
              className={errors.name ? 'border-red-500' : ''}
            />
            {errors.name && (
              <p className="text-sm text-red-500">{errors.name.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Description <span className="text-red-500">*</span>
            </label>
            <Textarea
              {...register('description')}
              placeholder="Describe what your agent does"
              rows={3}
              className={errors.description ? 'border-red-500' : ''}
            />
            {errors.description && (
              <p className="text-sm text-red-500">
                {errors.description.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Linked wallet <span className="text-red-500">*</span>
            </label>
            <Controller
              control={control}
              name="selectedWallet"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger
                    className={errors.selectedWallet ? 'border-red-500' : ''}
                  >
                    <SelectValue placeholder="Select a wallet" />
                  </SelectTrigger>
                  <SelectContent>
                    {sellingWallets.map((wallet) => (
                      <SelectItem key={wallet.id} value={wallet.walletVkey}>
                        {wallet.note
                          ? `${wallet.note} (${shortenAddress(wallet.walletAddress)})`
                          : shortenAddress(wallet.walletAddress)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.selectedWallet && (
              <p className="text-sm text-red-500">
                {errors.selectedWallet.message}
              </p>
            )}
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                Prices <span className="text-red-500">*</span>
              </label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => appendPrice({ unit: 'lovelace', amount: '' })}
              >
                Add Price
              </Button>
            </div>
            {priceFields.map((field, index) => (
              <div key={field.id} className="flex gap-2 items-start">
                <div className="flex-1 space-y-2">
                  <Controller
                    control={control}
                    name={`prices.${index}.unit` as const}
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select token" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="lovelace">ADA</SelectItem>
                          <SelectItem value="USDM">USDM</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
                <div className="flex-1 space-y-2">
                  <Input
                    type="number"
                    placeholder="0.00"
                    {...register(`prices.${index}.amount` as const)}
                    min="0"
                    step="0.000001"
                  />
                  {errors.prices &&
                    Array.isArray(errors.prices) &&
                    errors.prices[index]?.amount && (
                      <p className="text-xs text-red-500">
                        {errors.prices[index]?.amount?.message}
                      </p>
                    )}
                </div>
                {index > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removePrice(index)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            {errors.prices && typeof errors.prices.message === 'string' && (
              <p className="text-sm text-red-500">{errors.prices.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Tags <span className="text-red-500">*</span>
            </label>
            <div>
              <div className="flex gap-2">
                <Input
                  placeholder="Add a tag"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddTag();
                    }
                  }}
                  className={errors.tags ? 'border-red-500' : ''}
                />
                <Button type="button" variant="outline" onClick={handleAddTag}>
                  Add
                </Button>
              </div>
              {errors.tags && (
                <p className="text-sm text-red-500">{errors.tags.message}</p>
              )}
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {tags.map((tag: string) => (
                    <Badge
                      key={tag}
                      variant="secondary"
                      className="cursor-pointer"
                      onClick={() => handleRemoveTag(tag)}
                    >
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-4">
            <Button variant="outline" onClick={onClose} type="button">
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? 'Creating...' : 'Create'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
