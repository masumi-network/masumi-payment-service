import { PricingType, RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { AuthContext } from '@/utils/middleware/auth-middleware';
import { parseAmountSearchRange } from '@/utils/shared/queries';
import { buildManagedHolderWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { z } from '@/utils/zod-openapi';
import { FilterStatus, queryRegistryRequestSchemaInput } from './schemas';

export type RegistryListQueryInput = z.infer<typeof queryRegistryRequestSchemaInput>;

function buildRegistryStateFilter(filterStatus?: FilterStatus): RegistrationState[] | undefined {
	if (filterStatus === FilterStatus.Registered) {
		return [RegistrationState.RegistrationConfirmed];
	}

	if (filterStatus === FilterStatus.Deregistered) {
		return [RegistrationState.DeregistrationConfirmed];
	}

	if (filterStatus === FilterStatus.Pending) {
		return [RegistrationState.RegistrationRequested, RegistrationState.DeregistrationRequested];
	}

	if (filterStatus === FilterStatus.Failed) {
		return [RegistrationState.RegistrationFailed, RegistrationState.DeregistrationFailed];
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

	return prisma.registryRequest.findMany({
		where: {
			PaymentSource: {
				network: input.network,
				deletedAt: null,
				smartContractAddress: input.filterSmartContractAddress ?? undefined,
			},
			SmartContractWallet: { deletedAt: null },
			...buildManagedHolderWalletScopeFilter(walletScopeIds),
			...(stateFilter ? { state: { in: stateFilter } } : {}),
			...(input.filterAgentIdentifier ? { agentIdentifier: input.filterAgentIdentifier } : {}),
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
		},
	});
}

export type RegistryListRecord = Awaited<ReturnType<typeof getRegistryEntriesForQuery>>[number];
