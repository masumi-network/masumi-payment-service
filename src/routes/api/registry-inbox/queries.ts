import { RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { AuthContext } from '@/utils/middleware/auth-middleware';
import { buildWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { z } from '@/utils/zod-openapi';
import { FilterStatus, queryRegistryInboxRequestSchemaInput } from './schemas';

export type InboxRegistryListQueryInput = z.infer<typeof queryRegistryInboxRequestSchemaInput>;

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

export async function getInboxRegistryEntriesForQuery(
	input: InboxRegistryListQueryInput,
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

	return prisma.inboxAgentRegistrationRequest.findMany({
		where: {
			PaymentSource: {
				network: input.network,
				deletedAt: null,
				smartContractAddress: input.filterSmartContractAddress ?? undefined,
			},
			SmartContractWallet: { deletedAt: null },
			...buildWalletScopeFilter(walletScopeIds),
			...(stateFilter ? { state: { in: stateFilter } } : {}),
			...(searchLower
				? {
						OR: [
							{ name: { contains: searchLower, mode: 'insensitive' as const } },
							{ description: { contains: searchLower, mode: 'insensitive' as const } },
							{ agentSlug: { contains: searchLower, mode: 'insensitive' as const } },
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
		},
	});
}

export type InboxRegistryListRecord = Awaited<ReturnType<typeof getInboxRegistryEntriesForQuery>>[number];
