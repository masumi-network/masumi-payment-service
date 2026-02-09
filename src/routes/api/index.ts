import { Routing } from 'express-zod-api';
import { healthEndpointGet } from '@/routes/api/health';
import {
	queryAPIKeyEndpointGet as queryCentralizedRegistrySourceGet,
	addAPIKeyEndpointPost as addCentralizedRegistrySourceEndpointPost,
	updateAPIKeyEndpointPatch,
	deleteAPIKeyEndpointDelete,
} from './api-key';
import { createPurchaseInitPost, queryPurchaseRequestGet } from './purchases';
import { postPurchaseSpending } from './purchases/spending';
import { paymentInitPost, queryPaymentEntryGet } from './payments';
import { getPaymentIncome } from './payments/income';
import { deleteAgentRegistration, queryRegistryRequestGet, registerAgentPost } from './registry';
import {
	paymentSourceExtendedEndpointDelete,
	paymentSourceExtendedEndpointGet,
	paymentSourceExtendedEndpointPatch,
	paymentSourceExtendedEndpointPost,
} from './payment-source-extended';
import { queryAPIKeyStatusEndpointGet } from './api-key-status';
import { patchWalletEndpointPatch, postWalletEndpointPost, queryWalletEndpointGet } from './wallet';
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
import { revealDataEndpointPost } from './reveal-data';
import { paymentErrorStateRecoveryPost } from './payments/error-state-recovery';
import { purchaseErrorStateRecoveryPost } from './purchases/error-state-recovery';
import { queryRegistryDiffGet } from './registry/diff';
import { queryAgentByIdentifierGet } from './registry/agent-identifier';
import { registerWebhookPost, listWebhooksGet, deleteWebhookDelete } from './webhooks';
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

export const apiRouter: Routing = {
	v1: {
		'reveal-data': {
			post: revealDataEndpointPost,
		},
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
		},
		payment: {
			get: queryPaymentEntryGet,
			post: paymentInitPost,
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
		webhooks: {
			get: listWebhooksGet,
			post: registerWebhookPost,
			delete: deleteWebhookDelete,
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
