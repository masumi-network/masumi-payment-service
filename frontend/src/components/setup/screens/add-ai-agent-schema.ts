import { z } from 'zod';
import { REGISTRY_LIMITS } from '@/lib/registry-validation';
import { isValidDecimalAmount } from '@/lib/convertDecimalToBaseUnits';

/**
 * Builds the setup AI-agent registration schema. Factored out of
 * AddAiAgentScreen verbatim; it takes the active stablecoin unit because the
 * price token enum is network-dependent.
 */
export function buildAgentSchema(stablecoinUnit: string) {
  const priceSchema = z.object({
    unit: z.enum(['lovelace', stablecoinUnit] as const, {
      error: () => 'Token is required',
    }),
    amount: z
      .string()
      .max(REGISTRY_LIMITS.lovelaceAmount, 'Amount must be less than 25 characters')
      // parseFloat would accept '1e3', which crashes convertDecimalToBaseUnits
      // (BigInt) at submit with an opaque error.
      .refine(
        (val) => isValidDecimalAmount(val),
        'Amount must be a valid decimal number >= 0 with at most 6 decimal places',
      ),
  });

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
}

export type AgentFormValues = z.infer<ReturnType<typeof buildAgentSchema>>;
