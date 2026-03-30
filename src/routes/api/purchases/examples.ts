import { Network, PurchasingAction } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';
import { createPurchaseInitSchemaOutput } from './schemas';

export const purchaseResponseSchemaExample = {
	id: 'cuid_v2_auto_generated',
	blockchainIdentifier: 'blockchain_identifier',
	agentIdentifier: 'agent_identifier',
	pricingType: 'Fixed',
	createdAt: new Date(1713636260),
	updatedAt: new Date(1713636260),
	lastCheckedAt: null,
	payByTime: null,
	submitResultTime: '0',
	unlockTime: '0',
	externalDisputeUnlockTime: '0',
	requestedById: 'requester_id',
	onChainState: null,
	collateralReturnLovelace: null,
	cooldownTime: 0,
	cooldownTimeOtherParty: 0,
	inputHash: 'input_hash',
	resultHash: null,
	NextAction: {
		requestedAction: PurchasingAction.FundsLockingRequested,
		errorType: null,
		errorNote: null,
	},
	CurrentTransaction: null,
	PaidFunds: [
		{
			unit: '',
			amount: '10000000',
		},
	],
	PaymentSource: {
		id: 'payment_source_id',
		policyId: 'policy_id',
		network: Network.Preprod,
		smartContractAddress: 'address',
	},
	SellerWallet: null,
	SmartContractWallet: null,
	metadata: null,
	WithdrawnForSeller: [],
	WithdrawnForBuyer: [],
	totalBuyerCardanoFees: 0,
	totalSellerCardanoFees: 0,
	nextActionOrOnChainStateOrResultLastChangedAt: new Date(1713636260),
	nextActionLastChangedAt: new Date(1713636260),
	onChainStateOrResultLastChangedAt: new Date(1713636260),
} satisfies z.infer<typeof createPurchaseInitSchemaOutput>;
