import { PricingType, RegistrationState } from '@/generated/prisma/client';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { AuthContext } from '@masumi/payment-core/auth';
import { parseAmountSearchRange } from '@/utils/shared/queries';
import { buildManagedHolderWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { z } from '@masumi/payment-core/zod';
import { FilterStatus, queryRegistryRequestSchemaInput } from './schemas';

export type RegistryListQueryInput = z.infer<typeof queryRegistryRequestSchemaInput>;

function buildRegistryStateFilter(filterStatus?: FilterStatus): RegistrationState[] | undefined {
	if (filterStatus === FilterStatus.Registered) {
		// UpdateConfirmed represents an in-place version bump that left a
		// fresh asset on chain, so it stays in the Registered bucket. Mid-
		// flight UpdateRequested/Initiated rows fall into Pending (see
		// below) because their on-chain state is not yet committed.
		return [RegistrationState.RegistrationConfirmed, RegistrationState.UpdateConfirmed];
	}

	if (filterStatus === FilterStatus.Deregistered) {
		return [RegistrationState.DeregistrationConfirmed];
	}

	if (filterStatus === FilterStatus.Pending) {
		return [
			RegistrationState.RegistrationRequested,
			RegistrationState.DeregistrationRequested,
			RegistrationState.UpdateRequested,
			RegistrationState.UpdateInitiated,
		];
	}

	if (filterStatus === FilterStatus.Failed) {
		return [
			RegistrationState.RegistrationFailed,
			RegistrationState.DeregistrationFailed,
			RegistrationState.UpdateFailed,
		];
	}

	return undefined;
}

export async function getRegistryEntriesForQuery(
	input: RegistryListQueryInput,
	walletScopeIds: AuthContext['walletScopeIds'],
) {
	const stateFilter = buildRegistryStateFilter(input.filterStatus);
	const searchLower = input.searchQuery?.toLowerCase();
	const matchingStates = searchLower
		? Object.values(RegistrationState).filter(
				(state) =>
					state.toLowerCase().includes(searchLower) ||
					state
						.replace(/([A-Z])/g, ' $1')
						.trim()
						.toLowerCase()
						.includes(searchLower),
			)
		: undefined;
	const amountFilter: { gte: bigint; lte: bigint } | undefined = searchLower
		? parseAmountSearchRange(searchLower)
		: undefined;

	// Optional server-side "advertises this payment source" filter. The frontend
	// AI Agents page needs agents that accept a given Cardano source (by address)
	// or x402 EVM chain (by CAIP-2 network) as a PAYMENT target, regardless of
	// where they are registered. Without this it had to page every agent on the
	// network and match `supportedPaymentSources` client-side. Address and
	// networks are OR-ed so a single `some` row matching either qualifies.
	const supportedNetworks = input.filterSupportedPaymentSourceNetworks
		?.split(',')
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	const supportedPaymentSourceOr: Prisma.SupportedPaymentSourceWhereInput[] = [
		...(input.filterSupportedPaymentSourceAddress ? [{ address: input.filterSupportedPaymentSourceAddress }] : []),
		...(supportedNetworks && supportedNetworks.length > 0 ? [{ network: { in: supportedNetworks } }] : []),
	];

	return prisma.registryRequest.findMany({
		where: {
			PaymentSource: {
				network: input.network,
				deletedAt: null,
				smartContractAddress: input.filterSmartContractAddress ?? undefined,
				paymentSourceType: input.filterPaymentSourceType,
			},
			SmartContractWallet: { deletedAt: null },
			...buildManagedHolderWalletScopeFilter(walletScopeIds),
			...(stateFilter ? { state: { in: stateFilter } } : {}),
			...(input.filterAgentIdentifier ? { agentIdentifier: input.filterAgentIdentifier } : {}),
			...(supportedPaymentSourceOr.length > 0
				? { SupportedPaymentSources: { some: { OR: supportedPaymentSourceOr } } }
				: {}),
			...(searchLower
				? {
						OR: [
							{
								name: {
									contains: searchLower,
									mode: 'insensitive' as const,
								},
							},
							{
								description: {
									contains: searchLower,
									mode: 'insensitive' as const,
								},
							},
							{ tags: { hasSome: [searchLower] } },
							{
								SmartContractWallet: {
									walletAddress: {
										contains: searchLower,
										mode: 'insensitive' as const,
									},
								},
							},
							{
								RecipientWallet: {
									is: {
										walletAddress: {
											contains: searchLower,
											mode: 'insensitive' as const,
										},
									},
								},
							},
							...(matchingStates && matchingStates.length > 0 ? [{ state: { in: matchingStates } }] : []),
							...('free'.startsWith(searchLower) ? [{ Pricing: { pricingType: PricingType.Free } }] : []),
							...('dynamic'.startsWith(searchLower) ? [{ Pricing: { pricingType: PricingType.Dynamic } }] : []),
							...(amountFilter
								? [
										{
											Pricing: {
												FixedPricing: {
													Amounts: {
														some: { amount: { gte: amountFilter.gte, lte: amountFilter.lte } },
													},
												},
											},
										},
									]
								: []),
						],
					}
				: {}),
		},
		orderBy: { createdAt: 'desc' },
		take: input.limit,
		cursor: input.cursorId ? { id: input.cursorId } : undefined,
		include: {
			SmartContractWallet: {
				select: { walletVkey: true, walletAddress: true },
			},
			RecipientWallet: {
				select: { walletVkey: true, walletAddress: true },
			},
			CurrentTransaction: {
				select: {
					txHash: true,
					status: true,
					confirmations: true,
					fees: true,
					blockHeight: true,
					blockTime: true,
				},
			},
			Pricing: {
				include: {
					FixedPricing: {
						include: { Amounts: { select: { unit: true, amount: true } } },
					},
				},
			},
			ExampleOutputs: {
				select: {
					name: true,
					url: true,
					mimeType: true,
				},
			},
			Verifications: true,
			SupportedPaymentSources: {
				select: {
					chain: true,
					network: true,
					paymentSourceType: true,
					address: true,
					scheme: true,
					asset: true,
					amount: true,
					decimals: true,
					payTo: true,
					resource: true,
					extra: true,
				},
			},
		},
	});
}

export type RegistryListRecord = Awaited<ReturnType<typeof getRegistryEntriesForQuery>>[number];
