import { HotWalletType, PricingType } from '@/generated/prisma/client';
import { metadataToString } from '@/utils/converter/metadata-string-convert';
import { AgentMetadataObject } from '@/utils/shared/schemas';

/**
 * Transforms parsed on-chain metadata to the API response format.
 * Converts snake_case fields to camelCase and handles string/array metadata values.
 */
export function transformParsedMetadataToResponse(parsedData: {
	name: string | string[];
	description?: string | string[];
	api_base_url: string | string[];
	example_output?: Array<{
		name: string | string[];
		mime_type: string | string[];
		url: string | string[];
	}>;
	capability?: {
		name: string | string[];
		version: string | string[];
	};
	author: {
		name: string | string[];
		contact_email?: string | string[];
		contact_other?: string | string[];
		organization?: string | string[];
	};
	legal?: {
		privacy_policy?: string | string[];
		terms?: string | string[];
		other?: string | string[];
	};
	tags: Array<string | string[]>;
	agentPricing:
		| {
				pricingType: typeof PricingType.Fixed;
				fixedPricing: Array<{
					amount: number;
					unit: string | string[];
				}>;
		  }
		| {
				pricingType: typeof PricingType.Free;
		  };
	image: string | string[];
	metadata_version: number;
}): AgentMetadataObject {
	return {
		name: metadataToString(parsedData.name)!,
		description: metadataToString(parsedData.description),
		apiBaseUrl: metadataToString(parsedData.api_base_url)!,
		ExampleOutputs:
			parsedData.example_output?.map((exampleOutput) => ({
				name: metadataToString(exampleOutput.name)!,
				mimeType: metadataToString(exampleOutput.mime_type)!,
				url: metadataToString(exampleOutput.url)!,
			})) ?? [],
		Capability: parsedData.capability
			? {
					name: metadataToString(parsedData.capability.name)!,
					version: metadataToString(parsedData.capability.version)!,
				}
			: undefined,
		Author: {
			name: metadataToString(parsedData.author.name)!,
			contactEmail: metadataToString(parsedData.author.contact_email),
			contactOther: metadataToString(parsedData.author.contact_other),
			organization: metadataToString(parsedData.author.organization),
		},
		Legal: parsedData.legal
			? {
					privacyPolicy: metadataToString(parsedData.legal.privacy_policy),
					terms: metadataToString(parsedData.legal.terms),
					other: metadataToString(parsedData.legal.other),
				}
			: undefined,
		Tags: parsedData.tags.map((tag) => metadataToString(tag)!),
		AgentPricing:
			parsedData.agentPricing.pricingType == PricingType.Fixed
				? {
						pricingType: parsedData.agentPricing.pricingType,
						Pricing: parsedData.agentPricing.fixedPricing.map((price) => ({
							amount: price.amount.toString(),
							unit: metadataToString(price.unit)!,
						})),
					}
				: {
						pricingType: parsedData.agentPricing.pricingType,
					},
		image: metadataToString(parsedData.image)!,
		metadataVersion: parsedData.metadata_version,
	};
}

export function splitWalletsByType<T extends { type: HotWalletType }>(wallets: T[]) {
	return {
		SellingWallets: wallets.filter((w) => w.type === HotWalletType.Selling),
		PurchasingWallets: wallets.filter((w) => w.type === HotWalletType.Purchasing),
	};
}

export function transformBigIntAmounts<T extends { unit: string; amount: bigint }>(
	amounts: T[],
): Array<{ unit: string; amount: string }> {
	return amounts.map((amount) => ({
		unit: amount.unit,
		amount: amount.amount.toString(),
	}));
}

export function transformNullableBigInt(value: bigint | null | undefined): string | null {
	return value != null ? value.toString() : null;
}

export function transformPaymentGetAmounts(payment: {
	RequestedFunds: Array<{ unit: string; amount: bigint }>;
	WithdrawnForSeller: Array<{ unit: string; amount: bigint }>;
	WithdrawnForBuyer: Array<{ unit: string; amount: bigint }>;
}) {
	return {
		RequestedFunds: (payment.RequestedFunds as Array<{ unit: string; amount: bigint }>).map((amount) => ({
			...amount,
			amount: amount.amount.toString(),
		})),
		WithdrawnForSeller: (payment.WithdrawnForSeller as Array<{ unit: string; amount: bigint }>).map((amount) => ({
			unit: amount.unit,
			amount: amount.amount.toString(),
		})),
		WithdrawnForBuyer: (payment.WithdrawnForBuyer as Array<{ unit: string; amount: bigint }>).map((amount) => ({
			unit: amount.unit,
			amount: amount.amount.toString(),
		})),
	};
}

export function transformPurchaseGetAmounts(purchase: {
	PaidFunds: Array<{ unit: string; amount: bigint }>;
	WithdrawnForSeller: Array<{ unit: string; amount: bigint }>;
	WithdrawnForBuyer: Array<{ unit: string; amount: bigint }>;
}) {
	return {
		PaidFunds: (purchase.PaidFunds as Array<{ unit: string; amount: bigint }>).map((amount) => ({
			...amount,
			amount: amount.amount.toString(),
		})),
		WithdrawnForSeller: (purchase.WithdrawnForSeller as Array<{ unit: string; amount: bigint }>).map((amount) => ({
			unit: amount.unit,
			amount: amount.amount.toString(),
		})),
		WithdrawnForBuyer: (purchase.WithdrawnForBuyer as Array<{ unit: string; amount: bigint }>).map((amount) => ({
			unit: amount.unit,
			amount: amount.amount.toString(),
		})),
	};
}

export function transformPaymentGetTimestamps(payment: {
	submitResultTime: bigint;
	payByTime: bigint | null;
	unlockTime: bigint;
	externalDisputeUnlockTime: bigint;
	collateralReturnLovelace?: bigint | null;
	sellerCoolDownTime: bigint;
	buyerCoolDownTime: bigint;
}) {
	return {
		submitResultTime: payment.submitResultTime.toString(),
		payByTime: payment.payByTime?.toString() ?? null,
		unlockTime: payment.unlockTime.toString(),
		externalDisputeUnlockTime: payment.externalDisputeUnlockTime.toString(),
		collateralReturnLovelace: payment.collateralReturnLovelace?.toString() ?? null,
		cooldownTime: Number(payment.sellerCoolDownTime),
		cooldownTimeOtherParty: Number(payment.buyerCoolDownTime),
	};
}

export function transformPurchaseGetTimestamps(purchase: {
	submitResultTime: bigint;
	payByTime: bigint | null;
	unlockTime: bigint;
	externalDisputeUnlockTime: bigint;
	collateralReturnLovelace?: bigint | null;
	buyerCoolDownTime: bigint;
	sellerCoolDownTime: bigint;
}) {
	return {
		submitResultTime: purchase.submitResultTime.toString(),
		payByTime: purchase.payByTime?.toString() ?? null,
		unlockTime: purchase.unlockTime.toString(),
		externalDisputeUnlockTime: purchase.externalDisputeUnlockTime.toString(),
		collateralReturnLovelace: purchase.collateralReturnLovelace?.toString() ?? null,
		cooldownTime: Number(purchase.buyerCoolDownTime),
		cooldownTimeOtherParty: Number(purchase.sellerCoolDownTime),
	};
}
