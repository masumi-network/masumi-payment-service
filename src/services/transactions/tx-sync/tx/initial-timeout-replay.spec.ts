import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Prisma } from '@/generated/prisma/client';
import {
	Network,
	OnChainState,
	PaymentAction,
	PaymentSourceType,
	PurchasingAction,
	TransactionLayer,
} from '@/generated/prisma/client';
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';
import type { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import type { UpdateTransactionInput } from './types';

const deadline = 1_800_000_000_000n;
const decoded: DecodedV1ContractDatum = {
	blockchainIdentifier: 'initial-lock',
	buyerAddress: 'buyer-address',
	buyerReturnAddress: null,
	sellerAddress: 'seller-address',
	sellerReturnAddress: null,
	buyerVkey: 'buyer-key',
	sellerVkey: 'seller-key',
	state: SmartContractState.FundsLocked,
	referenceKey: '01'.repeat(32),
	referenceSignature: '02'.repeat(16),
	sellerNonce: '03'.repeat(32),
	buyerNonce: '04'.repeat(16),
	collateralReturnLovelace: 0n,
	inputHash: 'input-hash',
	resultHash: null,
	payByTime: deadline,
	resultTime: deadline + 60_000n,
	unlockTime: deadline + 120_000n,
	externalDisputeUnlockTime: deadline + 180_000n,
	buyerCooldownTime: 0n,
	sellerCooldownTime: 0n,
};

function request(didTimeout: boolean, hasObservedOutput = false) {
	return {
		id: 'seller-request',
		payByTime: deadline,
		submitResultTime: decoded.resultTime,
		unlockTime: decoded.unlockTime,
		externalDisputeUnlockTime: decoded.externalDisputeUnlockTime,
		onChainState: didTimeout ? OnChainState.FundsOrDatumInvalid : null,
		layer: TransactionLayer.L1,
		forceLayer: null,
		currentTransactionId: null,
		CurrentTransaction: null,
		TransactionHistory: [],
		currentHydraUtxoTxHash: hasObservedOutput ? 'invalid-observed-output' : null,
		currentHydraUtxoOutputIndex: null,
		currentHydraUtxoValue: null,
		unresolvedHydraTerminalTxHash: null,
		unresolvedHydraTerminalReason: null,
		fanoutTxHash: null,
		resultHash: null,
		sellerReturnAddress: null,
		BuyerWallet: null,
		SmartContractWallet: { walletAddress: decoded.sellerAddress, walletVkey: decoded.sellerVkey },
		RequestedFunds: [{ unit: '', amount: 10_000_000n }],
		nextActionId: 'initial-action',
		NextAction: {
			requestedAction: didTimeout ? PaymentAction.WaitingForManualAction : PaymentAction.WaitingForExternalAction,
		},
	};
}

let stored = request(false);
function purchase(didTimeout: boolean) {
	return {
		...request(didTimeout),
		paymentSourceId: 'source',
		inputHash: decoded.inputHash,
		buyerReturnAddress: null,
		collateralReturnLovelace: 0n,
		SmartContractWallet: { walletAddress: decoded.buyerAddress, walletVkey: decoded.buyerVkey },
		SellerWallet: { walletAddress: decoded.sellerAddress, walletVkey: decoded.sellerVkey },
		NextAction: {
			requestedAction: didTimeout ? PurchasingAction.WaitingForManualAction : PurchasingAction.FundsLockingRequested,
		},
	};
}
let storedPurchase = purchase(false);
const update = jest.fn<(_args: Prisma.PaymentRequestUpdateArgs) => Promise<object>>(async () => ({}));
const updatePurchase = jest.fn<(_args: Prisma.PurchaseRequestUpdateArgs) => Promise<object>>(async () => ({}));
const database = {
	purchaseRequest: { findUnique: async () => storedPurchase, update: updatePurchase },
	paymentRequest: {
		findUnique: jest.fn(async (args: Prisma.PaymentRequestFindUniqueArgs) => {
			const requestedAction = args.where.NextAction?.requestedAction;
			return requestedAction == null || requestedAction === stored.NextAction.requestedAction ? stored : null;
		}),
		update,
	},
};

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { $transaction: async (run: (tx: typeof database) => Promise<void>) => run(database) },
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({ epochsLatestParameters: async () => ({ coins_per_utxo_size: '4310' }) }),
}));

const { updateInitialPaymentTransaction } = await import('./initial-payment');
const { updateInitialPurchaseTransaction } = await import('./initial-purchase');

async function observe(overrides: Partial<DecodedV1ContractDatum> = {}, isPurchase = false) {
	const datum = { ...decoded, ...overrides };
	const output = {
		address: 'escrow-address',
		amount: [{ unit: '', quantity: '10000000' }],
		output_index: 0,
		data_hash: null,
		inline_datum: null,
		reference_script_hash: null,
		collateral: false,
	};
	const transaction = {
		blockTime: Number(deadline / 1000n) - 1,
		tx: { tx_hash: 'confirmed-before-deadline' },
		block: { confirmations: 10 },
		metadata: { fees: 0n, output_amount: [] },
		utxos: { inputs: [{ address: decoded.buyerAddress }], outputs: [output] },
	} as unknown as UpdateTransactionInput;
	const source = {
		id: 'source',
		network: Network.Preprod,
		paymentSourceType: PaymentSourceType.Web3CardanoV2,
		smartContractAddress: 'escrow-address',
	};
	if (isPurchase) {
		await updateInitialPurchaseTransaction(source, datum, output, transaction, transaction.metadata, 0n, 0n);
		return;
	}
	await updateInitialPaymentTransaction(datum, source, transaction, output, transaction.metadata, 0n, 0n, 'test-key');
}

describe('L1 initial lock observed after seller timeout', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it.each([false, true])('accepts an on-time lock when observer timed out = %s', async (didTimeout) => {
		stored = request(didTimeout);
		await observe();
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ onChainState: OnChainState.FundsLocked }) }),
		);
	});

	it('still rejects mismatched terms when recovering a timeout', async () => {
		stored = request(true);
		await observe({ unlockTime: decoded.unlockTime + 1n });
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ onChainState: OnChainState.FundsOrDatumInvalid }) }),
		);
	});

	it('keeps an observed invalid lock rejected', async () => {
		stored = request(true, true);
		await observe();
		expect(update).not.toHaveBeenCalled();
	});

	it.each([false, true])('accepts an on-time purchase lock when observer timed out = %s', async (didTimeout) => {
		storedPurchase = purchase(didTimeout);
		await observe({}, true);
		expect(updatePurchase).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ onChainState: OnChainState.FundsLocked }) }),
		);
	});
});
