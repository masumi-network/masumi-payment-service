import { Routing } from 'express-zod-api';
import { healthEndpointGet } from '@/routes/api/health';
import {
	queryAPIKeyEndpointGet as queryCentralizedRegistrySourceGet,
	addAPIKeyEndpointPost as addCentralizedRegistrySourceEndpointPost,
	updateAPIKeyEndpointPatch,
	deleteAPIKeyEndpointDelete,
} from './api-key';
import { createPurchaseInitPost, queryPurchaseCountGet, queryPurchaseRequestGet } from './purchases';
import { postPurchaseSpending } from './purchases/spending';
import { paymentInitPost, queryPaymentCountGet, queryPaymentEntryGet } from './payments';
import { buildX402TxPost } from './payments/x402';
import { getPaymentIncome } from './payments/income';
import { deleteAgentRegistration, queryRegistryCountGet, queryRegistryRequestGet, registerAgentPost } from './registry';
import { queryA2ARegistryRequestGet, registerA2AAgentPost } from './registry/a2a';
import {
	paymentSourceExtendedEndpointDelete,
	paymentSourceExtendedEndpointGet,
	paymentSourceExtendedEndpointPatch,
	paymentSourceExtendedEndpointPost,
} from './payment-source-extended';
import { queryAPIKeyStatusEndpointGet } from './api-key-status';
import { patchWalletEndpointPatch, postWalletEndpointPost, queryWalletEndpointGet } from './wallet';
import {
	deleteWalletLowBalanceRuleEndpointDelete,
	getWalletLowBalanceRulesEndpointGet,
	patchWalletLowBalanceRuleEndpointPatch,
	postWalletLowBalanceRuleEndpointPost,
} from './wallet/low-balance';
import { queryRpcProviderKeysEndpointGet } from './rpc-api-keys';
import { queryUTXOEndpointGet } from './utxos';
import { paymentSourceEndpointGet } from './payment-source';
import { submitPaymentResultEndpointPost } from './payments/submit-result';
import { authorizePaymentRefundEndpointPost } from './payments/authorize-refund';
import { requestPurchaseRefundPost } from './purchases/request-refund';
import { cancelPurchaseRefundRequestPost } from './purchases/cancel-refund-request';
import { queryAgentFromWalletGet } from './registry/wallet';
import { resolvePaymentRequestPost } from './payments/resolve-blockchain-identifier';
import { resolvePurchaseRequestPost } from './purchases/resolve-blockchain-identifier';
import { unregisterAgentPost } from './registry/deregister';
import { revealDataEndpointPost } from './signature/verify/reveal-data';
import { postMonthlySignatureEndpoint } from './signature/sign/create-invoice/monthly';
import { getMonthlyInvoiceListEndpoint, postGenerateMonthlyInvoiceEndpoint } from './invoice/monthly';
import { postInternalGenerateMonthlyInvoiceEndpoint } from './invoice/monthly/internal';
import { getMissingInvoicePaymentsEndpoint as getMissingPaymentsEndpoint } from './invoice/monthly/missing';
import { paymentErrorStateRecoveryPost } from './payments/error-state-recovery';
import { purchaseErrorStateRecoveryPost } from './purchases/error-state-recovery';
import { queryRegistryDiffGet } from './registry/diff';
import { queryAgentByIdentifierGet } from './registry/agent-identifier';
import {
	registerWebhookPost,
	listWebhooksGet,
	deleteWebhookDelete,
	patchWebhookPatch,
	testWebhookPost,
} from './webhooks';
import {
	queryPaymentDiffCombinedGet,
	queryPaymentDiffNextActionGet,
	queryPaymentDiffOnChainStateOrResultGet,
} from './payments/diff';
import {
	queryPurchaseDiffCombinedGet,
	queryPurchaseDiffNextActionGet,
	queryPurchaseDiffOnChainStateOrResultGet,
} from './purchases/diff';
import { getMonitoringStatus, triggerMonitoringCycle, startMonitoring, stopMonitoring } from './monitoring';
import {
	swapTokensEndpointPost,
	getSwapConfirmEndpointGet,
	getSwapTransactionsEndpointGet,
	getSwapEstimateEndpointGet,
	cancelSwapEndpointPost,
	acknowledgeSwapTimeoutEndpointPost,
} from './swap';

export const apiRouter: Routing = {
	v1: {
		health: healthEndpointGet,
		purchase: {
			get: queryPurchaseRequestGet,
			post: createPurchaseInitPost,
			diff: {
				get: queryPurchaseDiffCombinedGet,
				'next-action': {
					get: queryPurchaseDiffNextActionGet,
				},
				'onchain-state-or-result': {
					get: queryPurchaseDiffOnChainStateOrResultGet,
				},
			},
			'request-refund': {
				post: requestPurchaseRefundPost,
			},
			'cancel-refund-request': {
				post: cancelPurchaseRefundRequestPost,
			},
			'resolve-blockchain-identifier': {
				post: resolvePurchaseRequestPost,
			},
			'error-state-recovery': {
				post: purchaseErrorStateRecoveryPost,
			},
			spending: {
				post: postPurchaseSpending,
			},
			count: {
				get: queryPurchaseCountGet,
			},
		},
		payment: {
			get: queryPaymentEntryGet,
			post: paymentInitPost,
			x402: {
				post: buildX402TxPost,
			},
			diff: {
				get: queryPaymentDiffCombinedGet,
				'next-action': {
					get: queryPaymentDiffNextActionGet,
				},
				'onchain-state-or-result': {
					get: queryPaymentDiffOnChainStateOrResultGet,
				},
			},
			'authorize-refund': {
				post: authorizePaymentRefundEndpointPost,
			},
			'submit-result': {
				post: submitPaymentResultEndpointPost,
			},
			'resolve-blockchain-identifier': {
				post: resolvePaymentRequestPost,
			},
			'error-state-recovery': {
				post: paymentErrorStateRecoveryPost,
			},
			income: {
				post: getPaymentIncome,
			},
			count: {
				get: queryPaymentCountGet,
			},
		},
		registry: {
			get: queryRegistryRequestGet,
			post: registerAgentPost,
			delete: deleteAgentRegistration,
			diff: {
				get: queryRegistryDiffGet,
			},
			wallet: {
				get: queryAgentFromWalletGet,
			},
			deregister: {
				post: unregisterAgentPost,
			},
			'agent-identifier': {
				get: queryAgentByIdentifierGet,
			},
			count: {
				get: queryRegistryCountGet,
			},
			a2a: {
				get: queryA2ARegistryRequestGet,
				post: registerA2AAgentPost,
			},
		},
		'api-key-status': {
			get: queryAPIKeyStatusEndpointGet,
		},
		'api-key': {
			get: queryCentralizedRegistrySourceGet,
			post: addCentralizedRegistrySourceEndpointPost,
			patch: updateAPIKeyEndpointPatch,
			delete: deleteAPIKeyEndpointDelete,
		},
		wallet: {
			get: queryWalletEndpointGet,
			post: postWalletEndpointPost,
			patch: patchWalletEndpointPatch,
			'low-balance': {
				get: getWalletLowBalanceRulesEndpointGet,
				post: postWalletLowBalanceRuleEndpointPost,
				patch: patchWalletLowBalanceRuleEndpointPatch,
				delete: deleteWalletLowBalanceRuleEndpointDelete,
			},
		},
		'payment-source-extended': {
			get: paymentSourceExtendedEndpointGet,
			post: paymentSourceExtendedEndpointPost,
			patch: paymentSourceExtendedEndpointPatch,
			delete: paymentSourceExtendedEndpointDelete,
		},
		'rpc-api-keys': {
			get: queryRpcProviderKeysEndpointGet,
		},
		utxos: {
			get: queryUTXOEndpointGet,
		},
		'payment-source': {
			get: paymentSourceEndpointGet,
		},
		swap: {
			post: swapTokensEndpointPost,
			confirm: getSwapConfirmEndpointGet,
			cancel: {
				post: cancelSwapEndpointPost,
			},
			'acknowledge-timeout': {
				post: acknowledgeSwapTimeoutEndpointPost,
			},
			transactions: {
				get: getSwapTransactionsEndpointGet,
			},
			estimate: getSwapEstimateEndpointGet,
		},
		invoice: {
			monthly: {
				get: getMonthlyInvoiceListEndpoint,
				post: postGenerateMonthlyInvoiceEndpoint,
				internal: {
					post: postInternalGenerateMonthlyInvoiceEndpoint,
				},
				missing: {
					get: getMissingPaymentsEndpoint,
				},
			},
		},
		signature: {
			verify: {
				'reveal-data': {
					post: revealDataEndpointPost,
				},
			},
			sign: {
				'create-invoice': {
					monthly: {
						post: postMonthlySignatureEndpoint,
					},
				},
			},
		},
		webhooks: {
			get: listWebhooksGet,
			post: registerWebhookPost,
			patch: patchWebhookPatch,
			delete: deleteWebhookDelete,
			test: {
				post: testWebhookPost,
			},
		},
		monitoring: {
			get: getMonitoringStatus,
			'trigger-cycle': {
				post: triggerMonitoringCycle,
			},
			start: {
				post: startMonitoring,
			},
			stop: {
				post: stopMonitoring,
			},
		},
	},
};
