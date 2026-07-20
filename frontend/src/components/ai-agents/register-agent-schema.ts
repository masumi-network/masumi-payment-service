import { z } from 'zod';
import { REGISTRY_DECIMAL_ADA_AMOUNT_PATTERN, REGISTRY_LIMITS } from '@/lib/registry-validation';
import { isValidDecimalAmount } from '@/lib/convertDecimalToBaseUnits';
import type { MasumiPriceUnit } from '@/lib/agent-registration';

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

export const createAgentSchema = (network: 'Mainnet' | 'Preprod') => {
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

export type AgentFormValues = z.infer<ReturnType<typeof createAgentSchema>>;

export function createAgentDefaultValues(defaultPriceUnit: MasumiPriceUnit): AgentFormValues {
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
