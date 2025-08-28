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
import { useState, useEffect, useCallback } from 'react';
import { Badge } from '../ui/badge';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postRegistry, getPaymentSource } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { shortenAddress, handleApiCall } from '@/lib/utils';
import { Trash2 } from 'lucide-react';
import { useForm, Controller, useFieldArray } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { getUsdmConfig } from '@/lib/constants/defaultWallets';
import { Separator } from '@/components/ui/separator';

interface RegisterAIAgentDialogProps {
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

const exampleOutputSchema = z.object({
  name: z
    .string()
    .max(60, 'Name must be less than 60 characters')
    .min(1, 'Name is required'),
  url: z.string().url('URL must be a valid URL').min(1, 'URL is required'),
  mimeType: z
    .string()
    .max(60, 'MIME type must be less than 60 characters')
    .min(1, 'MIME type is required'),
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
  description: z
    .string()
    .min(1, 'Description is required')
    .max(250, 'Description must be less than 250 characters'),
  selectedWallet: z.string().min(1, 'Wallet is required'),
  prices: z.array(priceSchema).min(1, 'At least one price is required'),
  tags: z.array(z.string().min(1)).min(1, 'At least one tag is required'),

  // Additional Fields
  authorName: z
    .string()
    .max(250, 'Author name must be less than 250 characters')
    .optional()
    .or(z.literal('')),
  authorEmail: z
    .string()
    .email('Author email must be a valid email')
    .max(250, 'Author email must be less than 250 characters')
    .optional()
    .or(z.literal('')),
  organization: z
    .string()
    .max(250, 'Organization must be less than 250 characters')
    .optional()
    .or(z.literal('')),
  contactOther: z
    .string()
    .max(250, 'Contact other must be less than 250 characters')
    .optional()
    .or(z.literal('')),

  termsOfUseUrl: z
    .string()
    .url('Terms of use URL must be a valid URL')
    .max(250, 'Terms of use URL must be less than 250 characters')
    .optional()
    .or(z.literal('')),
  privacyPolicyUrl: z
    .string()
    .url('Privacy policy URL must be a valid URL')
    .max(250, 'Privacy policy URL must be less than 250 characters')
    .optional()
    .or(z.literal('')),
  otherUrl: z
    .string()
    .url('Other URL must be a valid URL')
    .max(250, 'Other URL must be less than 250 characters')
    .optional()
    .or(z.literal('')),

  capabilityName: z
    .string()
    .max(250, 'Capability name must be less than 250 characters')
    .optional()
    .or(z.literal('')),
  capabilityVersion: z
    .string()
    .max(250, 'Capability version must be less than 250 characters')
    .optional()
    .or(z.literal('')),

  exampleOutputs: z.array(exampleOutputSchema).optional(),
});

type AgentFormValues = z.infer<typeof agentSchema>;

export function RegisterAIAgentDialog({
  open,
  onClose,
  onSuccess,
}: RegisterAIAgentDialogProps) {
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
      authorName: '',
      authorEmail: '',
      organization: '',
      contactOther: '',
      termsOfUseUrl: '',
      privacyPolicyUrl: '',
      otherUrl: '',
      capabilityName: '',
      capabilityVersion: '',
      exampleOutputs: [],
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

  const {
    fields: exampleOutputFields,
    append: appendExampleOutput,
    remove: removeExampleOutput,
  } = useFieldArray({
    control,
    name: 'exampleOutputs',
  });

  const tags = watch('tags');
  const [tagInput, setTagInput] = useState('');

  useEffect(() => {
    if (open) {
      fetchSellingWallets();
      reset();
    }
  }, [open, reset]);

  const fetchSellingWallets = async () => {
    await handleApiCall(() => getPaymentSource({ client: apiClient }), {
      onSuccess: (response) => {
        if (response.data?.data?.PaymentSources) {
          const paymentSources = response.data.data.PaymentSources.filter(
            (s: any) => s.network == state.network,
          );
          if (paymentSources.length > 0) {
            const aggregatedWallets: SellingWallet[] = [];
            paymentSources.forEach((ps: any) => {
              ps.SellingWallets.forEach((w: any) => {
                aggregatedWallets.push(w);
              });
            });
            setSellingWallets(aggregatedWallets);
          }
        }
      },
      errorMessage: 'Failed to load selling wallets',
    });
  };

  const onSubmit = useCallback(
    async (data: AgentFormValues) => {
      setIsLoading(true);
      const selectedWallet = data.selectedWallet;
      const paymentSource = state.paymentSources?.find((ps) =>
        ps.SellingWallets?.some((s) => s.walletVkey == selectedWallet),
      );
      if (!paymentSource) {
        toast.error('Smart contract wallet not found in payment sources');
        setIsLoading(false);
        return;
      }

      const legal: {
        privacyPolicy?: string;
        terms?: string;
        other?: string;
      } = {};
      if (data.privacyPolicyUrl) legal.privacyPolicy = data.privacyPolicyUrl;
      if (data.termsOfUseUrl) legal.terms = data.termsOfUseUrl;
      if (data.otherUrl) legal.other = data.otherUrl;

      const author: {
        name: string;
        contactEmail?: string;
        contactOther?: string;
        organization?: string;
      } = {
        name: data.authorName || 'Default Author', // Default in case it's empty
      };
      if (data.authorEmail) author.contactEmail = data.authorEmail;
      if (data.contactOther) author.contactOther = data.contactOther;
      if (data.organization) author.organization = data.organization;

      const capability =
        data.capabilityName && data.capabilityVersion
          ? {
              name: data.capabilityName,
              version: data.capabilityVersion,
            }
          : { name: 'Custom Agent', version: '1.0.0' };

      await handleApiCall(
        () =>
          postRegistry({
            client: apiClient,
            body: {
              network: state.network,
              sellingWalletVkey: data.selectedWallet,
              name: data.name,
              description: data.description,
              apiBaseUrl: data.apiUrl,
              Tags: data.tags,
              Capability: capability,
              AgentPricing: {
                pricingType: 'Fixed',
                Pricing: data.prices.map((price) => {
                  const unit =
                    price.unit === 'USDM'
                      ? getUsdmConfig(state.network).fullAssetId
                      : price.unit;
                  return {
                    unit,
                    amount: (parseFloat(price.amount) * 1_000_000).toString(),
                  };
                }),
              },
              Author: author,
              Legal: Object.keys(legal).length > 0 ? legal : undefined,
              ExampleOutputs:
                data.exampleOutputs?.map((e) => ({
                  name: e.name,
                  url: e.url,
                  mimeType: e.mimeType,
                })) || [],
            },
          }),
        {
          onSuccess: (response) => {
            if (!response.data?.data?.id) {
              toast.error(
                'Failed to register AI agent: Invalid response from server',
              );
              return;
            }
            toast.success('AI agent registered successfully');
            onSuccess();
            onClose();
            reset();
          },
          onFinally: () => {
            setIsLoading(false);
          },
          errorMessage: 'Failed to register AI agent',
        },
      );
    },
    [apiClient, state.network, state.paymentSources, onSuccess, onClose, reset],
  );

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
      <DialogContent className="sm:max-w-[700px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Register AI Agent</DialogTitle>
          <p className="text-sm text-muted-foreground mt-2">
            This registers your agent on the Masumi Network, making it visible
            to everyone.
          </p>
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
            <div className="relative">
              <Textarea
                {...register('description')}
                placeholder="Describe what your agent does"
                rows={3}
                className={errors.description ? 'border-red-500' : ''}
                maxLength={250}
              />
              <div className="absolute bottom-2 right-2 text-xs text-muted-foreground">
                {watch('description')?.length || 0}/250
              </div>
            </div>
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

          <div className="flex items-center gap-4 pt-2">
            <Separator className="flex-1" />
            <h3 className="text-sm font-medium text-muted-foreground whitespace-nowrap">
              Additional Fields
            </h3>
            <Separator className="flex-1" />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Author Name</label>
            <Input
              {...register('authorName')}
              placeholder="Enter the author's name"
              className={errors.authorName ? 'border-red-500' : ''}
            />
            {errors.authorName && (
              <p className="text-sm text-red-500">
                {errors.authorName.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Author Email</label>
            <Input
              {...register('authorEmail')}
              type="email"
              placeholder="Enter the author's email address"
              className={errors.authorEmail ? 'border-red-500' : ''}
            />
            {errors.authorEmail && (
              <p className="text-sm text-red-500">
                {errors.authorEmail.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Organization</label>
            <Input
              {...register('organization')}
              placeholder="Enter the organization name"
              className={errors.organization ? 'border-red-500' : ''}
            />
            {errors.organization && (
              <p className="text-sm text-red-500">
                {errors.organization.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Contact Other (Website, Phone...)
            </label>
            <Input
              {...register('contactOther')}
              placeholder="Enter other contact"
              className={errors.contactOther ? 'border-red-500' : ''}
            />
            {errors.contactOther && (
              <p className="text-sm text-red-500">
                {errors.contactOther.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Terms of Use URL</label>
            <Input
              {...register('termsOfUseUrl')}
              placeholder="Enter the terms of use URL"
              className={errors.termsOfUseUrl ? 'border-red-500' : ''}
            />
            {errors.termsOfUseUrl && (
              <p className="text-sm text-red-500">
                {errors.termsOfUseUrl.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Privacy Policy URL</label>
            <Input
              {...register('privacyPolicyUrl')}
              placeholder="Enter the privacy policy URL"
              className={errors.privacyPolicyUrl ? 'border-red-500' : ''}
            />
            {errors.privacyPolicyUrl && (
              <p className="text-sm text-red-500">
                {errors.privacyPolicyUrl.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Other URL (Support...)
            </label>
            <Input
              {...register('otherUrl')}
              placeholder="Enter the other URL"
              className={errors.otherUrl ? 'border-red-500' : ''}
            />
            {errors.otherUrl && (
              <p className="text-sm text-red-500">{errors.otherUrl.message}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Capability Name</label>
              <Input
                {...register('capabilityName')}
                placeholder="e.g., Text Generation"
                className={errors.capabilityName ? 'border-red-500' : ''}
              />
              {errors.capabilityName && (
                <p className="text-sm text-red-500">
                  {errors.capabilityName.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Capability Version</label>
              <Input
                {...register('capabilityVersion')}
                placeholder="e.g., 1.0.0"
                className={errors.capabilityVersion ? 'border-red-500' : ''}
              />
              {errors.capabilityVersion && (
                <p className="text-sm text-red-500">
                  {errors.capabilityVersion.message}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-4 border rounded-md p-4 bg-muted/40">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Example Outputs</label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  appendExampleOutput({ name: '', url: '', mimeType: '' })
                }
              >
                Add Example
              </Button>
            </div>
            {exampleOutputFields.map((field, index) => (
              <div
                key={field.id}
                className="p-4 border rounded-md space-y-2 relative"
              >
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Input
                    placeholder="Name"
                    {...register(`exampleOutputs.${index}.name` as const)}
                  />
                  <Input
                    placeholder="URL"
                    {...register(`exampleOutputs.${index}.url` as const)}
                  />
                  <Input
                    placeholder="MIME Type"
                    {...register(`exampleOutputs.${index}.mimeType` as const)}
                  />
                </div>
                {index >= 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeExampleOutput(index)}
                    className="absolute top-2 right-2"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-4">
            <Button variant="outline" onClick={onClose} type="button">
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? 'Registering...' : 'Register'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
