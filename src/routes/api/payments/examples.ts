import { Network, PaymentAction } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';
import { createPaymentSchemaOutput } from './schemas';

export const paymentSchemaOutputExample = {
	id: 'cuid_v2_auto_generated',
	blockchainIdentifier: 'blockchain_identifier',
	agentIdentifier: 'agent_identifier',
	createdAt: new Date(1713636260),
	updatedAt: new Date(1713636260),
	submitResultTime: '0',
	unlockTime: '0',
	externalDisputeUnlockTime: '0',
	lastCheckedAt: null,
	cooldownTime: 0,
	payByTime: null,
	cooldownTimeOtherParty: 0,
	collateralReturnLovelace: null,
	requestedById: 'requester_id',
	resultHash: 'result_hash',
	onChainState: null,
	inputHash: 'input_hash',
	NextAction: {
		requestedAction: PaymentAction.AuthorizeRefundRequested,
		errorType: null,
		errorNote: null,
		resultHash: null,
	},
	CurrentTransaction: null,
	RequestedFunds: [
		{
			unit: '',
			amount: '10000000',
		},
	],
	PaymentSource: {
		id: 'payment_source_id',
		network: Network.Preprod,
		smartContractAddress: 'address',
		policyId: 'policy_id',
	},
	WithdrawnForSeller: [],
	WithdrawnForBuyer: [],
	BuyerWallet: null,
	SmartContractWallet: null,
	metadata: null,
	totalBuyerCardanoFees: 0,
	totalSellerCardanoFees: 0,
	nextActionOrOnChainStateOrResultLastChangedAt: new Date(1713636260),
	nextActionLastChangedAt: new Date(1713636260),
	onChainStateOrResultLastChangedAt: new Date(1713636260),
} satisfies z.infer<typeof createPaymentSchemaOutput>;
