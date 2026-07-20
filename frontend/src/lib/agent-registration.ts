import type { RegistryEntry } from '@/lib/api/generated';
import { POSTGRES_BIGINT_MAX, REGISTRY_LIMITS } from '@/lib/registry-validation';
import {
  convertBaseUnitsToDecimal,
  convertDecimalToBaseUnits,
  isValidDecimalAmount,
} from '@/lib/convertDecimalToBaseUnits';
import {
  newX402OptionId,
  normalizeX402Amount,
  x402AmountFromBaseUnits,
  type X402OptionDraft,
} from '@/lib/x402-registration';
import type { AgentPricingView } from '@/lib/registry-pricing';

type SupportedPaymentSource = NonNullable<RegistryEntry['supportedPaymentSources']>[number];
export type CardanoSupportedSource = Extract<SupportedPaymentSource, { chain: 'Cardano' }>;
export type EvmSupportedSource = Extract<SupportedPaymentSource, { chain: 'EVM' }>;

export type PaymentConfigurationType = 'Masumi' | 'x402';
export type PaymentOptionRow = {
  id: string;
  type: PaymentConfigurationType;
};

export type MasumiStablecoinUnit = 'USDCx' | 'tUSDM';
export type MasumiPriceUnit = 'lovelace' | MasumiStablecoinUnit;

export type MasumiOptionDraft = {
  id: string;
  pricingType: 'Fixed' | 'Dynamic' | 'Free';
  prices: Array<{
    unit: MasumiPriceUnit;
    amount: string;
  }>;
  /**
   * Escrow contract address of the stored source this option was prefilled
   * from (update mode). Preserved through submit so editing an agent does not
   * silently re-point a source registered at a different V2 contract address.
   * Undefined for newly added options, which fall back to the active source.
   */
  address?: string;
  /**
   * Index of the stored source in `supportedPaymentSources` (update mode).
   * Used on submit to preserve the stored on-chain ordering — the payment
   * endpoint addresses options by position, so reshuffling would silently
   * change what `supportedPaymentSourceIndex` refers to.
   */
  originalIndex?: number;
};

export const MASUMI_PAYMENT_OPTION_ID = 'masumi-payment-option';
export const MAX_PAYMENT_OPTIONS = 25;

export function createMasumiOption(
  defaultPriceUnit: MasumiPriceUnit,
  id = `masumi-${crypto.randomUUID()}`,
): MasumiOptionDraft {
  return {
    id,
    pricingType: 'Fixed',
    prices: [{ unit: defaultPriceUnit, amount: '' }],
  };
}

/**
 * Map a stored on-chain pricing unit to the option the dialog's coin picker
 * exposes. The on-chain unit `''` (empty string) represents lovelace; the
 * active stablecoin's policyId+assetName maps back to its symbolic option.
 * Unknown units (legacy / custom) keep their raw value so the picker shows a
 * validation error rather than silently dropping them.
 */
export function mapStoredUnitToPriceOption(
  unit: string,
  stablecoinUnit: MasumiStablecoinUnit,
  stablecoinFullAssetId: string,
): MasumiPriceUnit {
  if (unit === '' || unit === 'lovelace') return 'lovelace';
  if (unit === stablecoinFullAssetId) return stablecoinUnit;
  return unit as MasumiPriceUnit;
}

/**
 * Convert a stored base-unit amount (lovelace integer string) to the decimal
 * display value the form edits. BigInt string math — `Number()/1e6` loses
 * precision on large amounts, so resubmitting an update would write a subtly
 * different price on-chain. Non-integer legacy values are kept raw so
 * validation surfaces them.
 */
export function storedAmountToDecimal(rawAmount: string): string {
  if (!rawAmount || rawAmount === '0') return '0';
  try {
    return convertBaseUnitsToDecimal(rawAmount);
  } catch {
    return rawAmount;
  }
}

/**
 * Canonical Cardano asset spelling for duplicate detection. Mirrors the
 * backend's `canonicalAssetId` (packages/payment-core payment-source.ts):
 * case-insensitive, with both `''` and `'lovelace'` denoting ADA folded to
 * `''` so alias-spelled duplicates don't evade the pre-check.
 */
function canonicalCardanoAsset(asset: string): string {
  const lowered = asset.toLowerCase();
  return lowered === 'lovelace' ? '' : lowered;
}

// Codepoint comparison, matching the backend's canonical-key sort:
// `localeCompare` is ICU/locale-dependent.
function compareCodepoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type MasumiValidationError = {
  message: string;
  optionId?: string;
};

export type MasumiValidationResult =
  | { error: MasumiValidationError }
  | { pricingByOptionId: Map<string, CardanoSupportedSource['pricing']> };

/**
 * Validate every Masumi option draft and build the source-owned pricing each
 * one submits. `optionNumberById` carries the dialog's overall payment-option
 * numbering (Masumi and x402 rows interleaved) so error messages match what
 * the operator sees on screen.
 */
export function validateMasumiOptions(args: {
  masumiOptions: MasumiOptionDraft[];
  optionNumberById: Map<string, number>;
  stablecoinUnit: MasumiStablecoinUnit;
  stablecoinAsset: string;
}): MasumiValidationResult {
  const { masumiOptions, optionNumberById, stablecoinUnit, stablecoinAsset } = args;
  const pricingByOptionId = new Map<string, CardanoSupportedSource['pricing']>();
  const firstNumberByKey = new Map<string, number>();

  for (const option of masumiOptions) {
    const optionNumber = optionNumberById.get(option.id) ?? 1;
    let pricing: CardanoSupportedSource['pricing'];
    if (option.pricingType === 'Fixed') {
      if (option.prices.length === 0 || option.prices.length > REGISTRY_LIMITS.pricingOptionCount) {
        return {
          error: {
            message: `Masumi option ${optionNumber}: add between 1 and 5 coin prices`,
            optionId: option.id,
          },
        };
      }
      const fixed: Extract<CardanoSupportedSource['pricing'], { pricingType: 'Fixed' }>['fixed'] =
        [];
      for (const price of option.prices) {
        if (!isValidDecimalAmount(price.amount)) {
          return {
            error: {
              message: `Masumi option ${optionNumber}: enter a valid positive amount with up to 6 decimals`,
              optionId: option.id,
            },
          };
        }
        const amount = convertDecimalToBaseUnits(price.amount);
        if (BigInt(amount) <= BigInt(0) || BigInt(amount) > POSTGRES_BIGINT_MAX) {
          return {
            error: {
              message: `Masumi option ${optionNumber}: each price must be greater than zero and fit in the supported range`,
              optionId: option.id,
            },
          };
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

    // Canonicalize the way the backend does (case-insensitive assets with the
    // 'lovelace' alias folded to '', sorted) so equivalent spellings are
    // caught here instead of only failing server-side.
    const canonicalPricing =
      pricing.pricingType === 'Fixed'
        ? {
            ...pricing,
            fixed: pricing.fixed
              .map((price) => ({ ...price, asset: canonicalCardanoAsset(price.asset) }))
              .sort(
                (left, right) =>
                  compareCodepoints(left.asset, right.asset) ||
                  compareCodepoints(left.amount, right.amount),
              ),
          }
        : pricing;
    const duplicateKey = JSON.stringify(canonicalPricing);
    const duplicateOfNumber = firstNumberByKey.get(duplicateKey);
    if (duplicateOfNumber != null) {
      return {
        error: {
          message:
            `Masumi option ${optionNumber}: duplicates payment option ${duplicateOfNumber}. ` +
            'Choose a different pricing model, coin, or amount.',
          optionId: option.id,
        },
      };
    }
    firstNumberByKey.set(duplicateKey, optionNumber);
    pricingByOptionId.set(option.id, pricing);
  }

  return { pricingByOptionId };
}

/**
 * Build the Cardano supported-source payloads for the Masumi options. Each
 * prefilled option keeps the escrow address of the stored source it came
 * from; only newly added options fall back to `fallbackAddress` (the active
 * or editing payment source).
 */
export function buildMasumiSupportedSources(args: {
  masumiOptions: MasumiOptionDraft[];
  pricingByOptionId: Map<string, CardanoSupportedSource['pricing']>;
  network: CardanoSupportedSource['network'];
  fallbackAddress: string;
}): CardanoSupportedSource[] {
  return args.masumiOptions.map((option) => ({
    chain: 'Cardano',
    network: args.network,
    paymentSourceType: 'Web3CardanoV2',
    address: option.address ?? args.fallbackAddress,
    pricing: args.pricingByOptionId.get(option.id)!,
  }));
}

/** Build the EVM (x402) supported-source payloads from the option drafts. */
export function buildEvmSupportedSources(x402Options: X402OptionDraft[]): EvmSupportedSource[] {
  return x402Options.map((option) => {
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
          ] as [{ asset: string; decimals: number }],
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
}

/**
 * Combine the rebuilt Masumi and x402 sources into the submitted array.
 * Options that survived from a stored registration keep the stored on-chain
 * order (`originalIndex`); newly added options are appended at the end in
 * dialog row order. This keeps position-based `supportedPaymentSourceIndex`
 * semantics stable across updates and makes backend
 * `supportedPaymentSources[N]` error indices line up with the dialog's
 * payment-option numbering.
 */
export function buildOrderedSupportedPaymentSources(args: {
  masumiOptions: MasumiOptionDraft[];
  masumiSources: CardanoSupportedSource[];
  x402Options: X402OptionDraft[];
  evmSources: EvmSupportedSource[];
  rowIndexById: Map<string, number>;
}): SupportedPaymentSource[] {
  type Entry = {
    source: SupportedPaymentSource;
    originalIndex?: number;
    rowIndex: number;
  };
  const rowIndexOf = (id: string | undefined) =>
    (id != null ? args.rowIndexById.get(id) : undefined) ?? Number.MAX_SAFE_INTEGER;
  const entries: Entry[] = [
    ...args.masumiSources.map((source, index) => ({
      source: source as SupportedPaymentSource,
      originalIndex: args.masumiOptions[index]?.originalIndex,
      rowIndex: rowIndexOf(args.masumiOptions[index]?.id),
    })),
    ...args.evmSources.map((source, index) => ({
      source: source as SupportedPaymentSource,
      originalIndex: args.x402Options[index]?.originalIndex,
      rowIndex: rowIndexOf(args.x402Options[index]?.id),
    })),
  ];
  const surviving = entries
    .filter((entry) => entry.originalIndex != null)
    .sort((left, right) => left.originalIndex! - right.originalIndex!);
  const added = entries
    .filter((entry) => entry.originalIndex == null)
    .sort((left, right) => left.rowIndex - right.rowIndex);
  return [...surviving, ...added].map((entry) => entry.source);
}

export type AgentMetadataFormInput = {
  privacyPolicyUrl?: string;
  termsOfUseUrl?: string;
  otherUrl?: string;
  authorName?: string;
  authorEmail?: string;
  contactOther?: string;
  organization?: string;
  capabilityName?: string;
  capabilityVersion?: string;
  pricingType: 'Fixed' | 'Free' | 'Dynamic';
  prices: Array<{ unit: string; amount: string }>;
  exampleOutputs?: Array<{ name: string; url: string; mimeType: string }>;
  recipientWalletAddress?: string;
  sendFundingAda?: string;
};

/**
 * Assemble the metadata parts of the register/update payload (legal, author,
 * capability, legacy pricing, example outputs, funding) from the validated
 * form values.
 */
export function buildAgentMetadataPayload(
  data: AgentMetadataFormInput,
  stablecoinUnit: MasumiStablecoinUnit,
  stablecoinAsset: string,
) {
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

  // Legacy top-level pricing (V1 targets only; V2 sends source-owned pricing).
  const agentPricing =
    data.pricingType === 'Free'
      ? { pricingType: 'Free' as const }
      : data.pricingType === 'Dynamic'
        ? { pricingType: 'Dynamic' as const }
        : {
            pricingType: 'Fixed' as const,
            Pricing: data.prices.map((price) => ({
              unit: price.unit === stablecoinUnit ? stablecoinAsset : price.unit,
              amount: convertDecimalToBaseUnits(price.amount),
            })),
          };

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

  return {
    legal: Object.keys(legal).length > 0 ? legal : undefined,
    author,
    capability,
    agentPricing,
    exampleOutputs,
    sendFundingLovelace,
  };
}

export type PaymentOptionPrefill = {
  masumiOptions: MasumiOptionDraft[];
  x402Options: X402OptionDraft[];
  paymentOptionRows: PaymentOptionRow[];
};

/**
 * Map an existing registration's stored payment sources to the dialog's
 * option drafts, preserving the stored order (rows interleave Masumi and
 * x402 exactly as stored so payment-option numbers match on-chain indexes),
 * each Cardano source's own escrow address, and each source's original
 * position. Registrations without `supportedPaymentSources` fall back to a
 * single Masumi option built from the legacy top-level pricing.
 */
export function buildPaymentOptionPrefill(args: {
  supportedPaymentSources: RegistryEntry['supportedPaymentSources'];
  legacyPricing: AgentPricingView;
  stablecoinUnit: MasumiStablecoinUnit;
  stablecoinFullAssetId: string;
}): PaymentOptionPrefill {
  const { supportedPaymentSources, legacyPricing, stablecoinUnit, stablecoinFullAssetId } = args;
  const masumiOptions: MasumiOptionDraft[] = [];
  const x402Options: X402OptionDraft[] = [];
  const paymentOptionRows: PaymentOptionRow[] = [];

  const mapPrices = (prices: Array<{ unit: string; amount: string }>) =>
    prices.map((price) => ({
      unit: mapStoredUnitToPriceOption(price.unit, stablecoinUnit, stablecoinFullAssetId),
      amount: storedAmountToDecimal(price.amount),
    }));

  if (supportedPaymentSources != null && supportedPaymentSources.length > 0) {
    supportedPaymentSources.forEach((source, index) => {
      if (source.chain === 'Cardano') {
        const option: MasumiOptionDraft = {
          id:
            masumiOptions.length === 0 ? MASUMI_PAYMENT_OPTION_ID : `masumi-${crypto.randomUUID()}`,
          pricingType: source.pricing.pricingType,
          prices:
            source.pricing.pricingType === 'Fixed'
              ? mapPrices(
                  source.pricing.fixed.map((price) => ({
                    unit: price.asset,
                    amount: price.amount,
                  })),
                )
              : [],
          address: source.address,
          originalIndex: index,
        };
        masumiOptions.push(option);
        paymentOptionRows.push({ id: option.id, type: 'Masumi' });
        return;
      }
      const pricing = source.pricing;
      const fixedPrice = pricing.pricingType === 'Fixed' ? pricing.fixed[0] : undefined;
      const dynamicAsset = pricing.pricingType === 'Dynamic' ? pricing.dynamic?.[0] : undefined;
      const option: X402OptionDraft = {
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
        originalIndex: index,
      };
      x402Options.push(option);
      paymentOptionRows.push({ id: option.id, type: 'x402' });
    });
    return { masumiOptions, x402Options, paymentOptionRows };
  }

  // Legacy registration (V1-style top-level pricing): one Masumi option.
  const legacyOption: MasumiOptionDraft = {
    id: MASUMI_PAYMENT_OPTION_ID,
    pricingType: legacyPricing.pricingType,
    prices: legacyPricing.pricingType === 'Fixed' ? mapPrices(legacyPricing.Pricing) : [],
  };
  return {
    masumiOptions: [legacyOption],
    x402Options: [],
    paymentOptionRows: [{ id: legacyOption.id, type: 'Masumi' }],
  };
}
