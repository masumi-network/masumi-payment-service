// Colocated OpenAPI docs for this route area. When you add or change an
// endpoint here, update THIS file in the same PR — CI regenerates
// openapi-docs.json and fails on drift.
import {
	deleteFundWalletSchemaInput,
	deleteFundWalletSchemaOutput,
	getFundWalletSchemaInput,
	getFundWalletSchemaOutput,
	patchFundWalletSchemaInput,
	patchFundWalletSchemaOutput,
	postFundWalletSchemaInput,
	postFundWalletSchemaOutput,
} from '@/routes/api/fund-wallet/schemas';
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';

const fundDistributionConfigExample = {
	id: 'cuid_v2_auto_generated',
	enabled: true,
	batchWindowMs: 300000,
};

const fundWalletExample = {
	id: 'cuid_v2_auto_generated',
	walletAddress: 'addr_test1...',
	walletVkey: 'a1b2c3d4e5f6...',
	note: 'Treasury for preprod V2',
	paymentSourceId: 'cuid_v2_auto_generated',
	lockedAt: null,
	LowBalanceSummary: {
		isLow: false,
		lowRuleCount: 0,
		lastCheckedAt: '2024-01-01T00:00:00.000Z',
	},
	FundDistributionConfig: fundDistributionConfigExample,
	pendingRequestCount: 0,
};

export function registerFundWalletPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	const secured = [{ [apiKeyAuth.name]: [] }];

	registry.registerPath({
		method: 'get',
		path: '/fund-wallet',
		description:
			'Lists active fund wallets with their distribution configuration and low-balance summary. Filter by payment source id to get every treasury serving that source, or by id for one wallet. An unconfigured source returns an empty FundWallets array.',
		summary: 'List fund wallets. (admin access required)',
		tags: ['fund-wallet'],
		security: secured,
		request: { query: getFundWalletSchemaInput.openapi({ example: { paymentSourceId: 'cuid_v2_auto_generated' } }) },
		responses: {
			200: successResponse('Fund wallets', getFundWalletSchemaOutput, {
				FundWallets: [fundWalletExample],
			}),
			400: { description: 'Neither id nor paymentSourceId was provided' },
			401: { description: 'Unauthorized' },
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/fund-wallet',
		description:
			'Creates an enabled fund wallet for a payment source from an existing mnemonic. A source may have several fund wallets; dispatch uses the first one with enough funds. Auto-top-up thresholds and amounts are configured on each target wallet low-balance rule, not on the treasury. Fund the returned address before distribution can run. A mnemonic can back only one active wallet at a time; deleting that wallet frees it for re-registration.',
		summary: 'Create a fund wallet for a payment source. (admin access required)',
		tags: ['fund-wallet'],
		security: secured,
		request: {
			body: {
				description: 'Fund wallet mnemonic and batch cadence',
				content: {
					'application/json': {
						schema: postFundWalletSchemaInput.openapi({
							example: {
								paymentSourceId: 'cuid_v2_auto_generated',
								walletMnemonic: 'word1 word2 word3 ... word24',
								batchWindowMs: 300000,
								note: 'Treasury for preprod V2',
							},
						}),
					},
				},
			},
		},
		responses: {
			200: successResponse('Fund wallet created', postFundWalletSchemaOutput, {
				id: 'cuid_v2_auto_generated',
				walletAddress: 'addr_test1...',
				walletVkey: 'a1b2c3d4e5f6...',
				paymentSourceId: 'cuid_v2_auto_generated',
				FundDistributionConfig: fundDistributionConfigExample,
			}),
			400: { description: 'The mnemonic is invalid or the batch window is outside its allowed range' },
			401: { description: 'Unauthorized' },
			404: { description: 'Payment source not found' },
			409: {
				description: 'The payment source became inactive, or this mnemonic already backs another active wallet',
			},
		},
	});

	registry.registerPath({
		method: 'patch',
		path: '/fund-wallet',
		description:
			'Updates the distribution configuration of a fund wallet. Set enabled to false to pause automatic distribution without deleting the wallet or its funds.',
		summary: 'Update fund wallet distribution settings. (admin access required)',
		tags: ['fund-wallet'],
		security: secured,
		request: {
			body: {
				description: 'Distribution settings to change',
				content: {
					'application/json': {
						schema: patchFundWalletSchemaInput.openapi({
							example: {
								id: 'cuid_v2_auto_generated',
								enabled: true,
								batchWindowMs: 300000,
							},
						}),
					},
				},
			},
		},
		responses: {
			200: successResponse('Fund wallet updated', patchFundWalletSchemaOutput, {
				id: 'cuid_v2_auto_generated',
				FundDistributionConfig: fundDistributionConfigExample,
			}),
			400: { description: 'The batch window is outside its allowed range' },
			401: { description: 'Unauthorized' },
			404: { description: 'Fund wallet not found, or it has no distribution config' },
		},
	});

	registry.registerPath({
		method: 'delete',
		path: '/fund-wallet',
		description:
			'Soft-deletes a fund wallet and disables its distribution config. Unclaimed source-level requests continue through another enabled fund wallet, or are cancelled when none remains. Does NOT move funds. A wallet with a broadcast or ambiguous distribution in flight cannot be deleted, even with force=true; wait for the transaction to settle first. Also refuses with 409 while the wallet still holds ADA or native assets, because deletion makes the mnemonic unexportable through the API — withdraw every asset first. Pass force=true only to skip the balance check, accepting that any remaining balance is recoverable only with direct database access.',
		summary: 'Delete a fund wallet. (admin access required)',
		tags: ['fund-wallet'],
		security: secured,
		request: {
			body: {
				description: 'Fund wallet to delete',
				content: {
					'application/json': {
						schema: deleteFundWalletSchemaInput.openapi({ example: { id: 'cuid_v2_auto_generated', force: false } }),
					},
				},
			},
		},
		responses: {
			200: successResponse('Fund wallet deleted', deleteFundWalletSchemaOutput, { id: 'cuid_v2_auto_generated' }),
			401: { description: 'Unauthorized' },
			404: { description: 'Fund wallet not found' },
			409: {
				description:
					'Fund wallet has a distribution in flight, or still holds funds. In-flight transactions must settle; balance-only conflicts can be bypassed with force=true',
			},
			503: { description: 'Balance could not be checked; retry or pass force=true' },
		},
	});
}
