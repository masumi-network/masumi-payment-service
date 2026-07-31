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
import {
	deleteInboxAgentRegistration,
	queryRegistryInboxCountGet,
	queryRegistryInboxRequestGet,
	registerInboxAgentPost,
} from './registry-inbox';
import {
	paymentSourceExtendedEndpointDelete,
	paymentSourceExtendedEndpointGet,
	paymentSourceExtendedEndpointPatch,
	paymentSourceExtendedEndpointPost,
} from './payment-source-extended';
import { queryAPIKeyStatusEndpointGet } from './api-key-status';
import {
	patchWalletEndpointPatch,
	postWalletEndpointPost,
	queryWalletEndpointGet,
	postWalletFundEndpointPost,
	getWalletFundEndpointGet,
	queryWalletListEndpointGet,
} from './wallet';
import {
	deleteWalletLowBalanceRuleEndpointDelete,
	getWalletLowBalanceRulesEndpointGet,
	patchWalletLowBalanceRuleEndpointPatch,
	postWalletLowBalanceRuleEndpointPost,
} from './wallet/low-balance';
import { queryRpcProviderKeysEndpointGet } from './rpc-api-keys';
import { queryUTXOEndpointGet } from './utxos';
import { queryBalanceEndpointGet } from './balance';
import { paymentSourceEndpointGet } from './payment-source';
import { submitPaymentResultEndpointPost } from './payments/submit-result';
import { authorizePaymentRefundEndpointPost } from './payments/authorize-refund';
import { requestPurchaseRefundPost } from './purchases/request-refund';
import { cancelPurchaseRefundRequestPost } from './purchases/cancel-refund-request';
import { queryAgentFromWalletGet } from './registry/wallet';
import { resolvePaymentRequestPost } from './payments/resolve-blockchain-identifier';
import { resolvePurchaseRequestPost } from './purchases/resolve-blockchain-identifier';
import { unregisterAgentPost } from './registry/deregister';
import { updateAgentPost } from './registry/update';
import { revealDataEndpointPost } from './signature/verify/reveal-data';
import { postMonthlySignatureEndpoint } from './signature/sign/create-invoice/monthly';
import { postVerifyAndPublishAgentSignatureEndpoint } from './signature/sign/verify-and-publish-agent';
import { getMonthlyInvoiceListEndpoint, postGenerateMonthlyInvoiceEndpoint } from './invoice/monthly';
import { postInternalGenerateMonthlyInvoiceEndpoint } from './invoice/monthly/internal';
import { getMissingInvoicePaymentsEndpoint as getMissingPaymentsEndpoint } from './invoice/monthly/missing';
import { paymentErrorStateRecoveryPost } from './payments/error-state-recovery';
import { purchaseErrorStateRecoveryPost } from './purchases/error-state-recovery';
import { queryRegistryDiffGet } from './registry/diff';
import { queryAgentByIdentifierGet } from './registry/agent-identifier';
import { queryRegistryInboxDiffGet } from './registry-inbox/diff';
import { queryInboxAgentByIdentifierGet } from './registry-inbox/agent-identifier';
import { queryInboxAgentFromWalletGet } from './registry-inbox/wallet';
import { unregisterInboxAgentPost } from './registry-inbox/deregister';
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
	getFundWalletEndpointGet,
	postFundWalletEndpointPost,
	patchFundWalletEndpointPatch,
	deleteFundWalletEndpointDelete,
} from './fund-wallet';
import { getFundDistributionEndpointGet, triggerFundDistributionEndpointPost } from './fund-distribution';
import {
	swapTokensEndpointPost,
	getSwapConfirmEndpointGet,
	getSwapTransactionsEndpointGet,
	getSwapEstimateEndpointGet,
	cancelSwapEndpointPost,
	acknowledgeSwapTimeoutEndpointPost,
} from './swap';
import {
	closeHeadPost,
	commitHeadPost,
	deleteLocalParticipantDelete,
	revealParticipantKeysPost,
	fundParticipantNodePost,
	participantFundingGet,
	deleteRelationDelete,
	deleteRemoteParticipantDelete,
	fanoutHeadPost,
	getLocalParticipantGet,
	getOrListHeadsGet,
	getHeadBalanceGet,
	getOrListRelationsGet,
	getRemoteParticipantGet,
	initHeadPost,
	ensureHydraWalletBasePost,
	queryInviteGet,
	createInvitePost,
	previewInvitePost,
	redeemInvitePost,
	deleteInviteDelete,
	listHydraHostsGet,
	registerHydraHostPost,
	updateHydraHostPatch,
	deleteHydraHostDelete,
	checkHydraHostPost,
	listHydraWalletBasesGet,
	listHeadErrorsGet,
	clearHeadErrorsDelete,
	topupHeadPost,
	listTopupsGet,
	listHydraLowBalanceRulesGet,
	setHydraLowBalanceRulePost,
	deleteHydraLowBalanceRuleDelete,
	updateHeadPatch,
} from './hydra';
import {
	createX402PaymentPost,
	createX402WalletPost,
	deleteX402LowBalanceRuleDelete,
	deleteX402WalletPost,
	listAvailableX402NetworksGet,
	listX402BudgetsGet,
	listX402LowBalanceRulesGet,
	listX402NetworksGet,
	getX402WalletGet,
	listX402PaymentAttemptsGet,
	listX402SettlementsGet,
	listX402WalletsGet,
	reconcileX402PaymentPost,
	setX402BudgetPost,
	setX402LowBalanceRulePost,
	settleX402Post,
	updateX402LowBalanceRulePatch,
	updateX402WalletPost,
	upsertX402NetworkPost,
	verifyX402Post,
	x402AnalyticsPost,
	x402PaymentAttemptsCountGet,
	x402SettlementsCountGet,
	x402WalletBalanceGet,
	x402WalletsCountGet,
} from './x402';

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
			update: {
				post: updateAgentPost,
			},
			'agent-identifier': {
				get: queryAgentByIdentifierGet,
			},
			count: {
				get: queryRegistryCountGet,
			},
		},
		'inbox-agents': {
			get: queryRegistryInboxRequestGet,
			post: registerInboxAgentPost,
			delete: deleteInboxAgentRegistration,
			diff: {
				get: queryRegistryInboxDiffGet,
			},
			wallet: {
				get: queryInboxAgentFromWalletGet,
			},
			deregister: {
				post: unregisterInboxAgentPost,
			},
			'agent-identifier': {
				get: queryInboxAgentByIdentifierGet,
			},
			count: {
				get: queryRegistryInboxCountGet,
			},
		},
		'registry-inbox': {
			get: queryRegistryInboxRequestGet,
			post: registerInboxAgentPost,
			delete: deleteInboxAgentRegistration,
			diff: {
				get: queryRegistryInboxDiffGet,
			},
			wallet: {
				get: queryInboxAgentFromWalletGet,
			},
			deregister: {
				post: unregisterInboxAgentPost,
			},
			'agent-identifier': {
				get: queryInboxAgentByIdentifierGet,
			},
			count: {
				get: queryRegistryInboxCountGet,
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
			list: {
				get: queryWalletListEndpointGet,
			},
			'low-balance': {
				get: getWalletLowBalanceRulesEndpointGet,
				post: postWalletLowBalanceRuleEndpointPost,
				patch: patchWalletLowBalanceRuleEndpointPatch,
				delete: deleteWalletLowBalanceRuleEndpointDelete,
			},
			'transfer-funds': {
				get: getWalletFundEndpointGet,
				post: postWalletFundEndpointPost,
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
		balance: {
			get: queryBalanceEndpointGet,
		},
		'payment-source': {
			get: paymentSourceEndpointGet,
		},
		x402: {
			verify: {
				post: verifyX402Post,
			},
			settle: {
				post: settleX402Post,
			},
			pay: {
				post: createX402PaymentPost,
			},
			wallets: {
				get: listX402WalletsGet,
				post: createX402WalletPost,
				detail: {
					get: getX402WalletGet,
				},
				update: {
					post: updateX402WalletPost,
				},
				balance: {
					get: x402WalletBalanceGet,
				},
				count: {
					get: x402WalletsCountGet,
				},
				delete: {
					post: deleteX402WalletPost,
				},
			},
			networks: {
				get: listX402NetworksGet,
				post: upsertX402NetworkPost,
				available: {
					get: listAvailableX402NetworksGet,
				},
			},
			budgets: {
				get: listX402BudgetsGet,
				post: setX402BudgetPost,
			},
			'low-balance': {
				get: listX402LowBalanceRulesGet,
				post: setX402LowBalanceRulePost,
				patch: updateX402LowBalanceRulePatch,
				delete: deleteX402LowBalanceRuleDelete,
			},
			payments: {
				get: listX402PaymentAttemptsGet,
				count: {
					get: x402PaymentAttemptsCountGet,
				},
				reconcile: {
					post: reconcileX402PaymentPost,
				},
			},
			settlements: {
				get: listX402SettlementsGet,
				count: {
					get: x402SettlementsCountGet,
				},
			},
			analytics: {
				post: x402AnalyticsPost,
			},
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
				verifyAndPublishAgent: {
					post: postVerifyAndPublishAgentSignatureEndpoint,
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
		'fund-wallet': {
			get: getFundWalletEndpointGet,
			post: postFundWalletEndpointPost,
			patch: patchFundWalletEndpointPatch,
			delete: deleteFundWalletEndpointDelete,
		},
		'fund-distribution': {
			get: getFundDistributionEndpointGet,
			trigger: {
				post: triggerFundDistributionEndpointPost,
			},
		},
		hydra: {
			invite: {
				get: queryInviteGet,
				post: createInvitePost,
				delete: deleteInviteDelete,
				preview: { post: previewInvitePost },
				redeem: { post: redeemInvitePost },
			},
			host: {
				get: listHydraHostsGet,
				post: registerHydraHostPost,
				patch: updateHydraHostPatch,
				delete: deleteHydraHostDelete,
				check: { post: checkHydraHostPost },
			},
			'wallet-base': {
				get: listHydraWalletBasesGet,
				post: ensureHydraWalletBasePost,
			},
			relation: {
				get: getOrListRelationsGet,
				delete: deleteRelationDelete,
			},
			head: {
				get: getOrListHeadsGet,
				patch: updateHeadPatch,
				init: { post: initHeadPost },
				commit: { post: commitHeadPost },
				topup: { post: topupHeadPost, get: listTopupsGet },
				close: { post: closeHeadPost },
				fanout: { post: fanoutHeadPost },
				balance: { get: getHeadBalanceGet },
				errors: { get: listHeadErrorsGet, delete: clearHeadErrorsDelete },
			},
			// Read and delete only: participants are created by redeeming an invite.
			participant: {
				local: {
					get: getLocalParticipantGet,
					delete: deleteLocalParticipantDelete,
					// One-time backup of the node's signing keys; seals after first use.
					keys: { post: revealParticipantKeysPost },
					// Fund the node's own Cardano key, without which Init cannot post.
					fund: { post: fundParticipantNodePost, get: participantFundingGet },
				},
				remote: {
					get: getRemoteParticipantGet,
					delete: deleteRemoteParticipantDelete,
				},
			},
			'low-balance': {
				get: listHydraLowBalanceRulesGet,
				post: setHydraLowBalanceRulePost,
				delete: deleteHydraLowBalanceRuleDelete,
			},
		},
	},
};
