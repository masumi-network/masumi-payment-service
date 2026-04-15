import { PricingType, RegistrationState, TransactionStatus, PaymentType } from '@/generated/prisma/client';

export type RegistryRequestWithIncludes = {
	id: string;
	name: string;
	description: string | null;
	apiBaseUrl: string;
	capabilityName: string | null;
	capabilityVersion: string | null;
	authorName: string;
	authorContactEmail: string | null;
	authorContactOther: string | null;
	authorOrganization: string | null;
	privacyPolicy: string | null;
	terms: string | null;
	other: string | null;
	state: RegistrationState;
	tags: string[];
	agentIdentifier: string | null;
	error: string | null;
	createdAt: Date;
	updatedAt: Date;
	lastCheckedAt: Date | null;
	paymentType: PaymentType;
	Pricing: {
		pricingType: PricingType;
		FixedPricing: {
			Amounts: Array<{ unit: string; amount: bigint }>;
		} | null;
	};
	SmartContractWallet: { walletVkey: string; walletAddress: string };
	ExampleOutputs: Array<{ name: string; url: string; mimeType: string }>;
	CurrentTransaction: {
		txHash: string | null;
		status: TransactionStatus;
		confirmations: number | null;
		fees: bigint | null;
		blockHeight: number | null;
		blockTime: number | null;
	} | null;
};

export function mapRegistryRequestToOutput(item: RegistryRequestWithIncludes) {
	return {
		...item,
		Capability: {
			name: item.capabilityName,
			version: item.capabilityVersion,
		},
		Author: {
			name: item.authorName,
			contactEmail: item.authorContactEmail,
			contactOther: item.authorContactOther,
			organization: item.authorOrganization,
		},
		Legal: {
			privacyPolicy: item.privacyPolicy,
			terms: item.terms,
			other: item.other,
		},
		AgentPricing:
			item.Pricing.pricingType === PricingType.Fixed
				? {
						pricingType: PricingType.Fixed,
						Pricing:
							item.Pricing.FixedPricing?.Amounts.map((p) => ({
								unit: p.unit,
								amount: p.amount.toString(),
							})) ?? [],
					}
				: { pricingType: item.Pricing.pricingType },
		Tags: item.tags,
		CurrentTransaction: item.CurrentTransaction
			? {
					...item.CurrentTransaction,
					fees: item.CurrentTransaction.fees?.toString() ?? null,
				}
			: null,
	};
}

export type A2ARegistryRequestWithIncludes = {
	id: string;
	name: string;
	description: string | null;
	apiBaseUrl: string;
	agentCardUrl: string;
	a2aProtocolVersions: string[];
	a2aAgentVersion: string | null;
	a2aDefaultInputModes: string[];
	a2aDefaultOutputModes: string[];
	a2aProviderName: string | null;
	a2aProviderUrl: string | null;
	a2aDocumentationUrl: string | null;
	a2aIconUrl: string | null;
	a2aCapabilitiesStreaming: boolean | null;
	a2aCapabilitiesPushNotifications: boolean | null;
	state: RegistrationState;
	tags: string[];
	agentIdentifier: string | null;
	error: string | null;
	createdAt: Date;
	updatedAt: Date;
	lastCheckedAt: Date | null;
	paymentType: PaymentType;
	Pricing: {
		pricingType: PricingType;
		FixedPricing: {
			Amounts: Array<{ unit: string; amount: bigint }>;
		} | null;
	};
	SmartContractWallet: { walletVkey: string; walletAddress: string };
	CurrentTransaction: {
		txHash: string | null;
		status: TransactionStatus;
		confirmations: number | null;
		fees: bigint | null;
		blockHeight: number | null;
		blockTime: number | null;
	} | null;
};

export function mapA2ARegistryRequestToOutput(item: A2ARegistryRequestWithIncludes) {
	return {
		id: item.id,
		name: item.name,
		description: item.description,
		apiBaseUrl: item.apiBaseUrl,
		agentCardUrl: item.agentCardUrl,
		a2aProtocolVersions: item.a2aProtocolVersions,
		a2aAgentVersion: item.a2aAgentVersion,
		a2aDefaultInputModes: item.a2aDefaultInputModes,
		a2aDefaultOutputModes: item.a2aDefaultOutputModes,
		a2aProviderName: item.a2aProviderName,
		a2aProviderUrl: item.a2aProviderUrl,
		a2aDocumentationUrl: item.a2aDocumentationUrl,
		a2aIconUrl: item.a2aIconUrl,
		a2aCapabilitiesStreaming: item.a2aCapabilitiesStreaming,
		a2aCapabilitiesPushNotifications: item.a2aCapabilitiesPushNotifications,
		state: item.state,
		Tags: item.tags,
		agentIdentifier: item.agentIdentifier,
		error: item.error,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		lastCheckedAt: item.lastCheckedAt,
		AgentPricing:
			item.Pricing.pricingType === PricingType.Fixed
				? {
						pricingType: PricingType.Fixed,
						Pricing:
							item.Pricing.FixedPricing?.Amounts.map((p) => ({
								unit: p.unit,
								amount: p.amount.toString(),
							})) ?? [],
					}
				: { pricingType: item.Pricing.pricingType },
		SmartContractWallet: item.SmartContractWallet,
		CurrentTransaction: item.CurrentTransaction
			? {
					txHash: item.CurrentTransaction.txHash,
					status: item.CurrentTransaction.status,
					confirmations: item.CurrentTransaction.confirmations,
					fees: item.CurrentTransaction.fees?.toString() ?? null,
					blockHeight: item.CurrentTransaction.blockHeight,
					blockTime: item.CurrentTransaction.blockTime,
				}
			: null,
	};
}
