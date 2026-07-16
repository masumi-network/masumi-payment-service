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
	warningThreshold: '50000000',
	criticalThreshold: '20000000',
	topupAmount: '100000000',
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
			'Gets the fund wallet for a payment source, with its distribution configuration and low-balance summary. Look it up by its own id or by payment source id — a payment source has at most one fund wallet.',
		summary: 'Get the fund wallet of a payment source. (admin access required)',
		tags: ['fund-wallet'],
		security: secured,
		request: { query: getFundWalletSchemaInput.openapi({ example: { paymentSourceId: 'cuid_v2_auto_generated' } }) },
		responses: {
			200: successResponse('Fund wallet', getFundWalletSchemaOutput, fundWalletExample),
			400: { description: 'Neither id nor paymentSourceId was provided' },
			401: { description: 'Unauthorized' },
			404: { description: 'Fund wallet not found' },
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/fund-wallet',
		description:
			'Creates a fund wallet for a payment source from an existing mnemonic and enables automatic distribution. The wallet tops up the Selling and Purchasing wallets of that same payment source when they fall below the configured thresholds: below warningThreshold the topup is batched, below criticalThreshold it is sent immediately. Fund the returned address before distribution can do anything. A payment source can have only one fund wallet, and because wallet key hashes are globally unique a mnemonic can only ever back one wallet — so each payment source needs its own.',
		summary: 'Create a fund wallet for a payment source. (admin access required)',
		tags: ['fund-wallet'],
		security: secured,
		request: {
			body: {
				description: 'Fund wallet mnemonic and distribution thresholds',
				content: {
					'application/json': {
						schema: postFundWalletSchemaInput.openapi({
							example: {
								paymentSourceId: 'cuid_v2_auto_generated',
								walletMnemonic: 'word1 word2 word3 ... word24',
								warningThreshold: '50000000',
								criticalThreshold: '20000000',
								topupAmount: '100000000',
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
			400: { description: 'criticalThreshold is not below warningThreshold, or the mnemonic yields no address' },
			401: { description: 'Unauthorized' },
			404: { description: 'Payment source not found' },
			409: { description: 'The payment source already has a fund wallet, or this mnemonic already backs a wallet' },
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
								warningThreshold: '60000000',
								criticalThreshold: '25000000',
								topupAmount: '120000000',
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
			400: { description: 'criticalThreshold is not below warningThreshold' },
			401: { description: 'Unauthorized' },
			404: { description: 'Fund wallet not found, or it has no distribution config' },
		},
	});

	registry.registerPath({
		method: 'delete',
		path: '/fund-wallet',
		description:
			'Soft-deletes a fund wallet, disables its distribution config and cancels any outstanding distribution requests. Does NOT move funds: withdraw the remaining balance from the wallet address first, since the mnemonic can no longer be exported through the fund-wallet API afterwards.',
		summary: 'Delete a fund wallet. (admin access required)',
		tags: ['fund-wallet'],
		security: secured,
		request: {
			body: {
				description: 'Fund wallet to delete',
				content: {
					'application/json': {
						schema: deleteFundWalletSchemaInput.openapi({ example: { id: 'cuid_v2_auto_generated' } }),
					},
				},
			},
		},
		responses: {
			200: successResponse('Fund wallet deleted', deleteFundWalletSchemaOutput, { id: 'cuid_v2_auto_generated' }),
			401: { description: 'Unauthorized' },
			404: { description: 'Fund wallet not found' },
		},
	});
}
