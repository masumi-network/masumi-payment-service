import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Badge } from '../ui/badge';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postRegistry, postRegistryUpdate, RegistryEntry } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { shortenAddress, formatFundUnit } from '@/lib/utils';
import { Trash2, ChevronDown, Plus } from 'lucide-react';
import { useForm, Controller, useFieldArray } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { getActiveStablecoinConfig } from '@/lib/constants/defaultWallets';
import { Separator } from '@/components/ui/separator';
import { useWallets } from '@/lib/queries/useWallets';
import type { WalletListItem } from '@/lib/api/generated';
import { REGISTRY_DECIMAL_ADA_AMOUNT_PATTERN, REGISTRY_LIMITS } from '@/lib/registry-validation';
import {
  convertBaseUnitsToDecimal,
  convertDecimalToBaseUnits,
  isValidDecimalAmount,
} from '@/lib/convertDecimalToBaseUnits';
import { extractApiErrorMessage } from '@/lib/api-error';
import { isV2PaymentSource } from '@/lib/payment-source-type';
import { useAvailableX402Networks, useX402Wallets } from '@/lib/hooks/useX402';
import { X402OptionFields } from './X402OptionsSection';
import {
  defaultX402Option,
  findX402ValidationError,
  normalizeX402Amount,
  newX402OptionId,
  x402AmountFromBaseUnits,
  type X402OptionDraft,
} from '@/lib/x402-registration';
import {
  VerificationsSection,
  validateVerifications,
  verificationsFromApi,
  verificationsToApi,
  type VerificationDraft,
} from './VerificationsSection';
import { getPrimaryCardanoPricing } from '@/lib/registry-pricing';

interface RegisterAIAgentDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  /**
   * When set, the dialog operates in update mode for the given agent: the
   * form pre-fills with the agent's current metadata, the selling wallet
   * picker is hidden (the asset's current managed holder signs the update),
   * and submission calls the V2 update endpoint. Leave undefined for the
   * default register flow.
   */
  editingAgent?: RegistryEntry | null;
  /**
   * Smart contract address of the payment source `editingAgent` belongs to.
   * Threaded through to the update call so the V2 lookup hits the right
   * source (the backend default fallback resolves to V1). Required when
   * `editingAgent` is provided.
   */
  editingAgentSmartContractAddress?: string;
  /**
   * When set (and `editingAgent` is not), the dialog operates in re-register
   * mode: it pre-fills from the given agent exactly like update mode, but
   * stays a fresh registration — the minting-wallet picker is shown and
   * submission calls the register endpoint, minting a BRAND-NEW asset with a
   * NEW agent identifier on the active payment source. Used to re-register a
   * previously deregistered agent.
   */
  prefillAgent?: RegistryEntry | null;
  /** Stack above an elevated parent (e.g. opened from the agent details dialog). */
  elevatedChildStack?: boolean;
}

const createPriceSchema = (network: 'Mainnet' | 'Preprod') => {
  const stablecoinUnit = network === 'Mainnet' ? 'USDCx' : 'tUSDM';
  return z.object({
    unit: z.enum(['lovelace', stablecoinUnit] as const, {
      error: () => 'Token is required',
    }),
    amount: z
      .string()
      .max(REGISTRY_LIMITS.lovelaceAmount, 'Amount must be less than 25 characters')
      .refine((val) => {
        if (val === '0' || val === '0.0' || val === '0.00') return true;
        // parseFloat would accept exponent notation ('1e5' crashes BigInt at
        // submit) and >6-decimal amounts (silently truncated to a 0 price).
        return isValidDecimalAmount(val);
      }, 'Amount must be a valid number >= 0 with at most 6 decimals'),
  });
};

const exampleOutputSchema = z.object({
  name: z
    .string()
    .max(REGISTRY_LIMITS.exampleOutputName, 'Name must be less than 60 characters')
    .min(1, 'Name is required'),
  url: z
    .string()
    .url('URL must be a valid URL')
    .max(REGISTRY_LIMITS.exampleOutputUrl, 'URL must be less than 250 characters')
    .min(1, 'URL is required'),
  mimeType: z
    .string()
    .max(REGISTRY_LIMITS.exampleOutputMimeType, 'MIME type must be less than 60 characters')
    .min(1, 'MIME type is required'),
});

const createAgentSchema = (network: 'Mainnet' | 'Preprod') => {
  const priceSchema = createPriceSchema(network);
  return z
    .object({
      apiUrl: z
        .string()
        .url('API URL must be a valid URL')
        .max(REGISTRY_LIMITS.apiBaseUrl, 'API URL must be less than 250 characters')
        .min(1, 'API URL is required')
        .refine((val) => val.startsWith('http://') || val.startsWith('https://'), {
          message: 'API URL must start with http:// or https://',
        }),
      name: z
        .string()
        .min(1, 'Name is required')
        .max(REGISTRY_LIMITS.agentName, 'Name must be less than 250 characters'),
      description: z
        .string()
        .min(1, 'Description is required')
        .max(REGISTRY_LIMITS.description, 'Description must be less than 250 characters'),
      selectedWallet: z
        .string()
        .min(1, 'Wallet is required')
        .max(REGISTRY_LIMITS.walletReference, 'Wallet is invalid'),
      recipientWalletAddress: z
        .string()
        .max(REGISTRY_LIMITS.walletReference, 'Recipient wallet must be less than 250 characters')
        .optional()
        .or(z.literal('')),
      sendFundingAda: z
        .string()
        .optional()
        .or(z.literal(''))
        .refine(
          (val) => val == null || val === '' || REGISTRY_DECIMAL_ADA_AMOUNT_PATTERN.test(val),
          'Funding amount must be a valid ADA amount with up to 6 decimals',
        ),
      prices: z
        .array(priceSchema)
        .max(REGISTRY_LIMITS.pricingOptionCount, 'You can add at most 5 prices'),
      tags: z
        .array(z.string().min(1).max(REGISTRY_LIMITS.tag, 'Tags must be less than 63 characters'))
        .min(1, 'At least one tag is required')
        .max(REGISTRY_LIMITS.tagCount, 'You can add at most 15 tags'),
      pricingType: z.enum(['Fixed', 'Free', 'Dynamic']),
      // Additional Fields
      authorName: z
        .string()
        .max(REGISTRY_LIMITS.authorName, 'Author name must be less than 250 characters')
        .optional()
        .or(z.literal('')),
      authorEmail: z
        .string()
        .email('Author email must be a valid email')
        .max(REGISTRY_LIMITS.authorContact, 'Author email must be less than 250 characters')
        .optional()
        .or(z.literal('')),
      organization: z
        .string()
        .max(REGISTRY_LIMITS.authorContact, 'Organization must be less than 250 characters')
        .optional()
        .or(z.literal('')),
      contactOther: z
        .string()
        .max(REGISTRY_LIMITS.authorContact, 'Contact other must be less than 250 characters')
        .optional()
        .or(z.literal('')),

      termsOfUseUrl: z
        .string()
        .url('Terms of use URL must be a valid URL')
        .max(REGISTRY_LIMITS.legalUrl, 'Terms of use URL must be less than 250 characters')
        .optional()
        .or(z.literal('')),
      privacyPolicyUrl: z
        .string()
        .url('Privacy policy URL must be a valid URL')
        .max(REGISTRY_LIMITS.legalUrl, 'Privacy policy URL must be less than 250 characters')
        .optional()
        .or(z.literal('')),
      otherUrl: z
        .string()
        .url('Other URL must be a valid URL')
        .max(REGISTRY_LIMITS.legalUrl, 'Other URL must be less than 250 characters')
        .optional()
        .or(z.literal('')),

      capabilityName: z
        .string()
        .max(REGISTRY_LIMITS.capabilityName, 'Capability name must be less than 250 characters')
        .optional()
        .or(z.literal('')),
      capabilityVersion: z
        .string()
        .max(
          REGISTRY_LIMITS.capabilityVersion,
          'Capability version must be less than 250 characters',
        )
        .optional()
        .or(z.literal('')),

      exampleOutputs: z
        .array(exampleOutputSchema)
        .max(REGISTRY_LIMITS.exampleOutputCount, 'You can add at most 25 example outputs')
        .optional(),
    })
    .superRefine((data, ctx) => {
      if (data.pricingType === 'Fixed' && data.prices.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['prices'],
          message: 'At least one price is required for fixed pricing',
        });
      }
    });
};

type AgentFormValues = z.infer<ReturnType<typeof createAgentSchema>>;

function createAgentDefaultValues(
  defaultPriceUnit: 'lovelace' | 'USDCx' | 'tUSDM',
): AgentFormValues {
  return {
    apiUrl: '',
    name: '',
    description: '',
    selectedWallet: '',
    recipientWalletAddress: '',
    sendFundingAda: '',
    prices: [{ unit: defaultPriceUnit, amount: '' }],
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
    exampleOutputs: [],
  };
}

type EvmSupportedSource = Extract<
  NonNullable<RegistryEntry['supportedPaymentSources']>[number],
  { chain: 'EVM' }
>;
type CardanoSupportedSource = Extract<
  NonNullable<RegistryEntry['supportedPaymentSources']>[number],
  { chain: 'Cardano' }
>;

type PaymentConfigurationType = 'Masumi' | 'x402';
type PaymentOptionRow = {
  id: string;
  type: PaymentConfigurationType;
};
type MasumiOptionDraft = {
  id: string;
  pricingType: 'Fixed' | 'Dynamic' | 'Free';
  prices: Array<{
    unit: 'lovelace' | 'USDCx' | 'tUSDM';
    amount: string;
  }>;
};

const MASUMI_PAYMENT_OPTION_ID = 'masumi-payment-option';
const MAX_PAYMENT_OPTIONS = 25;

function createMasumiOption(
  defaultPriceUnit: 'lovelace' | 'USDCx' | 'tUSDM',
  id = `masumi-${crypto.randomUUID()}`,
): MasumiOptionDraft {
  return {
    id,
    pricingType: 'Fixed',
    prices: [{ unit: defaultPriceUnit, amount: '' }],
  };
}

function MasumiOptionFields({
  option,
  optionNumber,
  network,
  stablecoinUnit,
  defaultPriceUnit,
  onChange,
}: {
  option: MasumiOptionDraft;
  optionNumber: number;
  network: 'Mainnet' | 'Preprod';
  stablecoinUnit: 'USDCx' | 'tUSDM';
  defaultPriceUnit: 'lovelace' | 'USDCx' | 'tUSDM';
  onChange: (option: MasumiOptionDraft) => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium">
          Pricing model <span className="text-destructive">*</span>
        </label>
        <Select
          value={option.pricingType}
          onValueChange={(value: MasumiOptionDraft['pricingType']) =>
            onChange({
              ...option,
              pricingType: value,
              prices:
                value === 'Fixed'
                  ? option.prices.length > 0
                    ? option.prices
                    : [{ unit: defaultPriceUnit, amount: '' }]
                  : [],
            })
          }
        >
          <SelectTrigger aria-label={`Pricing model for payment option ${optionNumber}`}>
            <SelectValue placeholder="Select a pricing model" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="Fixed">Fixed price</SelectItem>
              <SelectItem value="Dynamic">Dynamic per payment</SelectItem>
              <SelectItem value="Free">Free</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        {option.pricingType === 'Dynamic' ? (
          <p className="text-xs text-muted-foreground">
            Your agent sets the amount for each payment request.
          </p>
        ) : null}
        {option.pricingType === 'Free' ? (
          <p className="text-xs text-muted-foreground">
            Interactions do not require a Masumi escrow payment.
          </p>
        ) : null}
      </div>

      {option.pricingType === 'Fixed' ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs font-medium">
              Coins and prices <span className="text-destructive">*</span>
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={option.prices.length >= REGISTRY_LIMITS.pricingOptionCount}
              onClick={() =>
                onChange({
                  ...option,
                  prices: [...option.prices, { unit: defaultPriceUnit, amount: '' }],
                })
              }
            >
              <Plus data-icon="inline-start" />
              Add coin
            </Button>
          </div>
          {option.prices.map((price, priceIndex) => (
            <div
              key={`${option.id}-${priceIndex}`}
              className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-start"
            >
              <div className="min-w-0 flex-1">
                <Select
                  value={price.unit}
                  onValueChange={(unit: MasumiOptionDraft['prices'][number]['unit']) =>
                    onChange({
                      ...option,
                      prices: option.prices.map((candidate, index) =>
                        index === priceIndex ? { ...candidate, unit } : candidate,
                      ),
                    })
                  }
                >
                  <SelectTrigger aria-label={`Coin for Masumi price ${priceIndex + 1}`}>
                    <SelectValue placeholder="Select a coin" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={stablecoinUnit}>{stablecoinUnit}</SelectItem>
                      <SelectItem value="lovelace">
                        {formatFundUnit('lovelace', network)}
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0 flex-1">
                <Input
                  type="number"
                  inputMode="decimal"
                  aria-label={`Amount for Masumi price ${priceIndex + 1}`}
                  placeholder="0.00"
                  onWheel={(event) => event.currentTarget.blur()}
                  value={price.amount}
                  onChange={(event) =>
                    onChange({
                      ...option,
                      prices: option.prices.map((candidate, index) =>
                        index === priceIndex
                          ? { ...candidate, amount: event.target.value }
                          : candidate,
                      ),
                    })
                  }
                  min="0"
                  step="0.000001"
                />
              </div>
              {option.prices.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 self-end sm:h-9 sm:w-9 sm:self-auto"
                  aria-label={`Remove Masumi price ${priceIndex + 1}`}
                  onClick={() =>
                    onChange({
                      ...option,
                      prices: option.prices.filter((_, index) => index !== priceIndex),
                    })
                  }
                >
                  <Trash2 />
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

export function RegisterAIAgentDialog({
  open,
  onClose,
  onSuccess,
  editingAgent,
  editingAgentSmartContractAddress,
  prefillAgent,
  elevatedChildStack,
}: RegisterAIAgentDialogProps) {
  const isUpdateMode = !!editingAgent;
  // Re-register: prefill from an existing (deregistered) agent but mint a
  // fresh registration. Never both — editingAgent takes precedence.
  const isReRegisterMode = !isUpdateMode && !!prefillAgent;
  const sourceAgent = editingAgent ?? prefillAgent ?? null;
  const [isLoading, setIsLoading] = useState(false);
  // Author/legal/capability/example-output fields are all optional, so collapse
  // them by default to shorten the form; auto-expand when editing/re-registering
  // an existing agent (below) so its saved values are visible.
  const [showAdditional, setShowAdditional] = useState(false);
  const [sellingWallets, setSellingWallets] = useState<
    { wallet: WalletListItem; balance: number }[]
  >([]);

  const { wallets, isLoading: isLoadingWallets, isError: isWalletsError } = useWallets();
  const { apiClient, network, selectedPaymentSource, selectedX402ChainId } = useAppContext();
  // x402 and source-owned pricing are V2-only; update always targets V2.
  const isV2Target = isUpdateMode
    ? true
    : !!selectedPaymentSource && isV2PaymentSource(selectedPaymentSource);
  const stablecoinUnit = network === 'Mainnet' ? 'USDCx' : 'tUSDM';
  // V2 treats every advertised payment source as a peer. Start fixed pricing
  // with the network stablecoin instead of implying that ADA is mandatory.
  const defaultPriceUnit =
    selectedPaymentSource && isV2PaymentSource(selectedPaymentSource) ? stablecoinUnit : 'lovelace';

  const {
    register,
    handleSubmit,
    control,
    setValue,
    reset,
    formState: { errors },
    watch,
  } = useForm<AgentFormValues>({
    resolver: zodResolver(createAgentSchema(network)),
    defaultValues: {
      ...createAgentDefaultValues(defaultPriceUnit),
      ...(isV2Target ? { prices: [], pricingType: 'Dynamic' as const } : {}),
    },
  });

  const {
    fields: priceFields,
    append: appendPrice,
    remove: removePrice,
    replace: replacePrices,
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
  const selectedWalletVkey = watch('selectedWallet');
  const selectedRecipientWalletAddress = watch('recipientWalletAddress');
  const selectedSendFundingAda = watch('sendFundingAda');
  const [tagInput, setTagInput] = useState('');
  useEffect(() => {
    setSellingWallets(
      wallets
        .filter((w) => w.type === 'Selling')
        .map((w) => ({
          wallet: {
            id: w.id,
            paymentSourceId: w.paymentSourceId,
            type: w.type,
            walletVkey: w.walletVkey,
            walletAddress: w.walletAddress,
            collectionAddress: w.collectionAddress,
            note: w.note,
            LowBalanceSummary: w.LowBalanceSummary,
          },
          balance: parseInt(w.balance, 10),
        })),
    );
  }, [wallets]);

  useEffect(() => {
    if (!open) return;
    // Expanded when there's an agent to review (update/re-register), collapsed
    // for a fresh registration.
    setShowAdditional(Boolean(sourceAgent));
    if (sourceAgent) {
      const editingAgent = sourceAgent;
      // Pre-fill the form from the existing registration. The on-chain
      // pricing unit `''` (empty string) represents lovelace — the
      // RegisterAIAgentDialog UI uses the literal 'lovelace' so the
      // SelectItem value stays in range. The Pricing.unit may also be a
      // policyId+assetName for the active stablecoin; we map that back to
      // the symbolic option the picker exposes (`USDCx` / `tUSDM`).
      const stablecoinFullAssetId = getActiveStablecoinConfig(network).fullAssetId;
      const mapPricingUnitToOption = (unit: string): 'lovelace' | typeof stablecoinUnit => {
        if (unit === '' || unit === 'lovelace') return 'lovelace';
        if (unit === stablecoinFullAssetId) return stablecoinUnit;
        // Unknown unit (legacy / custom) — keep raw value so the picker
        // shows it as a validation error rather than silently dropping it.
        return unit as 'lovelace' | typeof stablecoinUnit;
      };
      const mapAmount = (rawAmount: string) => {
        // Stored as lovelace integer string; UI uses ADA decimal display.
        // BigInt string math — Number()/1e6 loses precision on large amounts,
        // so resubmitting an update would write a subtly different price
        // on-chain.
        if (!rawAmount || rawAmount === '0') return '0';
        try {
          return convertBaseUnitsToDecimal(rawAmount);
        } catch {
          // Non-integer legacy value — keep raw so validation surfaces it.
          return rawAmount;
        }
      };
      const editingPricing = getPrimaryCardanoPricing(editingAgent) ?? {
        pricingType: 'Free' as const,
      };
      reset({
        apiUrl: editingAgent.apiBaseUrl,
        name: editingAgent.name,
        description: editingAgent.description ?? '',
        // Selling wallet is fixed in update mode — the asset's managed
        // holder signs the UpdateAction; the picker is hidden below.
        selectedWallet: editingAgent.SmartContractWallet?.walletVkey ?? '',
        recipientWalletAddress: editingAgent.RecipientWallet?.walletAddress ?? '',
        sendFundingAda: editingAgent.sendFundingLovelace
          ? mapAmount(editingAgent.sendFundingLovelace)
          : '',
        prices:
          !isV2Target && editingPricing.pricingType === 'Fixed'
            ? editingPricing.Pricing.map((p) => ({
                unit: mapPricingUnitToOption(p.unit),
                amount: mapAmount(p.amount),
              }))
            : [],
        tags: editingAgent.Tags ?? [],
        pricingType: isV2Target ? 'Dynamic' : editingPricing.pricingType,
        authorName: editingAgent.Author.name,
        authorEmail: editingAgent.Author.contactEmail ?? '',
        organization: editingAgent.Author.organization ?? '',
        contactOther: editingAgent.Author.contactOther ?? '',
        termsOfUseUrl: editingAgent.Legal.terms ?? '',
        privacyPolicyUrl: editingAgent.Legal.privacyPolicy ?? '',
        otherUrl: editingAgent.Legal.other ?? '',
        capabilityName: editingAgent.Capability.name ?? '',
        capabilityVersion: editingAgent.Capability.version ?? '',
        exampleOutputs: (editingAgent.ExampleOutputs ?? []).map((e) => ({
          name: e.name,
          url: e.url,
          mimeType: e.mimeType,
        })),
      });
      const prefilledX402Options = (editingAgent.supportedPaymentSources ?? [])
        .filter((source): source is EvmSupportedSource => source.chain === 'EVM')
        .map((source) => {
          const pricing = source.pricing;
          const fixedPrice = pricing.pricingType === 'Fixed' ? pricing.fixed[0] : undefined;
          const dynamicAsset = pricing.pricingType === 'Dynamic' ? pricing.dynamic?.[0] : undefined;

          return {
            id: newX402OptionId(),
            pricingType: pricing.pricingType,
            caip2Network: source.network,
            asset: fixedPrice?.asset ?? dynamicAsset?.asset ?? '',
            amount:
              fixedPrice == null
                ? ''
                : x402AmountFromBaseUnits(fixedPrice.amount, fixedPrice.decimals ?? 0),
            decimals:
              fixedPrice?.decimals != null
                ? String(fixedPrice.decimals)
                : dynamicAsset?.decimals != null
                  ? String(dynamicAsset.decimals)
                  : '',
            payTo: source.payTo,
            resource: source.resource ?? '',
          };
        });
      const storedPaymentSources = editingAgent.supportedPaymentSources;
      const storedCardanoSources = (storedPaymentSources ?? []).filter(
        (source): source is CardanoSupportedSource => source.chain === 'Cardano',
      );
      const prefilledMasumiOptions: MasumiOptionDraft[] =
        storedCardanoSources.length > 0
          ? storedCardanoSources.map((source, index) => ({
              id: index === 0 ? MASUMI_PAYMENT_OPTION_ID : `masumi-${crypto.randomUUID()}`,
              pricingType: source.pricing.pricingType,
              prices:
                source.pricing.pricingType === 'Fixed'
                  ? source.pricing.fixed.map((price) => ({
                      unit: mapPricingUnitToOption(price.asset),
                      amount: mapAmount(price.amount),
                    }))
                  : [],
            }))
          : storedPaymentSources == null || storedPaymentSources.length === 0
            ? [
                {
                  id: MASUMI_PAYMENT_OPTION_ID,
                  pricingType: editingPricing.pricingType,
                  prices:
                    editingPricing.pricingType === 'Fixed'
                      ? editingPricing.Pricing.map((price) => ({
                          unit: mapPricingUnitToOption(price.unit),
                          amount: mapAmount(price.amount),
                        }))
                      : [],
                },
              ]
            : [];
      setMasumiOptions(prefilledMasumiOptions);
      setX402Options(prefilledX402Options);
      setPaymentOptionRows([
        ...prefilledMasumiOptions.map((option) => ({ id: option.id, type: 'Masumi' as const })),
        ...prefilledX402Options.map((option) => ({ id: option.id, type: 'x402' as const })),
      ]);
      setX402Error(null);
      setVerifications(verificationsFromApi(editingAgent.verifications));
      setVerificationsError(null);
      return;
    }
    reset({
      ...createAgentDefaultValues(defaultPriceUnit),
      ...(isV2Target ? { prices: [], pricingType: 'Dynamic' as const } : {}),
    });
    setMasumiOptions([createMasumiOption(defaultPriceUnit, MASUMI_PAYMENT_OPTION_ID)]);
    setPaymentOptionRows([{ id: MASUMI_PAYMENT_OPTION_ID, type: 'Masumi' }]);
    setX402Options([]);
    setX402Error(null);
    setVerifications([]);
    setVerificationsError(null);
  }, [defaultPriceUnit, isV2Target, open, reset, sourceAgent, network, stablecoinUnit]);

  const selectedWallet = useMemo(
    () => sellingWallets.find((wallet) => wallet.wallet.walletVkey === selectedWalletVkey),
    [sellingWallets, selectedWalletVkey],
  );
  // The chosen minting wallet always belongs to the active payment source
  // (the picker is scoped to it via useWallets), so its sibling holding wallets
  // are the other wallets returned for that source.
  const recipientWalletOptions = useMemo(
    () =>
      selectedWallet
        ? wallets.filter((wallet) => wallet.walletAddress !== selectedWallet.wallet.walletAddress)
        : [],
    [wallets, selectedWallet],
  );

  const [x402Options, setX402Options] = useState<X402OptionDraft[]>([]);
  const [x402Error, setX402Error] = useState<{
    message: string;
    optionId?: string;
  } | null>(null);
  const [paymentOptionRows, setPaymentOptionRows] = useState<PaymentOptionRow[]>([
    { id: MASUMI_PAYMENT_OPTION_ID, type: 'Masumi' },
  ]);
  const [masumiOptions, setMasumiOptions] = useState<MasumiOptionDraft[]>(() => [
    createMasumiOption(defaultPriceUnit, MASUMI_PAYMENT_OPTION_ID),
  ]);
  const [masumiError, setMasumiError] = useState<{
    message: string;
    optionId?: string;
  } | null>(null);
  const [verifications, setVerifications] = useState<VerificationDraft[]>([]);
  const [verificationsError, setVerificationsError] = useState<string | null>(null);
  const { networks: x402Networks } = useAvailableX402Networks({ silentErrors: true });
  const { wallets: x402Wallets, isLoading: isLoadingX402Wallets } = useX402Wallets(open, 'Selling');
  const hasMasumiPaymentOption = paymentOptionRows.some((option) => option.type === 'Masumi');

  // Options that already went through the one-shot autofill below. Without this
  // guard the effect would re-run on every wallets-query refresh and stomp
  // fields the user deliberately cleared (e.g. "Custom EVM address" empties
  // payTo). Ids are fresh per dialog session, so stale entries are harmless.
  const autofilledOptionIds = useRef(new Set<string>());

  useEffect(() => {
    if (x402Networks.length === 0 || isLoadingX402Wallets) return;

    setX402Options((currentOptions) => {
      let hasChanges = false;
      const nextOptions = currentOptions.map((option) => {
        if (autofilledOptionIds.current.has(option.id)) return option;
        autofilledOptionIds.current.add(option.id);
        if (option.caip2Network && option.payTo) return option;

        const defaults = defaultX402Option(x402Networks, x402Wallets, selectedX402ChainId);
        const nextOption = {
          ...option,
          caip2Network: option.caip2Network || defaults.caip2Network,
          asset: option.asset || (option.pricingType === 'Fixed' ? defaults.asset : ''),
          decimals:
            option.asset || option.pricingType !== 'Fixed' ? option.decimals : defaults.decimals,
          payTo: option.payTo || defaults.payTo,
        };
        hasChanges =
          hasChanges ||
          nextOption.caip2Network !== option.caip2Network ||
          nextOption.asset !== option.asset ||
          nextOption.decimals !== option.decimals ||
          nextOption.payTo !== option.payTo;
        return nextOption;
      });
      return hasChanges ? nextOptions : currentOptions;
    });
  }, [isLoadingX402Wallets, selectedX402ChainId, x402Networks, x402Wallets]);

  // New options are born with live defaults when networks and wallets are
  // already loaded, so mark them autofilled immediately; otherwise leave them
  // for the one-shot effect above to complete once the data arrives.
  const createX402Option = () => {
    const option = defaultX402Option(x402Networks, x402Wallets, selectedX402ChainId);
    if (x402Networks.length > 0 && !isLoadingX402Wallets) {
      autofilledOptionIds.current.add(option.id);
    }
    return option;
  };

  const addPaymentOption = () => {
    if (paymentOptionRows.length >= MAX_PAYMENT_OPTIONS) return;
    const option = createX402Option();
    setX402Options((currentOptions) => [...currentOptions, option]);
    setPaymentOptionRows((currentRows) => [...currentRows, { id: option.id, type: 'x402' }]);
    setX402Error(null);
  };

  const changePaymentOptionType = (
    optionRow: PaymentOptionRow,
    nextType: PaymentConfigurationType,
  ) => {
    if (optionRow.type === nextType) return;

    if (nextType === 'Masumi') {
      setX402Options((currentOptions) =>
        currentOptions.filter((option) => option.id !== optionRow.id),
      );
      const option = createMasumiOption(defaultPriceUnit);
      setMasumiOptions((currentOptions) => [...currentOptions, option]);
      setPaymentOptionRows((currentRows) =>
        currentRows.map((row) =>
          row.id === optionRow.id ? { id: option.id, type: 'Masumi' } : row,
        ),
      );
      if (!isV2Target) {
        setValue('pricingType', 'Fixed');
        replacePrices([{ unit: defaultPriceUnit, amount: '' }]);
      }
      setX402Error(null);
      setMasumiError(null);
      return;
    }

    const option = createX402Option();
    setMasumiOptions((currentOptions) =>
      currentOptions.filter((candidate) => candidate.id !== optionRow.id),
    );
    setX402Options((currentOptions) => [...currentOptions, option]);
    setPaymentOptionRows((currentRows) =>
      currentRows.map((row) => (row.id === optionRow.id ? { id: option.id, type: 'x402' } : row)),
    );
    setValue('pricingType', 'Dynamic');
    replacePrices([]);
    setX402Error(null);
  };

  const removePaymentOption = (optionRow: PaymentOptionRow) => {
    if (paymentOptionRows.length === 1) return;

    setPaymentOptionRows((currentRows) => currentRows.filter((row) => row.id !== optionRow.id));
    if (optionRow.type === 'x402') {
      setX402Options((currentOptions) =>
        currentOptions.filter((option) => option.id !== optionRow.id),
      );
      setX402Error(null);
      return;
    }

    setMasumiOptions((currentOptions) =>
      currentOptions.filter((option) => option.id !== optionRow.id),
    );
    setMasumiError(null);
    if (!isV2Target) {
      setValue('pricingType', 'Dynamic');
      replacePrices([]);
    }
  };

  useEffect(() => {
    // Wallets drive recipientWalletOptions; while the wallets query is still
    // loading (or errored) the options are transiently empty, and reconciling
    // against them would wipe the prefilled holding wallet + funding override
    // in update mode. Only reconcile once wallets have actually loaded.
    if (isLoadingWallets || isWalletsError) return;
    if (!selectedRecipientWalletAddress) {
      if (selectedSendFundingAda) {
        setValue('sendFundingAda', '');
      }
      return;
    }

    const isRecipientStillAvailable = recipientWalletOptions.some(
      (wallet) => wallet.walletAddress === selectedRecipientWalletAddress,
    );
    if (!isRecipientStillAvailable) {
      setValue('recipientWalletAddress', '');
    }
  }, [
    isLoadingWallets,
    isWalletsError,
    recipientWalletOptions,
    selectedRecipientWalletAddress,
    selectedSendFundingAda,
    setValue,
  ]);

  const onSubmit = useCallback(
    async (data: AgentFormValues) => {
      try {
        setIsLoading(true);
        const selectedWalletVkey = data.selectedWallet;
        // Register requires the user to pick a wallet with funds. Update
        // is signed by whatever managed wallet currently holds the
        // asset, so the picker is hidden and the balance gate is skipped
        // — the backend / scheduler will surface a meaningful error if
        // the holder wallet is under-funded.
        if (!isUpdateMode) {
          const selectedWalletBalance = sellingWallets.find(
            (w) => w.wallet.walletVkey == selectedWalletVkey,
          )?.balance;
          if (selectedWalletBalance == undefined || selectedWalletBalance <= 3000000) {
            toast.error('Insufficient balance in selected wallet');
            return;
          }
          // The picker only offers wallets from the active payment source, so a
          // picked wallet implies the source is present.
          if (!selectedPaymentSource) {
            toast.error('Smart contract wallet not found in payment sources');
            return;
          }
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
          // Preserve the operator's real input, empty included. The backend
          // accepts an empty author name; defaulting it to a placeholder would
          // fabricate on-chain authorship that was never entered.
          name: data.authorName ?? '',
        };
        if (data.authorEmail) author.contactEmail = data.authorEmail;
        if (data.contactOther) author.contactOther = data.contactOther;
        if (data.organization) author.organization = data.organization;

        // Preserve each capability field independently — requiring both would
        // silently discard a half-filled capability (destructive in update
        // mode, where it would overwrite the on-chain name with the default).
        const capability = {
          name: data.capabilityName || 'Custom Agent',
          version: data.capabilityVersion || '1.0.0',
        };

        const stablecoinAsset = getActiveStablecoinConfig(network).fullAssetId;
        const sourcePricingByMasumiOption = new Map<string, CardanoSupportedSource['pricing']>();
        if (isV2Target) {
          const firstMasumiIndexByKey = new Map<string, number>();
          for (const option of masumiOptions) {
            const optionIndex = paymentOptionRows.findIndex((row) => row.id === option.id);
            const optionNumber = optionIndex >= 0 ? optionIndex + 1 : 1;
            let pricing: CardanoSupportedSource['pricing'];
            if (option.pricingType === 'Fixed') {
              if (
                option.prices.length === 0 ||
                option.prices.length > REGISTRY_LIMITS.pricingOptionCount
              ) {
                const message = `Masumi option ${optionNumber}: add between 1 and 5 coin prices`;
                setMasumiError({ message, optionId: option.id });
                toast.error(message);
                return;
              }
              const fixed: Extract<
                CardanoSupportedSource['pricing'],
                { pricingType: 'Fixed' }
              >['fixed'] = [];
              for (const price of option.prices) {
                if (!isValidDecimalAmount(price.amount)) {
                  const message = `Masumi option ${optionNumber}: enter a valid positive amount with up to 6 decimals`;
                  setMasumiError({ message, optionId: option.id });
                  toast.error(message);
                  return;
                }
                const amount = convertDecimalToBaseUnits(price.amount);
                if (BigInt(amount) <= BigInt(0) || BigInt(amount) > BigInt('9223372036854775807')) {
                  const message = `Masumi option ${optionNumber}: each price must be greater than zero and fit in the supported range`;
                  setMasumiError({ message, optionId: option.id });
                  toast.error(message);
                  return;
                }
                fixed.push({
                  asset:
                    price.unit === stablecoinUnit
                      ? stablecoinAsset
                      : price.unit === 'lovelace'
                        ? ''
                        : price.unit,
                  amount,
                });
              }
              pricing = { pricingType: 'Fixed', fixed };
            } else {
              pricing = { pricingType: option.pricingType };
            }

            const canonicalPricing =
              pricing.pricingType === 'Fixed'
                ? {
                    ...pricing,
                    fixed: [...pricing.fixed].sort(
                      (left, right) =>
                        left.asset.localeCompare(right.asset) ||
                        left.amount.localeCompare(right.amount),
                    ),
                  }
                : pricing;
            const duplicateKey = JSON.stringify(canonicalPricing);
            const duplicateOf = firstMasumiIndexByKey.get(duplicateKey);
            if (duplicateOf != null) {
              const message =
                `Masumi option ${optionNumber}: duplicates payment option ${duplicateOf + 1}. ` +
                'Choose a different pricing model, coin, or amount.';
              setMasumiError({ message, optionId: option.id });
              toast.error(message);
              return;
            }
            firstMasumiIndexByKey.set(duplicateKey, optionIndex);
            sourcePricingByMasumiOption.set(option.id, pricing);
          }
        }
        setMasumiError(null);

        const agentPricing = (() => {
          if (data.pricingType === 'Free') {
            return { pricingType: 'Free' as const };
          }

          if (data.pricingType === 'Dynamic') {
            return { pricingType: 'Dynamic' as const };
          }

          return {
            pricingType: 'Fixed' as const,
            Pricing: data.prices.map((price) => {
              const unit =
                price.unit === stablecoinUnit
                  ? getActiveStablecoinConfig(network).fullAssetId
                  : price.unit;
              return {
                unit,
                amount: convertDecimalToBaseUnits(price.amount),
              };
            }),
          };
        })();
        const exampleOutputs =
          data.exampleOutputs?.map((e) => ({
            name: e.name,
            url: e.url,
            mimeType: e.mimeType,
          })) || [];
        const sendFundingLovelace =
          data.recipientWalletAddress && data.sendFundingAda
            ? convertDecimalToBaseUnits(data.sendFundingAda)
            : undefined;

        const evmSupportedSources = x402Options.map((option) => {
          const common = {
            chain: 'EVM' as const,
            network: option.caip2Network,
            scheme: 'Exact' as const,
            payTo: option.payTo,
            resource: option.resource ? option.resource : undefined,
          };
          if (option.pricingType === 'Fixed') {
            return {
              ...common,
              pricing: {
                pricingType: 'Fixed' as const,
                fixed: [
                  {
                    asset: option.asset,
                    amount: normalizeX402Amount(option.amount, option.decimals),
                    decimals: Number(option.decimals),
                  },
                ],
              },
            };
          }
          if (option.pricingType === 'Dynamic' && option.asset) {
            return {
              ...common,
              pricing: {
                pricingType: 'Dynamic' as const,
                dynamic: [
                  {
                    asset: option.asset,
                    decimals: Number(option.decimals),
                  },
                ] as [
                  {
                    asset: string;
                    decimals: number;
                  },
                ],
              },
            };
          }
          return {
            ...common,
            pricing: {
              pricingType: option.pricingType,
            },
          };
        });
        if (!isV2Target && x402Options.length > 0) {
          const unavailableMessage =
            'x402 payment options require an active Web3 Cardano V2 payment source';
          setX402Error({ message: unavailableMessage });
          toast.error(unavailableMessage);
          return;
        }
        if (x402Options.length > 0) {
          const x402ValidationError = findX402ValidationError(x402Options);
          if (x402ValidationError) {
            setX402Error({
              message: x402ValidationError.message,
              optionId: x402Options[x402ValidationError.index]?.id,
            });
            toast.error(x402ValidationError.message);
            return;
          }
        }
        setX402Error(null);
        if (isV2Target && verifications.length > 0) {
          const verificationsValidationError = validateVerifications(verifications);
          if (verificationsValidationError) {
            setVerificationsError(verificationsValidationError);
            toast.error(verificationsValidationError);
            return;
          }
        }
        setVerificationsError(null);

        if (isUpdateMode && editingAgent) {
          if (!editingAgent.agentIdentifier) {
            throw new Error('Cannot update agent: Missing on-chain identifier');
          }
          if (!editingAgentSmartContractAddress) {
            throw new Error('Cannot update agent: Missing payment source address');
          }
          const masumiSupportedSources: CardanoSupportedSource[] = masumiOptions.map((option) => ({
            chain: 'Cardano',
            network,
            paymentSourceType: 'Web3CardanoV2',
            address: editingAgentSmartContractAddress,
            pricing: sourcePricingByMasumiOption.get(option.id)!,
          }));
          const updateResponse = await postRegistryUpdate({
            client: apiClient,
            body: {
              agentIdentifier: editingAgent.agentIdentifier,
              network,
              smartContractAddress: editingAgentSmartContractAddress,
              recipientWalletAddress: data.recipientWalletAddress || undefined,
              sendFundingLovelace,
              name: data.name,
              description: data.description,
              apiBaseUrl: data.apiUrl,
              Tags: data.tags,
              Capability: capability,
              Author: author,
              Legal: Object.keys(legal).length > 0 ? legal : undefined,
              ExampleOutputs: exampleOutputs,
              supportedPaymentSources: [...masumiSupportedSources, ...evmSupportedSources],
              // Update is V2-only (isV2Target is forced true above) and the
              // form's `verifications` state is the authoritative user-facing
              // list (loaded from the agent on open). Always send it so the
              // backend mirrors exactly what the user sees — sending `[]`
              // clears stored rows. Gating on a derived `hadVerifications`
              // flag would silently keep stale rows when the list API returns
              // `verifications: null` for rows it dropped as malformed.
              verifications: verificationsToApi(verifications),
            },
          });

          // The generated client returns {data, error} and never throws —
          // surface the real backend error instead of the generic fallback.
          if (updateResponse.error || !updateResponse.data?.data?.id) {
            throw new Error(
              extractApiErrorMessage(
                updateResponse.error,
                'Failed to update AI agent: Invalid response from server',
              ),
            );
          }

          toast.success('AI agent update requested');
          onSuccess();
          onClose();
          reset();
          return;
        }

        const activeMasumiAddress = selectedPaymentSource?.smartContractAddress;
        if (isV2Target && masumiOptions.length > 0 && !activeMasumiAddress) {
          throw new Error('Cannot register agent: Missing active Masumi payment source address');
        }
        const masumiSupportedSources: CardanoSupportedSource[] =
          isV2Target && activeMasumiAddress
            ? masumiOptions.map((option) => ({
                chain: 'Cardano',
                network,
                paymentSourceType: 'Web3CardanoV2',
                address: activeMasumiAddress,
                pricing: sourcePricingByMasumiOption.get(option.id)!,
              }))
            : [];
        const response = await postRegistry({
          client: apiClient,
          body: {
            network: network,
            sellingWalletVkey: selectedWalletVkey,
            recipientWalletAddress: data.recipientWalletAddress || undefined,
            sendFundingLovelace,
            name: data.name,
            description: data.description,
            apiBaseUrl: data.apiUrl,
            Tags: data.tags,
            Capability: capability,
            Author: author,
            Legal: Object.keys(legal).length > 0 ? legal : undefined,
            ExampleOutputs: exampleOutputs,
            ...(isV2Target
              ? {
                  supportedPaymentSources: [...masumiSupportedSources, ...evmSupportedSources],
                }
              : { AgentPricing: agentPricing }),
            ...(isV2Target && verifications.length > 0
              ? { verifications: verificationsToApi(verifications) }
              : {}),
          },
        });

        // The generated client returns {data, error} and never throws —
        // surface the real backend error instead of the generic fallback.
        if (response.error || !response.data?.data?.id) {
          throw new Error(
            extractApiErrorMessage(
              response.error,
              'Failed to register AI agent: Invalid response from server',
            ),
          );
        }

        toast.success(
          isReRegisterMode
            ? 'AI agent re-registration requested (a new identifier will be minted)'
            : 'AI agent registered successfully',
        );
        onSuccess();
        onClose();
        reset();
      } catch (error: unknown) {
        console.error('Error registering AI agent:', error);
        toast.error(error instanceof Error ? error.message : 'Failed to register AI agent');
      } finally {
        setIsLoading(false);
      }
    },
    [
      sellingWallets,
      selectedPaymentSource,
      apiClient,
      network,
      stablecoinUnit,
      onSuccess,
      onClose,
      reset,
      isUpdateMode,
      isReRegisterMode,
      editingAgent,
      editingAgentSmartContractAddress,
      x402Options,
      masumiOptions,
      paymentOptionRows,
      verifications,
      isV2Target,
    ],
  );

  // Tag management
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

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent size="lg" className="overflow-y-auto" elevatedChildStack={elevatedChildStack}>
        <DialogHeader>
          <DialogTitle>
            {isUpdateMode
              ? 'Update AI Agent'
              : isReRegisterMode
                ? 'Re-register AI Agent'
                : 'Register AI Agent'}
          </DialogTitle>
          <p className="text-sm text-muted-foreground mt-2">
            {isUpdateMode
              ? 'Updating the on-chain metadata issues an UpdateAction on the V2 registry contract: the existing asset is burned and a new asset with the incremented version is minted in a single transaction.'
              : isReRegisterMode
                ? 'This mints a brand-new registration from the previous agent’s details. It will be issued a new agent identifier — the old, deregistered one is not reused. Review the fields and wallet below, then mint.'
                : 'This registers your agent on the Masumi Network, making it visible to everyone.'}
          </p>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium">
              API URL <span className="text-destructive">*</span>
            </label>
            <Input
              {...register('apiUrl')}
              placeholder="Enter the API URL for your agent"
              className={errors.apiUrl ? 'border-destructive' : ''}
            />
            {errors.apiUrl && <p className="text-sm text-destructive">{errors.apiUrl.message}</p>}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Name <span className="text-destructive">*</span>
            </label>
            <Input
              {...register('name')}
              placeholder="Enter a name for your agent"
              className={errors.name ? 'border-destructive' : ''}
            />
            {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Description <span className="text-destructive">*</span>
            </label>
            <div className="relative">
              <Textarea
                {...register('description')}
                placeholder="Describe what your agent does"
                rows={3}
                className={`resize-none overflow-y-auto h-[84px] ${errors.description ? 'border-destructive' : ''}`}
                maxLength={250}
              />
              <div className="absolute bottom-2 right-2 text-xs text-muted-foreground">
                {watch('description')?.length || 0}/250
              </div>
            </div>
            {errors.description && (
              <p className="text-sm text-destructive">{errors.description.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Tags <span className="text-destructive">*</span>
            </label>
            <div>
              <div className="flex gap-2">
                <Input
                  placeholder="Add a tag"
                  value={tagInput}
                  maxLength={REGISTRY_LIMITS.tag}
                  onChange={(event) => setTagInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
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
              {errors.tags ? (
                <p className="text-sm text-destructive">{errors.tags.message}</p>
              ) : null}
              {tags.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
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
              ) : null}
            </div>
          </div>

          {isUpdateMode ? (
            <div className="space-y-2">
              <label className="text-sm font-medium">Minting wallet</label>
              <Input
                value={
                  editingAgent?.SmartContractWallet?.walletAddress
                    ? shortenAddress(editingAgent.SmartContractWallet.walletAddress)
                    : '—'
                }
                disabled
              />
              <p className="text-xs text-muted-foreground">
                The wallet currently holding the agent NFT signs the UpdateAction; it cannot be
                changed here.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Minting wallet <span className="text-destructive">*</span>
              </label>
              <Controller
                control={control}
                name="selectedWallet"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger
                      disabled={isLoadingWallets}
                      className={`${errors.selectedWallet ? 'border-destructive' : ''} ${isLoadingWallets ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <SelectValue
                        placeholder={
                          isLoadingWallets ? 'Loading wallets...' : 'Select a minting wallet'
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {sellingWallets.map((wallet) => (
                        <SelectItem
                          disabled={wallet.balance <= 3000000}
                          key={wallet.wallet.id}
                          value={wallet.wallet.walletVkey}
                        >
                          {wallet.wallet.note
                            ? `${wallet.wallet.note} (${shortenAddress(wallet.wallet.walletAddress)})`
                            : shortenAddress(wallet.wallet.walletAddress)}{' '}
                          {wallet.balance <= 3000000 ? ' - Insufficient balance' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.selectedWallet && (
                <p className="text-sm text-destructive">{errors.selectedWallet.message}</p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">Holding wallet</label>
            <Controller
              control={control}
              name="recipientWalletAddress"
              render={({ field }) => (
                <Select
                  value={field.value || '__default'}
                  onValueChange={(value) => field.onChange(value === '__default' ? '' : value)}
                >
                  <SelectTrigger
                    disabled={isLoadingWallets || !selectedWallet}
                    className={isLoadingWallets ? 'opacity-50 cursor-not-allowed' : ''}
                  >
                    <SelectValue
                      placeholder={
                        !selectedWallet
                          ? 'Select a minting wallet first'
                          : 'Use minting wallet (default)'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default">Use minting wallet (default)</SelectItem>
                    {recipientWalletOptions.map((wallet) => (
                      <SelectItem key={wallet.id} value={wallet.walletAddress}>
                        {wallet.note
                          ? `${wallet.note} (${shortenAddress(wallet.walletAddress)})`
                          : shortenAddress(wallet.walletAddress)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <p className="text-xs text-muted-foreground">
              Optional. The selected minting wallet still mints and pays fees, while the registry
              NFT is delivered to another managed holding wallet on the same payment source.
            </p>
            {selectedWallet && recipientWalletOptions.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No other managed wallets are available on this payment source.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Holding wallet funding (ADA)</label>
            <Input
              {...register('sendFundingAda')}
              type="number"
              inputMode="decimal"
              min="0"
              step="0.000001"
              placeholder="Optional ADA amount"
              disabled={!selectedRecipientWalletAddress}
              className={errors.sendFundingAda ? 'border-destructive' : ''}
            />
            <p className="text-xs text-muted-foreground">
              Optional. Sends extra ADA with the minted NFT to the selected holding wallet. The
              current minimum NFT funding still applies.
            </p>
            {!selectedRecipientWalletAddress && (
              <p className="text-xs text-muted-foreground">
                Select a holding wallet to set a custom funding amount.
              </p>
            )}
            {errors.sendFundingAda && (
              <p className="text-sm text-destructive">{errors.sendFundingAda.message}</p>
            )}
          </div>

          <section className="space-y-4 border-t pt-6" aria-labelledby="payment-options-heading">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <h3 id="payment-options-heading" className="text-base font-semibold">
                    Payment options
                  </h3>
                  <Badge variant="secondary" className="font-normal text-muted-foreground">
                    {paymentOptionRows.length}{' '}
                    {paymentOptionRows.length === 1 ? 'option' : 'options'}
                  </Badge>
                </div>
                <p className="max-w-[65ch] text-sm text-muted-foreground">
                  Offer Masumi escrow, x402 direct settlement, or both.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addPaymentOption}
                disabled={paymentOptionRows.length >= MAX_PAYMENT_OPTIONS}
              >
                <Plus data-icon="inline-start" />
                Add payment option
              </Button>
            </div>

            {!isV2Target && x402Options.length > 0 ? (
              <p
                role="status"
                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                x402 options require an active Web3 Cardano V2 payment source.
              </p>
            ) : null}
            {x402Options.length > 0 && x402Networks.length === 0 ? (
              <p
                role="status"
                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                Configure an EVM chain in x402 setup before registering this agent.
              </p>
            ) : null}
            {paymentOptionRows.length >= MAX_PAYMENT_OPTIONS ? (
              <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                The on-chain limit allows 25 payment options in total.
              </p>
            ) : null}
            {x402Error && !x402Error.optionId ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {x402Error.message}
              </p>
            ) : null}

            <div className="flex flex-col gap-4">
              {paymentOptionRows.map((optionRow, optionIndex) => {
                const x402Option =
                  optionRow.type === 'x402'
                    ? x402Options.find((option) => option.id === optionRow.id)
                    : undefined;
                const masumiOption =
                  optionRow.type === 'Masumi'
                    ? masumiOptions.find((option) => option.id === optionRow.id)
                    : undefined;

                return (
                  <article
                    key={optionRow.id}
                    className="overflow-hidden rounded-lg border bg-card/40"
                    aria-labelledby={`payment-option-${optionRow.id}`}
                  >
                    <div className="flex flex-col gap-3 border-b bg-muted/20 px-4 py-3 sm:flex-row sm:items-end sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <h4 id={`payment-option-${optionRow.id}`} className="text-sm font-semibold">
                          Payment option {optionIndex + 1}
                        </h4>
                        <p className="text-xs text-muted-foreground">
                          {optionRow.type === 'Masumi'
                            ? 'Escrow settlement with dispute support.'
                            : x402Option?.pricingType === 'Fixed'
                              ? 'An exact amount and asset stored in the registry.'
                              : x402Option?.pricingType === 'Free'
                                ? 'No payment is required for this x402 resource.'
                                : 'The exact amount is supplied at runtime.'}
                        </p>
                      </div>

                      <div className="flex w-full items-end gap-2 sm:w-auto">
                        <div className="min-w-0 flex-1 space-y-1 sm:w-56 sm:flex-none">
                          <label className="text-xs font-medium text-muted-foreground">
                            Payment type
                          </label>
                          <Select
                            value={optionRow.type}
                            onValueChange={(value) => {
                              if (value === 'Masumi' || value === 'x402') {
                                changePaymentOptionType(optionRow, value);
                              }
                            }}
                          >
                            <SelectTrigger
                              className="h-9 bg-background"
                              aria-label={`Payment type for option ${optionIndex + 1}`}
                            >
                              <SelectValue placeholder="Select a payment type" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                <SelectItem
                                  value="Masumi"
                                  disabled={
                                    !isV2Target &&
                                    hasMasumiPaymentOption &&
                                    optionRow.type !== 'Masumi'
                                  }
                                >
                                  Disputable (Masumi)
                                </SelectItem>
                                <SelectItem value="x402">x402 direct settlement</SelectItem>
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </div>
                        {paymentOptionRows.length > 1 ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-10 w-10 shrink-0 sm:h-9 sm:w-9"
                            aria-label={`Remove payment option ${optionIndex + 1}`}
                            onClick={() => removePaymentOption(optionRow)}
                          >
                            <Trash2 />
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    <div className="space-y-4 p-4">
                      {optionRow.type === 'Masumi' ? (
                        isV2Target && masumiOption ? (
                          <>
                            <MasumiOptionFields
                              option={masumiOption}
                              optionNumber={optionIndex + 1}
                              network={network}
                              stablecoinUnit={stablecoinUnit}
                              defaultPriceUnit={defaultPriceUnit}
                              onChange={(nextOption) => {
                                setMasumiOptions((currentOptions) =>
                                  currentOptions.map((option) =>
                                    option.id === nextOption.id ? nextOption : option,
                                  ),
                                );
                                setMasumiError(null);
                              }}
                            />
                            {masumiError?.optionId === optionRow.id ? (
                              <p
                                role="alert"
                                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                              >
                                {masumiError.message}
                              </p>
                            ) : null}
                          </>
                        ) : (
                          <>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium">
                                Pricing model <span className="text-destructive">*</span>
                              </label>
                              <Controller
                                control={control}
                                name="pricingType"
                                render={({ field }) => (
                                  <Select
                                    value={field.value}
                                    onValueChange={(value) => {
                                      field.onChange(value);
                                      if (value === 'Fixed' && priceFields.length === 0) {
                                        replacePrices([{ unit: defaultPriceUnit, amount: '' }]);
                                      } else if (value !== 'Fixed') {
                                        replacePrices([]);
                                      }
                                    }}
                                  >
                                    <SelectTrigger
                                      aria-label={`Pricing model for payment option ${optionIndex + 1}`}
                                    >
                                      <SelectValue placeholder="Select a pricing model" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectGroup>
                                        <SelectItem value="Fixed">Fixed price</SelectItem>
                                        <SelectItem value="Dynamic">Dynamic per payment</SelectItem>
                                        <SelectItem value="Free">Free</SelectItem>
                                      </SelectGroup>
                                    </SelectContent>
                                  </Select>
                                )}
                              />
                              {watch('pricingType') === 'Dynamic' ? (
                                <p className="text-xs text-muted-foreground">
                                  Your agent sets the amount for each payment request.
                                </p>
                              ) : null}
                              {watch('pricingType') === 'Free' ? (
                                <p className="text-xs text-muted-foreground">
                                  Interactions do not require a Masumi escrow payment.
                                </p>
                              ) : null}
                            </div>

                            {watch('pricingType') === 'Fixed' ? (
                              <div className="flex flex-col gap-3">
                                <div className="flex items-center justify-between gap-3">
                                  <label className="text-xs font-medium">
                                    Coins and prices <span className="text-destructive">*</span>
                                  </label>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    disabled={
                                      priceFields.length >= REGISTRY_LIMITS.pricingOptionCount
                                    }
                                    onClick={() =>
                                      appendPrice({ unit: defaultPriceUnit, amount: '' })
                                    }
                                  >
                                    <Plus data-icon="inline-start" />
                                    Add coin
                                  </Button>
                                </div>
                                {priceFields.map((priceField, index) => (
                                  <div
                                    key={priceField.id}
                                    className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-start"
                                  >
                                    <div className="min-w-0 flex-1">
                                      <Controller
                                        control={control}
                                        name={`prices.${index}.unit` as const}
                                        render={({ field }) => (
                                          <Select
                                            value={field.value}
                                            onValueChange={field.onChange}
                                          >
                                            <SelectTrigger
                                              aria-label={`Coin for Masumi price ${index + 1}`}
                                            >
                                              <SelectValue placeholder="Select a coin" />
                                            </SelectTrigger>
                                            <SelectContent>
                                              <SelectGroup>
                                                <SelectItem value={stablecoinUnit}>
                                                  {stablecoinUnit}
                                                </SelectItem>
                                                <SelectItem value="lovelace">
                                                  {formatFundUnit('lovelace', network)}
                                                </SelectItem>
                                              </SelectGroup>
                                            </SelectContent>
                                          </Select>
                                        )}
                                      />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <Input
                                        type="number"
                                        inputMode="decimal"
                                        aria-label={`Amount for Masumi price ${index + 1}`}
                                        placeholder="0.00"
                                        onWheel={(event) => event.currentTarget.blur()}
                                        value={watch(`prices.${index}.amount`) || ''}
                                        {...register(`prices.${index}.amount` as const)}
                                        min="0"
                                        step="0.000001"
                                      />
                                      {errors.prices &&
                                      Array.isArray(errors.prices) &&
                                      errors.prices[index]?.amount ? (
                                        <p className="mt-1 text-xs text-destructive">
                                          {errors.prices[index]?.amount?.message}
                                        </p>
                                      ) : null}
                                    </div>
                                    {index > 0 ? (
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="h-10 w-10 self-end sm:h-9 sm:w-9 sm:self-auto"
                                        aria-label={`Remove Masumi price ${index + 1}`}
                                        onClick={() => removePrice(index)}
                                      >
                                        <Trash2 />
                                      </Button>
                                    ) : null}
                                  </div>
                                ))}
                                {errors.prices && typeof errors.prices.message === 'string' ? (
                                  <p className="text-sm text-destructive">
                                    {errors.prices.message}
                                  </p>
                                ) : null}
                              </div>
                            ) : null}
                          </>
                        )
                      ) : x402Option ? (
                        <>
                          <X402OptionFields
                            option={x402Option}
                            optionNumber={optionIndex + 1}
                            networks={x402Networks}
                            wallets={x402Wallets}
                            isLoadingWallets={isLoadingX402Wallets}
                            onChange={(patch) => {
                              setX402Options((currentOptions) =>
                                currentOptions.map((option) =>
                                  option.id === optionRow.id ? { ...option, ...patch } : option,
                                ),
                              );
                              setX402Error(null);
                            }}
                          />
                          {x402Error?.optionId === optionRow.id ? (
                            <p
                              role="alert"
                              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                            >
                              {x402Error.message}
                            </p>
                          ) : null}
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">Preparing x402 settings…</p>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          {isV2Target && (
            <VerificationsSection
              verifications={verifications}
              onChange={setVerifications}
              error={verificationsError}
            />
          )}

          <button
            type="button"
            onClick={() => setShowAdditional((v) => !v)}
            aria-expanded={showAdditional}
            className="flex items-center gap-4 pt-2 w-full group"
          >
            <Separator className="flex-1" />
            <span className="flex items-center gap-1 text-sm font-medium text-muted-foreground whitespace-nowrap group-hover:text-foreground transition-colors">
              Additional Fields
              <ChevronDown
                className={`h-4 w-4 transition-transform ${showAdditional ? 'rotate-180' : ''}`}
              />
            </span>
            <Separator className="flex-1" />
          </button>

          {showAdditional && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">Author Name</label>
                <Input
                  {...register('authorName')}
                  placeholder="Enter the author's name"
                  className={errors.authorName ? 'border-destructive' : ''}
                />
                {errors.authorName && (
                  <p className="text-sm text-destructive">{errors.authorName.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Author Email</label>
                <Input
                  {...register('authorEmail')}
                  type="email"
                  placeholder="Enter the author's email address"
                  className={errors.authorEmail ? 'border-destructive' : ''}
                />
                {errors.authorEmail && (
                  <p className="text-sm text-destructive">{errors.authorEmail.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Organization</label>
                <Input
                  {...register('organization')}
                  placeholder="Enter the organization name"
                  className={errors.organization ? 'border-destructive' : ''}
                />
                {errors.organization && (
                  <p className="text-sm text-destructive">{errors.organization.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Contact Other (Website, Phone...)</label>
                <Input
                  {...register('contactOther')}
                  placeholder="Enter other contact"
                  className={errors.contactOther ? 'border-destructive' : ''}
                />
                {errors.contactOther && (
                  <p className="text-sm text-destructive">{errors.contactOther.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Terms of Use URL</label>
                <Input
                  {...register('termsOfUseUrl')}
                  placeholder="Enter the terms of use URL"
                  className={errors.termsOfUseUrl ? 'border-destructive' : ''}
                />
                {errors.termsOfUseUrl && (
                  <p className="text-sm text-destructive">{errors.termsOfUseUrl.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Privacy Policy URL</label>
                <Input
                  {...register('privacyPolicyUrl')}
                  placeholder="Enter the privacy policy URL"
                  className={errors.privacyPolicyUrl ? 'border-destructive' : ''}
                />
                {errors.privacyPolicyUrl && (
                  <p className="text-sm text-destructive">{errors.privacyPolicyUrl.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Other URL (Support...)</label>
                <Input
                  {...register('otherUrl')}
                  placeholder="Enter the other URL"
                  className={errors.otherUrl ? 'border-destructive' : ''}
                />
                {errors.otherUrl && (
                  <p className="text-sm text-destructive">{errors.otherUrl.message}</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Capability Name</label>
                  <Input
                    {...register('capabilityName')}
                    placeholder="e.g., Text Generation"
                    className={errors.capabilityName ? 'border-destructive' : ''}
                  />
                  {errors.capabilityName && (
                    <p className="text-sm text-destructive">{errors.capabilityName.message}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Capability Version</label>
                  <Input
                    {...register('capabilityVersion')}
                    placeholder="e.g., 1.0.0"
                    className={errors.capabilityVersion ? 'border-destructive' : ''}
                  />
                  {errors.capabilityVersion && (
                    <p className="text-sm text-destructive">{errors.capabilityVersion.message}</p>
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
                    disabled={exampleOutputFields.length >= REGISTRY_LIMITS.exampleOutputCount}
                    onClick={() => appendExampleOutput({ name: '', url: '', mimeType: '' })}
                  >
                    Add Example
                  </Button>
                </div>
                {exampleOutputFields.map((field, index) => (
                  <div key={field.id} className="p-4 border rounded-md space-y-2 relative">
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
                        aria-label="Remove example output"
                        onClick={() => removeExampleOutput(index)}
                        className="absolute top-2 right-2"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="flex justify-end items-center gap-2">
            <Button variant="outline" onClick={onClose} type="button">
              Cancel
            </Button>
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={isLoading || (isLoadingWallets && !isUpdateMode)}>
                {isLoading
                  ? isUpdateMode
                    ? 'Updating...'
                    : isReRegisterMode
                      ? 'Re-registering...'
                      : 'Registering...'
                  : isUpdateMode
                    ? 'Update'
                    : isReRegisterMode
                      ? 'Re-register'
                      : 'Register'}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
