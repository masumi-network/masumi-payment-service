import { Network } from '@/generated/prisma/client';
import {
	deleteInboxAgentRegistrationSchemaInput,
	deleteInboxAgentRegistrationSchemaOutput,
	queryRegistryInboxCountSchemaInput,
	queryRegistryInboxCountSchemaOutput,
	queryRegistryInboxRequestSchemaInput,
	queryRegistryInboxRequestSchemaOutput,
	registerInboxAgentSchemaInput,
	registerInboxAgentSchemaOutput,
} from '@/routes/api/registry-inbox/schemas';
import { queryRegistryInboxDiffSchemaInput } from '@/routes/api/registry-inbox/diff';
import {
	queryInboxAgentFromWalletSchemaInput,
	queryInboxAgentFromWalletSchemaOutput,
} from '@/routes/api/registry-inbox/wallet';
import {
	queryInboxAgentByIdentifierSchemaInput,
	queryInboxAgentByIdentifierSchemaOutput,
} from '@/routes/api/registry-inbox/agent-identifier';
import {
	unregisterInboxAgentSchemaInput,
	unregisterInboxAgentSchemaOutput,
} from '@/routes/api/registry-inbox/deregister';
import { registryInboxEntryExample } from '@/routes/api/registry-inbox/examples';
import { successResponse, type SwaggerRegistrarContext } from '../shared';

export function registerRegistryInboxSupportPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	registry.registerPath({
		method: 'get',
		path: '/inbox-agents/wallet',
		description: 'Gets the inbox agent metadata.',
		summary:
			'Fetch all inbox agents (and their full metadata) that are registered to a specified wallet. (READ access required)',
		tags: ['inbox-agents'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: queryInboxAgentFromWalletSchemaInput.openapi({
				example: {
					walletVkey: 'wallet_vkey',
					network: Network.Preprod,
				},
			}),
		},
		responses: {
			200: successResponse('Inbox agent metadata', queryInboxAgentFromWalletSchemaOutput, {
				Assets: [
					{
						policyId: 'policy_id',
						assetName: 'asset_name',
						agentIdentifier: 'agent_identifier',
						Metadata: {
							name: 'Inbox Agent',
							description: 'Masumi inbox identity registration',
							agentSlug: 'inbox-agent',
							metadataVersion: 1,
						},
					},
				],
			}),
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/inbox-agents/agent-identifier',
		description: 'Gets the on-chain metadata for a specific inbox agent by its identifier.',
		summary: 'Fetch the current metadata for a given inbox agentIdentifier. (READ access required)',
		tags: ['inbox-agents'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: queryInboxAgentByIdentifierSchemaInput.openapi({
				example: {
					agentIdentifier: 'policy_id_56_chars_hex_asset_name_hex',
					network: Network.Preprod,
				},
			}),
		},
		responses: {
			200: successResponse('Inbox agent metadata retrieved successfully', queryInboxAgentByIdentifierSchemaOutput, {
				policyId: 'policy_id',
				assetName: 'asset_name',
				agentIdentifier: 'policy_id_asset_name',
				Metadata: {
					name: 'Inbox Agent',
					description: 'Masumi inbox identity registration',
					agentSlug: 'inbox-agent',
					metadataVersion: 1,
				},
			}),
			400: { description: 'Bad Request (agent identifier is not a valid hex string)' },
			401: { description: 'Unauthorized' },
			404: { description: 'Agent identifier not found or network/policyId combination not supported' },
			422: { description: 'Inbox agent metadata is invalid or malformed' },
			500: { description: 'Internal Server Error' },
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/inbox-agents',
		description: 'Gets the inbox agent metadata.',
		summary: 'List every inbox agent that is recorded in the Masumi registry inbox. (READ access required)',
		tags: ['inbox-agents'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: queryRegistryInboxRequestSchemaInput.openapi({
				example: {
					network: Network.Preprod,
					cursorId: 'cursor_id',
				},
			}),
		},
		responses: {
			200: successResponse('Inbox agent metadata', queryRegistryInboxRequestSchemaOutput, {
				Assets: [registryInboxEntryExample],
			}),
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/inbox-agents/diff',
		description:
			'Returns inbox registry entries that changed since the provided timestamp (registrationStateLastChangedAt).',
		summary: 'Diff inbox registry entries by state-change timestamp (READ access required)',
		tags: ['inbox-agents'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: queryRegistryInboxDiffSchemaInput.openapi({
				example: {
					limit: 10,
					cursorId: 'cursor_id',
					lastUpdate: new Date(1713636260).toISOString(),
					network: Network.Preprod,
				},
			}),
		},
		responses: {
			200: successResponse('Inbox agent metadata diff', queryRegistryInboxRequestSchemaOutput, {
				Assets: [registryInboxEntryExample],
			}),
			400: { description: 'Bad Request (possible parameters missing or invalid)' },
			401: { description: 'Unauthorized' },
			500: { description: 'Internal Server Error' },
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/inbox-agents',
		description:
			'Registers an inbox agent to the registry (Please note that while it is put on-chain, the transaction is not yet finalized by the blockchain.)',
		summary: 'Registers an inbox agent to the registry (+PAY access required)',
		tags: ['inbox-agents'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: registerInboxAgentSchemaInput.openapi({
							example: {
								network: Network.Preprod,
								sellingWalletVkey: 'wallet_vkey',
								recipientWalletAddress: 'recipient_wallet_address',
								sendFundingLovelace: '7500000',
								name: 'Inbox Agent',
								description: 'Masumi inbox identity registration',
								agentSlug: 'inbox-agent',
							},
						}),
					},
				},
			},
		},
		responses: {
			200: successResponse('Inbox agent registered', registerInboxAgentSchemaOutput, registryInboxEntryExample),
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/inbox-agents/deregister',
		description:
			'Deregisters an inbox agent from the specified registry (Please note that while the command is put on-chain, the transaction is not yet finalized by the blockchain.)',
		summary: 'Deregisters an inbox agent from the specified registry. (PAY access required)',
		tags: ['inbox-agents'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: unregisterInboxAgentSchemaInput.openapi({
							example: {
								agentIdentifier: 'agentIdentifier',
								network: Network.Preprod,
							},
						}),
					},
				},
			},
		},
		responses: {
			200: successResponse(
				'Inbox agent deregistration requested',
				unregisterInboxAgentSchemaOutput,
				registryInboxEntryExample,
			),
		},
	});

	registry.registerPath({
		method: 'delete',
		path: '/inbox-agents',
		description:
			'Permanently deletes an inbox registration record from the database. This action is irreversible and should only be used for registrations in specific failed or completed states.',
		summary: 'Delete an inbox registration record. (admin access required)',
		tags: ['inbox-agents'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: '',
				content: {
					'application/json': {
						schema: deleteInboxAgentRegistrationSchemaInput.openapi({
							example: {
								id: 'example_id',
							},
						}),
					},
				},
			},
		},
		responses: {
			200: successResponse(
				'Inbox agent registration deleted successfully',
				deleteInboxAgentRegistrationSchemaOutput,
				registryInboxEntryExample,
			),
		},
	});

	registry.registerPath({
		method: 'get',
		path: '/inbox-agents/count',
		description: 'Counts all inbox agents in the registry.',
		summary: 'Count every inbox agent that is recorded in the Masumi registry inbox. (READ access required)',
		tags: ['inbox-agents'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			query: queryRegistryInboxCountSchemaInput.openapi({
				example: {
					network: Network.Preprod,
				},
			}),
		},
		responses: {
			200: successResponse('Count returned', queryRegistryInboxCountSchemaOutput, { total: 42 }),
		},
	});
}
