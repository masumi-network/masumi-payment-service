import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { z } from '@/utils/zod-openapi';
import { RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { DEFAULTS } from '@/utils/config';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { buildManagedHolderWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { normalizeRequestedRegistryFundingLovelace } from '@/services/registry/shared';
import {
	deleteInboxAgentRegistrationSchemaInput,
	deleteInboxAgentRegistrationSchemaOutput,
	FilterStatus,
	queryRegistryInboxCountSchemaInput,
	queryRegistryInboxCountSchemaOutput,
	queryRegistryInboxRequestSchemaInput,
	queryRegistryInboxRequestSchemaOutput,
	registerInboxAgentSchemaInput,
	registerInboxAgentSchemaOutput,
	registryInboxRequestOutputSchema,
} from './schemas';
import { getInboxRegistryEntriesForQuery } from './queries';
import { serializeInboxRegistryEntriesResponse, serializeInboxRegistryEntry } from './serializers';
import { isReservedInboxSlug, normalizeInboxSlug } from '@/utils/inbox-slug';
import { resolveScopedRecipientWalletOrThrow, resolveScopedSellingWalletOrThrow } from '../registry/shared';

export {
	deleteInboxAgentRegistrationSchemaInput,
	deleteInboxAgentRegistrationSchemaOutput,
	FilterStatus,
	queryRegistryInboxCountSchemaInput,
	queryRegistryInboxCountSchemaOutput,
	queryRegistryInboxRequestSchemaInput,
	queryRegistryInboxRequestSchemaOutput,
	registerInboxAgentSchemaInput,
	registerInboxAgentSchemaOutput,
	registryInboxRequestOutputSchema,
};

function validateCanonicalInboxSlug(agentSlug: string) {
	if (agentSlug.trim() !== agentSlug) {
		throw createHttpError(400, 'agentSlug must not contain leading or trailing whitespace');
	}

	const normalizedSlug = normalizeInboxSlug(agentSlug);
	if (!normalizedSlug) {
		throw createHttpError(400, 'agentSlug is required');
	}
	if (normalizedSlug !== agentSlug) {
		throw createHttpError(400, 'agentSlug must already be canonical');
	}
	if (isReservedInboxSlug(agentSlug)) {
		throw createHttpError(400, 'agentSlug is reserved');
	}

	return normalizedSlug;
}

export const queryRegistryInboxRequestGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: queryRegistryInboxRequestSchemaInput,
	output: queryRegistryInboxRequestSchemaOutput,
	handler: async ({
		input,
		ctx,
	}: {
		input: z.infer<typeof queryRegistryInboxRequestSchemaInput>;
		ctx: AuthContext;
	}) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);
		const result = await getInboxRegistryEntriesForQuery(input, ctx.walletScopeIds);

		return serializeInboxRegistryEntriesResponse(result);
	},
});

export const queryRegistryInboxCountGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: queryRegistryInboxCountSchemaInput,
	output: queryRegistryInboxCountSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof queryRegistryInboxCountSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const total = await prisma.inboxAgentRegistrationRequest.count({
			where: {
				PaymentSource: {
					network: input.network,
					deletedAt: null,
					smartContractAddress: input.filterSmartContractAddress ?? undefined,
				},
				SmartContractWallet: { deletedAt: null },
				...buildManagedHolderWalletScopeFilter(ctx.walletScopeIds),
			},
		});

		return {
			total,
		};
	},
});

export const registerInboxAgentPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: registerInboxAgentSchemaInput,
	output: registerInboxAgentSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof registerInboxAgentSchemaInput>; ctx: AuthContext }) => {
		const startTime = Date.now();
		try {
			await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

			const sellingWallet = await resolveScopedSellingWalletOrThrow({
				network: input.network,
				sellingWalletVkey: input.sellingWalletVkey,
				walletScopeIds: ctx.walletScopeIds,
				metricPath: '/api/v1/inbox-agents',
				operation: 'register_inbox_agent',
			});
			const sendFundingLovelace = normalizeRequestedRegistryFundingLovelace(input.sendFundingLovelace);
			const normalizedAgentSlug = validateCanonicalInboxSlug(input.agentSlug);
			const recipientWallet = await resolveScopedRecipientWalletOrThrow({
				network: input.network,
				recipientWalletAddress: input.recipientWalletAddress,
				sellingWallet,
				walletScopeIds: ctx.walletScopeIds,
				metricPath: '/api/v1/inbox-agents',
				operation: 'register_inbox_agent',
			});

			const result = await prisma.inboxAgentRegistrationRequest.create({
				data: {
					name: input.name,
					description: input.description,
					agentSlug: normalizedAgentSlug,
					sendFundingLovelace,
					state: RegistrationState.RegistrationRequested,
					agentIdentifier: null,
					metadataVersion: DEFAULTS.DEFAULT_METADATA_VERSION,
					SmartContractWallet: {
						connect: {
							id: sellingWallet.id,
						},
					},
					RecipientWallet:
						recipientWallet != null
							? {
									connect: {
										id: recipientWallet.id,
									},
								}
							: undefined,
					PaymentSource: {
						connect: {
							id: sellingWallet.paymentSourceId,
						},
					},
				},
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

			return serializeInboxRegistryEntry(result);
		} catch (error: unknown) {
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			recordBusinessEndpointError('/api/v1/inbox-agents', 'POST', statusCode, errorInstance, {
				network: input.network,
				user_id: ctx.id,
				agent_name: input.name,
				operation: 'register_inbox_agent',
				duration: Date.now() - startTime,
			});

			throw error;
		}
	},
});

export const deleteInboxAgentRegistration = adminAuthenticatedEndpointFactory.build({
	method: 'delete',
	input: deleteInboxAgentRegistrationSchemaInput,
	output: deleteInboxAgentRegistrationSchemaOutput,
	handler: async ({ input }) => {
		const startTime = Date.now();
		try {
			const registrationRequest = await prisma.inboxAgentRegistrationRequest.findUnique({
				where: {
					id: input.id,
				},
				include: {
					PaymentSource: {
						select: {
							id: true,
							network: true,
							policyId: true,
							smartContractAddress: true,
						},
					},
				},
			});

			if (!registrationRequest) {
				recordBusinessEndpointError('/api/v1/inbox-agents', 'DELETE', 404, 'Inbox registration not found', {
					registry_id: input.id,
					operation: 'delete_inbox_agent_registration',
					step: 'registry_lookup',
				});
				throw createHttpError(404, 'Inbox registration not found');
			}

			const validStatesForDeletion: RegistrationState[] = [
				RegistrationState.RegistrationFailed,
				RegistrationState.DeregistrationConfirmed,
			];

			if (!validStatesForDeletion.includes(registrationRequest.state)) {
				recordBusinessEndpointError(
					'/api/v1/inbox-agents',
					'DELETE',
					400,
					`Inbox registration cannot be deleted in its current state: ${registrationRequest.state}`,
					{
						registry_id: input.id,
						operation: 'delete_inbox_agent_registration',
						step: 'state_validation',
						current_state: registrationRequest.state,
						valid_states: validStatesForDeletion.join(', '),
					},
				);
				throw createHttpError(
					400,
					`Inbox registration cannot be deleted in its current state: ${registrationRequest.state}`,
				);
			}

			const item = await prisma.inboxAgentRegistrationRequest.delete({
				where: {
					id: registrationRequest.id,
				},
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

			return serializeInboxRegistryEntry(item);
		} catch (error: unknown) {
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			recordBusinessEndpointError('/api/v1/inbox-agents', 'DELETE', statusCode, errorInstance, {
				registry_id: input.id,
				operation: 'delete_inbox_agent_registration',
				duration: Date.now() - startTime,
			});

			throw error;
		}
	},
});
