// Colocated OpenAPI docs for this route area. When you add or change an
// endpoint here, update THIS file in the same PR — CI regenerates
// openapi-docs.json and fails on drift.
import {
	deleteGuardedWalletSchemaInput,
	deleteGuardedWalletSchemaOutput,
	getGuardedWalletSchemaInput,
	getGuardedWalletSchemaOutput,
	postGuardedWalletSchemaInput,
	postGuardedWalletSchemaOutput,
} from '@/routes/api/wallet/guarded/schemas';
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';

const recordExample = {
	id: 'cmg1guarded0000example',
	hotWalletId: 'cmg1hotwallet000example',
	ownerAddress: 'addr_test1_owner_base_address_example',
	quorumVkhs: ['1'.repeat(56), '2'.repeat(56), '3'.repeat(56)],
	threshold: 3,
	stateTokenName: 'a'.repeat(64),
	scriptAddress: 'addr_test1_smart_wallet_address_example',
	policyId: 'b'.repeat(56),
	exchainWalletId: 'wal_01M3P5ZM0EP8R4NCQWS7TBWZFZ',
	createdAt: new Date('2026-09-29T12:00:00Z'),
	updatedAt: new Date('2026-09-29T12:00:00Z'),
};

export function registerGuardedWalletPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	const secured = [{ [apiKeyAuth.name]: [] }];
	registry.registerPath({
		method: 'get',
		path: '/wallet/guarded',
		description:
			'Returns the guarded smart wallet bound to a Purchasing hot wallet, with its live balance and period budget read from chain. guardedWallet is null when the hot wallet is not guarded; chain is null and chainError is set when the chain read fails.',
		summary: 'Get the guarded wallet of a hot wallet. (admin access required)',
		tags: ['wallet'],
		security: secured,
		request: { query: getGuardedWalletSchemaInput.openapi({ example: { hotWalletId: recordExample.hotWalletId } }) },
		responses: {
			200: successResponse('Guarded wallet state', getGuardedWalletSchemaOutput, {
				guardedWallet: recordExample,
				chain: {
					lovelace: '200000000',
					periodLimitLovelace: '1000000000',
					spentInPeriodLovelace: '120000000',
					periodStart: new Date('2026-09-29T09:00:00Z'),
					periodLengthMs: '86400000',
					minBalanceLovelace: '5000000',
				},
				chainError: null,
			}),
			401: { description: 'Unauthorized' },
			404: { description: 'Hot wallet not found' },
		},
	});
	registry.registerPath({
		method: 'post',
		path: '/wallet/guarded',
		description:
			"Binds a Purchasing hot wallet on a V2 payment source to an Exchain quorum co-signed smart wallet the owner minted. The node derives the script from the owner address, quorum and threshold, requires exactly one state-token UTxO at it, and requires the datum's agent to be the hot wallet key. From then on the batch job locks that hot wallet's purchases from the smart wallet, and only with the quorum's co-signature. Pass exchainWalletId for a wallet already registered with Exchain, or register to register it now (the mandate's daily limit must equal the on-chain period limit).",
		summary: 'Attach a guarded smart wallet to a hot wallet. (admin access required)',
		tags: ['wallet'],
		security: secured,
		request: {
			body: {
				description: 'The smart wallet parameters and its Exchain registration',
				content: {
					'application/json': {
						schema: postGuardedWalletSchemaInput.openapi({
							example: {
								hotWalletId: recordExample.hotWalletId,
								ownerAddress: recordExample.ownerAddress,
								quorumVkhs: recordExample.quorumVkhs,
								threshold: 3,
								stateTokenName: recordExample.stateTokenName,
								exchainWalletId: recordExample.exchainWalletId,
							},
						}),
					},
				},
			},
		},
		responses: {
			200: successResponse('Guarded wallet attached', postGuardedWalletSchemaOutput, {
				...recordExample,
				mandateEnglish: null,
			}),
			400: { description: 'Not a Purchasing wallet on a V2 source, or the mandate does not match the chain' },
			401: { description: 'Unauthorized' },
			404: { description: 'Hot wallet not found' },
			409: { description: 'Already guarded, or the smart wallet does not verify on chain' },
			502: { description: 'Exchain refused or could not be reached' },
			503: { description: 'Exchain co-signing is not configured on this node' },
		},
	});
	registry.registerPath({
		method: 'delete',
		path: '/wallet/guarded',
		description:
			'Unbinds the guarded smart wallet from a hot wallet. Refused while the hot wallet holds a lock or a pending transaction. The funds stay in the smart wallet (the owner recovers them outside the node) and Exchain keeps its record.',
		summary: 'Detach a guarded smart wallet. (admin access required)',
		tags: ['wallet'],
		security: secured,
		request: {
			body: {
				description: 'The hot wallet to detach',
				content: {
					'application/json': {
						schema: deleteGuardedWalletSchemaInput.openapi({ example: { hotWalletId: recordExample.hotWalletId } }),
					},
				},
			},
		},
		responses: {
			200: successResponse('Guarded wallet detached', deleteGuardedWalletSchemaOutput, recordExample),
			401: { description: 'Unauthorized' },
			404: { description: 'Hot wallet not found or not guarded' },
			409: { description: 'The hot wallet is busy with a transaction' },
		},
	});
}
