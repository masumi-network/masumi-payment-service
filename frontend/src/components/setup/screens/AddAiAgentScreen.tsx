import { useState } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'react-toastify';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ArrowRight,
  Trash2,
  Wallet,
  Key,
  Bot,
  AlertTriangle,
  ChevronDown,
  Info,
} from 'lucide-react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { cn } from '@/lib/utils';
import {
  getPaymentSourceExtended,
  getWalletList,
  postRegistry,
  type PaymentSourceExtended,
} from '@/lib/api/generated';
import { WalletLink } from '@/components/ui/wallet-link';
import {
  getActiveStablecoinConfig,
  getActiveStablecoinSymbol,
} from '@/lib/constants/defaultWallets';
import { extractApiErrorMessage } from '@/lib/api-error';
import { REGISTRY_LIMITS } from '@/lib/registry-validation';
import { convertDecimalToBaseUnits } from '@/lib/convertDecimalToBaseUnits';
import { buildAgentSchema, type AgentFormValues } from './add-ai-agent-schema';
import type { SetupWallet } from '@/components/setup/setup-helpers';

export function AddAiAgentScreen({
  onNext,
  sellingWallet,
  ignoreSetup,
  onAgentCreated,
}: {
  onNext: () => void;
  sellingWallet: SetupWallet | null;
  ignoreSetup: () => void;
  onAgentCreated?: () => void;
}) {
  const { apiClient, network } = useAppContext();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>('');

  const stablecoinUnit = getActiveStablecoinSymbol(network);
  const agentSchema = buildAgentSchema(stablecoinUnit);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors },
    watch,
  } = useForm<AgentFormValues>({
    resolver: zodResolver(agentSchema),
    defaultValues: {
      apiUrl: '',
      name: '',
      description: '',
      prices: [{ unit: 'lovelace', amount: '' }],
      tags: [],
      pricingType: 'Fixed',
      authorName: '',
      authorEmail: '',
      organization: '',
      contactOther: '',
      termsOfUseUrl: '',
      privacyPolicyUrl: '',
      otherUrl: '',
      capabilityName: '',
      capabilityVersion: '',
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

  const onSubmit = async (data: AgentFormValues) => {
    if (!sellingWallet) {
      setError('No selling wallet available');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      // Fetch payment sources to get the latest data
      const response = await getPaymentSourceExtended({
        client: apiClient,
        query: {
          take: 10,
        },
      });

      if (response.error) {
        setError(extractApiErrorMessage(response.error, 'Failed to fetch payment sources'));
        return;
      }

      const paymentSources = response.data?.data?.ExtendedPaymentSources ?? [];
      const filteredSources = paymentSources.filter(
        (source: PaymentSourceExtended) => source.network == network,
      );

      if (filteredSources.length === 0) {
        setError('No payment sources found for this network');
        return;
      }

      // Hot wallets are no longer embedded in the payment-source response; they
      // are served by the dedicated /wallet/list endpoint. Resolve the chosen
      // selling wallet's vKey via an exact address filter (not a capped scan, so
      // a wallet beyond the first page is still found), scoped to this network.
      const inNetworkSourceIds = new Set(filteredSources.map((source) => source.id));
      const walletsResponse = await getWalletList({
        client: apiClient,
        query: {
          walletType: 'Selling',
          walletAddress: sellingWallet.address,
        },
      });

      if (walletsResponse.error) {
        setError(extractApiErrorMessage(walletsResponse.error, 'Failed to fetch wallets'));
        return;
      }

      const sellingWalletData = (walletsResponse.data?.data?.Wallets ?? []).find((wallet) =>
        inNetworkSourceIds.has(wallet.paymentSourceId),
      );

      if (!sellingWalletData?.walletVkey) {
        setError('Selling wallet vKey not found');
        return;
      }

      const registryResponse = await postRegistry({
        client: apiClient,
        body: {
          network: network,
          sellingWalletVkey: sellingWalletData.walletVkey,
          name: data.name,
          description: data.description,
          apiBaseUrl: data.apiUrl,
          Tags: data.tags,
          Capability:
            data.capabilityName && data.capabilityVersion
              ? { name: data.capabilityName, version: data.capabilityVersion }
              : { name: 'Custom Agent', version: '1.0.0' },
          AgentPricing: (() => {
            if (data.pricingType === 'Free') {
              return { pricingType: 'Free' as const };
            }
            if (data.pricingType === 'Dynamic') {
              return { pricingType: 'Dynamic' as const };
            }
            return {
              pricingType: 'Fixed' as const,
              Pricing: data.prices.map((price) => ({
                unit:
                  price.unit === 'lovelace'
                    ? 'lovelace'
                    : getActiveStablecoinConfig(network).fullAssetId,
                amount: convertDecimalToBaseUnits(price.amount),
              })),
            };
          })(),
          Author: {
            name: data.authorName || 'Setup User',
            contactEmail: data.authorEmail || '',
            organization: data.organization || '',
            contactOther: data.contactOther || '',
          },
          Legal: {
            terms: data.termsOfUseUrl || undefined,
            privacyPolicy: data.privacyPolicyUrl || undefined,
            other: data.otherUrl || undefined,
          },
          ExampleOutputs: [],
        },
      });

      if (registryResponse.error) {
        setError(extractApiErrorMessage(registryResponse.error, 'Failed to register AI agent'));
        return;
      }

      toast.success('AI agent registered successfully!');
      onAgentCreated?.();
      onNext();
    } catch (err) {
      setError(extractApiErrorMessage(err, 'An unexpected error occurred'));
      console.error('Error registering AI agent:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddTag = () => {
    const tag = tagInput.trim();
    if (tags.length >= REGISTRY_LIMITS.tagCount) {
      return;
    }

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

  const [additionalFieldsOpen, setAdditionalFieldsOpen] = useState(false);

  return (
    <div className="space-y-6 w-full max-w-2xl">
      <div className="text-center space-y-3 animate-fade-in-up">
        <div className="inline-flex items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-primary/5 p-3 ring-1 ring-primary/20">
          <Bot className="h-6 w-6 text-primary" />
        </div>
        <h1 className="text-2xl font-bold">Register your AI agent</h1>
        <Badge variant="outline" className="mx-auto text-xs">
          Optional
        </Badge>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          This step is optional. Add your first agent to the registry so users can discover and pay
          for it, or skip this and register agents later from the AI Agents page.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {error && (
          <div className="flex items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive animate-fade-in-up">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        <Card
          className="border-2 opacity-0 animate-slide-in-bottom animate-delay-75"
          style={{ animationFillMode: 'forwards' }}
        >
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Bot className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-base">Agent details</CardTitle>
                <CardDescription className="mt-0.5">
                  Required information for the registry listing
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="apiUrl" className="text-sm">
                API URL <span className="text-destructive">*</span>
              </Label>
              <Input
                id="apiUrl"
                {...register('apiUrl')}
                placeholder="https://your-agent-api.com"
                className={errors.apiUrl ? 'border-destructive' : ''}
              />
              {errors.apiUrl && <p className="text-xs text-destructive">{errors.apiUrl.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="agentName" className="text-sm">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="agentName"
                {...register('name')}
                placeholder="Enter a name for your agent"
                className={errors.name ? 'border-destructive' : ''}
              />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="description" className="text-sm">
                Description <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="description"
                {...register('description')}
                placeholder="Describe what your agent does and its key capabilities..."
                className={cn(
                  'min-h-[100px] resize-none',
                  errors.description && 'border-destructive',
                )}
              />
              <p className="text-xs text-muted-foreground">Max 250 characters</p>
              {errors.description && (
                <p className="text-xs text-destructive">{errors.description.message}</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card
          className="border-2 border-orange-500/20 bg-gradient-to-b from-orange-500/[0.02] to-transparent opacity-0 animate-slide-in-bottom animate-delay-100"
          style={{ animationFillMode: 'forwards' }}
        >
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-500/10">
                <Wallet className="h-5 w-5 text-orange-600" />
              </div>
              <div>
                <CardTitle className="text-base">Minting wallet</CardTitle>
                <CardDescription className="mt-0.5">
                  This selling wallet signs the mint transaction and pays the fees
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between rounded-lg border-2 border-orange-500/20 bg-orange-500/5 px-4 py-3 transition-all hover:bg-orange-500/10">
              <div className="flex items-center gap-3 min-w-0">
                <Badge className="shrink-0 bg-orange-600 hover:bg-orange-600 gap-1">
                  <Wallet className="h-3 w-3" /> Minting
                </Badge>
                {sellingWallet?.address ? (
                  <WalletLink address={sellingWallet.address} network={network} shorten={10} />
                ) : (
                  <span className="text-sm text-muted-foreground">No wallet</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card
          className="border-2 opacity-0 animate-slide-in-bottom animate-delay-125"
          style={{ animationFillMode: 'forwards' }}
        >
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Key className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-base">Pricing & tags</CardTitle>
                <CardDescription className="mt-0.5">
                  Set your pricing and add discovery tags
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-3">
              <Label className="text-sm">
                Pricing Type <span className="text-destructive">*</span>
              </Label>
              <Select
                value={watch('pricingType')}
                onValueChange={(val) => {
                  setValue('pricingType', val as 'Fixed' | 'Free' | 'Dynamic');
                  if (val !== 'Fixed') {
                    setValue('prices', [{ unit: 'lovelace', amount: '0.00' }]);
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select pricing type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Fixed">Fixed - Price per Agent</SelectItem>
                  <SelectItem value="Dynamic">Dynamic - Price set per payment</SelectItem>
                  <SelectItem value="Free">Free - No cost for interactions</SelectItem>
                </SelectContent>
              </Select>
              {watch('pricingType') === 'Dynamic' && (
                <p className="text-xs text-muted-foreground">
                  The price will be determined per payment/purchase request by the agent.
                </p>
              )}
            </div>
            <div className="space-y-3">
              <Label className="text-sm">
                Pricing <span className="text-destructive">*</span>
              </Label>
              <div className="space-y-3">
                {priceFields.map((field, index) => (
                  <div key={field.id} className="flex gap-2 items-center">
                    <Input
                      {...register(`prices.${index}.amount`)}
                      placeholder="0.00"
                      type="number"
                      step="0.01"
                      min={0}
                      disabled={watch('pricingType') !== 'Fixed'}
                      className={cn(
                        'flex-1',
                        errors.prices?.[index]?.amount && 'border-destructive',
                      )}
                    />
                    <Select
                      value={watch(`prices.${index}.unit`)}
                      disabled={watch('pricingType') !== 'Fixed'}
                      onValueChange={(value) =>
                        setValue(`prices.${index}.unit`, value as 'lovelace' | 'USDCx' | 'tUSDM')
                      }
                    >
                      <SelectTrigger className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="lovelace">ADA</SelectItem>
                        <SelectItem value={stablecoinUnit}>{stablecoinUnit}</SelectItem>
                      </SelectContent>
                    </Select>
                    {priceFields.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 text-muted-foreground hover:text-destructive"
                        onClick={() => removePrice(index)}
                        aria-label="Remove price"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={
                    watch('pricingType') !== 'Fixed' ||
                    priceFields.length >= REGISTRY_LIMITS.pricingOptionCount
                  }
                  onClick={() => appendPrice({ unit: 'lovelace', amount: '' })}
                >
                  <span className="text-lg leading-none">+</span> Add price option
                </Button>
              </div>
              {errors.prices && <p className="text-xs text-destructive">{errors.prices.message}</p>}
            </div>

            <Separator />

            <div className="space-y-3">
              <Label className="text-sm">
                Tags <span className="text-destructive">*</span>
              </Label>
              <div className="flex gap-2">
                <Input
                  placeholder="Type a tag and press Enter"
                  value={tagInput}
                  maxLength={REGISTRY_LIMITS.tag}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddTag();
                    }
                  }}
                  className={errors.tags ? 'border-destructive' : ''}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={tags.length >= REGISTRY_LIMITS.tagCount}
                  onClick={handleAddTag}
                >
                  Add
                </Button>
              </div>
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {tags.map((tag: string) => (
                    <Badge
                      key={tag}
                      variant="secondary"
                      className="cursor-pointer gap-1.5 pr-1.5 hover:bg-destructive/10 hover:text-destructive transition-colors"
                      onClick={() => handleRemoveTag(tag)}
                    >
                      {tag}
                      <span className="rounded-full bg-muted p-0.5">
                        <Trash2 className="h-2.5 w-2.5" />
                      </span>
                    </Badge>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Add tags like &quot;AI&quot;, &quot;Text&quot;, &quot;Image&quot; to help users find
                your agent
              </p>
              {errors.tags && <p className="text-xs text-destructive">{errors.tags.message}</p>}
            </div>
          </CardContent>
        </Card>

        <Collapsible open={additionalFieldsOpen} onOpenChange={setAdditionalFieldsOpen}>
          <Card
            className="border-2 border-dashed opacity-0 animate-slide-in-bottom animate-delay-150"
            style={{ animationFillMode: 'forwards' }}
          >
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-between px-6 py-4 text-left hover:bg-muted/30 transition-all group"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
                    <Info className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <span className="text-sm font-medium">Additional information</span>
                    <p className="text-xs text-muted-foreground">
                      Optional author, legal, and capability details
                    </p>
                  </div>
                </div>
                <div
                  className={cn(
                    'transition-transform duration-200',
                    additionalFieldsOpen && 'rotate-180',
                  )}
                >
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                </div>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="border-t px-6 pb-6 pt-4 space-y-5">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
                    Author information
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="authorName" className="text-sm">
                        Author name
                      </Label>
                      <Input
                        id="authorName"
                        {...register('authorName')}
                        placeholder="Your name"
                        className={errors.authorName ? 'border-destructive' : ''}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="authorEmail" className="text-sm">
                        Author email
                      </Label>
                      <Input
                        id="authorEmail"
                        {...register('authorEmail')}
                        type="email"
                        placeholder="you@example.com"
                        className={errors.authorEmail ? 'border-destructive' : ''}
                      />
                    </div>
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="organization" className="text-sm">
                      Organization
                    </Label>
                    <Input
                      id="organization"
                      {...register('organization')}
                      placeholder="Company name"
                      className={errors.organization ? 'border-destructive' : ''}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="contactOther" className="text-sm">
                      Other contact
                    </Label>
                    <Input
                      id="contactOther"
                      {...register('contactOther')}
                      placeholder="Website, phone, etc."
                      className={errors.contactOther ? 'border-destructive' : ''}
                    />
                  </div>
                </div>

                <Separator />

                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
                    Legal & documentation
                  </p>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="termsOfUseUrl" className="text-sm">
                        Terms of use URL
                      </Label>
                      <Input
                        id="termsOfUseUrl"
                        {...register('termsOfUseUrl')}
                        placeholder="https://..."
                        className={errors.termsOfUseUrl ? 'border-destructive' : ''}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="privacyPolicyUrl" className="text-sm">
                        Privacy policy URL
                      </Label>
                      <Input
                        id="privacyPolicyUrl"
                        {...register('privacyPolicyUrl')}
                        placeholder="https://..."
                        className={errors.privacyPolicyUrl ? 'border-destructive' : ''}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="otherUrl" className="text-sm">
                        Support URL
                      </Label>
                      <Input
                        id="otherUrl"
                        {...register('otherUrl')}
                        placeholder="https://..."
                        className={errors.otherUrl ? 'border-destructive' : ''}
                      />
                    </div>
                  </div>
                </div>

                <Separator />

                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
                    Capability details
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="capabilityName" className="text-sm">
                        Capability name
                      </Label>
                      <Input
                        id="capabilityName"
                        {...register('capabilityName')}
                        placeholder="e.g. Text Generation"
                        className={errors.capabilityName ? 'border-destructive' : ''}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="capabilityVersion" className="text-sm">
                        Version
                      </Label>
                      <Input
                        id="capabilityVersion"
                        {...register('capabilityVersion')}
                        placeholder="e.g. 1.0.0"
                        className={errors.capabilityVersion ? 'border-destructive' : ''}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </CollapsibleContent>
          </Card>
        </Collapsible>

        <Card
          className="border-2 opacity-0 animate-slide-in-bottom animate-delay-175"
          style={{ animationFillMode: 'forwards' }}
        >
          <CardContent className="py-6">
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button
                type="button"
                variant="ghost"
                onClick={ignoreSetup}
                className="transition-all hover:bg-muted"
              >
                Skip for now
              </Button>
              <Button
                type="submit"
                disabled={isLoading}
                className="gap-2 min-w-[140px] btn-hover-lift group"
                size="lg"
              >
                {isLoading ? (
                  <>
                    <Spinner size={16} /> Registering...
                  </>
                ) : (
                  <>
                    Register agent{' '}
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
