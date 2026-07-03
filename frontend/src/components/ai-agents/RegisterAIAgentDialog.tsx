import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Badge } from '../ui/badge';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postRegistry, postRegistryUpdate, RegistryEntry } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { shortenAddress, formatFundUnit } from '@/lib/utils';
import { Trash2 } from 'lucide-react';
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
import { useX402Networks } from '@/lib/hooks/useX402';
import {
  X402OptionsSection,
  normalizeX402Amount,
  validateX402Options,
  type X402OptionDraft,
} from './X402OptionsSection';
import {
  VerificationsSection,
  validateVerifications,
  verificationsFromApi,
  verificationsToApi,
  type VerificationDraft,
} from './VerificationsSection';

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

type EvmSupportedSource = Extract<
  NonNullable<RegistryEntry['supportedPaymentSources']>[number],
  { chain: 'EVM' }
>;

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
  const [sellingWallets, setSellingWallets] = useState<
    { wallet: WalletListItem; balance: number }[]
  >([]);

  const { wallets, isLoading: isLoadingWallets, isError: isWalletsError } = useWallets();
  const { apiClient, network, selectedPaymentSource } = useAppContext();
  const stablecoinUnit = network === 'Mainnet' ? 'USDCx' : 'tUSDM';

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
      apiUrl: '',
      name: '',
      description: '',
      selectedWallet: '',
      recipientWalletAddress: '',
      sendFundingAda: '',
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
          editingAgent.AgentPricing.pricingType === 'Fixed'
            ? editingAgent.AgentPricing.Pricing.map((p) => ({
                unit: mapPricingUnitToOption(p.unit),
                amount: mapAmount(p.amount),
              }))
            : [{ unit: 'lovelace' as const, amount: '' }],
        tags: editingAgent.Tags ?? [],
        pricingType: editingAgent.AgentPricing.pricingType,
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
      setX402Options(
        (editingAgent.supportedPaymentSources ?? [])
          .filter((source): source is EvmSupportedSource => source.chain === 'EVM')
          .map((source) => ({
            caip2Network: source.network,
            asset: source.asset,
            amount: source.amount,
            decimals: String(source.decimals),
            payTo: source.payTo,
            resource: source.resource ?? '',
          })),
      );
      setX402Error(null);
      setVerifications(verificationsFromApi(editingAgent.verifications));
      setVerificationsError(null);
      return;
    }
    reset();
    setX402Options([]);
    setX402Error(null);
    setVerifications([]);
    setVerificationsError(null);
  }, [open, reset, sourceAgent, network, stablecoinUnit]);

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

  const { networks: x402Networks } = useX402Networks({ silentErrors: true });
  const [x402Options, setX402Options] = useState<X402OptionDraft[]>([]);
  const [x402Error, setX402Error] = useState<string | null>(null);
  const [verifications, setVerifications] = useState<VerificationDraft[]>([]);
  const [verificationsError, setVerificationsError] = useState<string | null>(null);
  // x402 supported payment sources are a V2-only capability; update always targets V2.
  const isV2Target = isUpdateMode
    ? true
    : !!selectedPaymentSource && isV2PaymentSource(selectedPaymentSource);

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

        const evmSupportedSources = x402Options.map((option) => ({
          chain: 'EVM' as const,
          network: option.caip2Network,
          scheme: 'Exact' as const,
          asset: option.asset,
          amount: normalizeX402Amount(option.amount),
          decimals: Number(option.decimals),
          payTo: option.payTo,
          resource: option.resource ? option.resource : undefined,
        }));
        if (isV2Target && x402Options.length > 0) {
          const x402ValidationError = validateX402Options(x402Options);
          if (x402ValidationError) {
            setX402Error(x402ValidationError);
            toast.error(x402ValidationError);
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
          // Update replaces the full supported-payment-sources set; preserve any
          // non-EVM (Cardano) entries and only rewrite the x402/EVM ones.
          const existingNonEvmSources = (editingAgent.supportedPaymentSources ?? []).filter(
            (source) => source.chain !== 'EVM',
          );
          const hadEvmSources =
            (editingAgent.supportedPaymentSources ?? []).length > existingNonEvmSources.length;
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
              AgentPricing: agentPricing,
              Author: author,
              Legal: Object.keys(legal).length > 0 ? legal : undefined,
              ExampleOutputs: exampleOutputs,
              ...(evmSupportedSources.length > 0 || hadEvmSources
                ? {
                    supportedPaymentSources: [...existingNonEvmSources, ...evmSupportedSources],
                  }
                : {}),
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
            AgentPricing: agentPricing,
            Author: author,
            Legal: Object.keys(legal).length > 0 ? legal : undefined,
            ExampleOutputs: exampleOutputs,
            ...(isV2Target && evmSupportedSources.length > 0
              ? { supportedPaymentSources: evmSupportedSources }
              : {}),
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
      } catch (error: any) {
        console.error('Error registering AI agent:', error);
        toast.error(error?.message ?? 'Failed to register AI agent');
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
      <DialogContent
        className="sm:max-w-[700px] overflow-y-auto"
        elevatedChildStack={elevatedChildStack}
      >
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
              API URL <span className="text-red-500">*</span>
            </label>
            <Input
              {...register('apiUrl')}
              placeholder="Enter the API URL for your agent"
              className={errors.apiUrl ? 'border-red-500' : ''}
            />
            {errors.apiUrl && <p className="text-sm text-red-500">{errors.apiUrl.message}</p>}
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
            {errors.name && <p className="text-sm text-red-500">{errors.name.message}</p>}
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
                className={`resize-none overflow-y-auto h-[84px] ${errors.description ? 'border-red-500' : ''}`}
                maxLength={250}
              />
              <div className="absolute bottom-2 right-2 text-xs text-muted-foreground">
                {watch('description')?.length || 0}/250
              </div>
            </div>
            {errors.description && (
              <p className="text-sm text-red-500">{errors.description.message}</p>
            )}
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
                Minting wallet <span className="text-red-500">*</span>
              </label>
              <Controller
                control={control}
                name="selectedWallet"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger
                      disabled={isLoadingWallets}
                      className={`${errors.selectedWallet ? 'border-red-500' : ''} ${isLoadingWallets ? 'opacity-50 cursor-not-allowed' : ''}`}
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
                <p className="text-sm text-red-500">{errors.selectedWallet.message}</p>
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
              className={errors.sendFundingAda ? 'border-red-500' : ''}
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
              <p className="text-sm text-red-500">{errors.sendFundingAda.message}</p>
            )}
          </div>

          {/* Pricing Type */}
          <div className="space-y-2">
            <label className="text-sm font-medium">
              Pricing Type <span className="text-red-500">*</span>
            </label>
            <Controller
              control={control}
              name="pricingType"
              render={({ field }) => (
                <Select
                  value={field.value}
                  onValueChange={(val) => {
                    field.onChange(val);
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
              )}
            />
            {watch('pricingType') === 'Dynamic' && (
              <p className="text-xs text-muted-foreground">
                The price will be determined per payment/purchase request by the agent.
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
                disabled={
                  watch('pricingType') !== 'Fixed' ||
                  priceFields.length >= REGISTRY_LIMITS.pricingOptionCount
                }
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
                        disabled={watch('pricingType') !== 'Fixed'}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select token" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="lovelace">
                            {formatFundUnit('lovelace', network)}
                          </SelectItem>
                          <SelectItem value={stablecoinUnit}>{stablecoinUnit}</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
                <div className="flex-1 space-y-2">
                  <Input
                    type="number"
                    placeholder="0.00"
                    onWheel={(e) => e.currentTarget.blur()}
                    disabled={watch('pricingType') !== 'Fixed'}
                    value={watch(`prices.${index}.amount`) || ''}
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
                  maxLength={REGISTRY_LIMITS.tag}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddTag();
                    }
                  }}
                  className={errors.tags ? 'border-red-500' : ''}
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
              {errors.tags && <p className="text-sm text-red-500">{errors.tags.message}</p>}
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

          {isV2Target && (
            <div className="flex items-center gap-4 pt-2">
              <Separator className="flex-1" />
              <h3 className="text-sm font-medium text-muted-foreground whitespace-nowrap">
                Payment options
              </h3>
              <Separator className="flex-1" />
            </div>
          )}
          {isV2Target && (
            <X402OptionsSection
              options={x402Options}
              networks={x402Networks}
              onChange={setX402Options}
              error={x402Error}
            />
          )}

          {isV2Target && (
            <VerificationsSection
              verifications={verifications}
              onChange={setVerifications}
              error={verificationsError}
            />
          )}

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
              <p className="text-sm text-red-500">{errors.authorName.message}</p>
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
              <p className="text-sm text-red-500">{errors.authorEmail.message}</p>
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
              <p className="text-sm text-red-500">{errors.organization.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Contact Other (Website, Phone...)</label>
            <Input
              {...register('contactOther')}
              placeholder="Enter other contact"
              className={errors.contactOther ? 'border-red-500' : ''}
            />
            {errors.contactOther && (
              <p className="text-sm text-red-500">{errors.contactOther.message}</p>
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
              <p className="text-sm text-red-500">{errors.termsOfUseUrl.message}</p>
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
              <p className="text-sm text-red-500">{errors.privacyPolicyUrl.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Other URL (Support...)</label>
            <Input
              {...register('otherUrl')}
              placeholder="Enter the other URL"
              className={errors.otherUrl ? 'border-red-500' : ''}
            />
            {errors.otherUrl && <p className="text-sm text-red-500">{errors.otherUrl.message}</p>}
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
                <p className="text-sm text-red-500">{errors.capabilityName.message}</p>
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
                <p className="text-sm text-red-500">{errors.capabilityVersion.message}</p>
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
                  <Input placeholder="URL" {...register(`exampleOutputs.${index}.url` as const)} />
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
