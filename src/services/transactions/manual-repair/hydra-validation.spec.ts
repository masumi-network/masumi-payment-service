import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
	HydraHeadStatus,
	Network,
	OnChainState,
	PaymentSourceType,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';

const hash = 'ab'.repeat(32);
const unit = 'cd'.repeat(28);
const buyer = { walletVkey: 'buyer', walletAddress: 'buyer-address', paymentSourceId: 'source' };
const seller = { walletVkey: 'seller', walletAddress: 'seller-address', paymentSourceId: 'source' };
const makeRequest = () => ({
	id: 'request',
	updatedAt: new Date(0),
	paymentSourceId: 'source',
	blockchainIdentifier: 'identifier',
	onChainState: OnChainState.FundsOrDatumInvalid as OnChainState,
	layer: TransactionLayer.L2,
	currentHydraUtxoTxHash: hash,
	currentHydraUtxoOutputIndex: 0,
	CurrentTransaction: {
		id: 'transaction',
		txHash: hash,
		layer: TransactionLayer.L2,
		status: TransactionStatus.Confirmed,
		hydraHeadId: 'head',
	},
	PaymentSource: {
		network: Network.Mainnet,
		paymentSourceType: PaymentSourceType.Web3CardanoV2,
		smartContractAddress: 'escrow',
	},
	SmartContractWallet: buyer,
	SellerWallet: seller,
	PaidFunds: [{ unit, amount: 900000n }],
	inputHash: 'input',
	payByTime: 100n,
	submitResultTime: 200n,
	unlockTime: 300n,
	externalDisputeUnlockTime: 400n,
	collateralReturnLovelace: 2000000n,
	buyerReturnAddress: null,
	sellerReturnAddress: null,
});
let request = makeRequest();
const makeHead = () => ({
	id: 'head',
	isEnabled: true,
	isClosing: false,
	initTxHash: 'init',
	headIdentifier: 'onchain-head',
	reconciliationCompletedAt: null,
	status: HydraHeadStatus.Open,
	ownerEpoch: 3n,
	latestSnapshotNumber: 3n,
	HydraRelation: { LocalHotWallet: buyer, RemoteWallet: seller },
});
let head = makeHead();
const findRequest = jest.fn(async () => request);
const findHead = jest.fn(async () => head);
const output = {
	outputIndex: 0,
	address: 'escrow',
	plutusData: 'datum',
	amount: [
		{ unit, quantity: '900000' },
		{ unit: 'lovelace', quantity: '2000000' },
	],
};
const makeEvidence = () => ({
	txHash: hash,
	outputs: [output],
	signerVkeys: ['buyer'],
	requiredSignerVkeys: ['buyer'],
});
let evidence = makeEvidence();
const decoded = {
	blockchainIdentifier: 'identifier',
	state: 0,
	buyerVkey: 'buyer',
	collateralReturnLovelace: 2000000n,
	payByTime: 100n,
};
const node = {
	hasVerifiedPinnedSessions: true,
	confirmedTransactionHistoryReady: true,
	getVerifiedCurrentOutput: jest.fn((): string | null => 'serialized-output'),
	getConfirmedTransaction: jest.fn(() => ({ cborHex: 'cbor', confirmedAtMs: 50 })),
};
const manager = { flushHeadStatus: jest.fn(async () => {}), getNode: jest.fn(() => node) };
const canonicalCheck = jest.fn(() => ({ valid: true, errorNote: null as string | null }));
const datumMismatch = jest.fn((): string | null => null);
const participants = jest.fn(() => true);
const upper = jest.fn((): bigint | null => 90n);
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		purchaseRequest: { findUnique: findRequest },
		paymentRequest: { findUnique: findRequest },
		hydraHead: { findUnique: findHead },
	},
}));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => manager,
}));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-datum-guards', () => ({
	headParticipantsMatch: participants,
	validateCanonicalInitialLock: canonicalCheck,
}));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-transaction-evidence', () => ({
	hydraValidityUpperBoundTimeMs: upper,
	parseHydraTransactionEvidence: () => evidence,
}));
jest.unstable_mockModule('@emurgo/cardano-serialization-lib-nodejs', () => ({
	FixedTransaction: {
		from_hex: () => ({ is_valid: () => true, body: () => ({ outputs: () => ({ get: () => output }) }) }),
	},
}));
jest.unstable_mockModule('@/lib/hydra/hydra/snapshot-verification', () => ({
	serializeCardanoTransactionOutput: () => 'serialized-output',
}));
jest.unstable_mockModule('@meshsdk/core', () => ({ deserializeDatum: (value: string) => value }));
jest.unstable_mockModule('@/utils/converter/string-datum-convert', () => ({ decodeV2ContractDatum: () => decoded }));
jest.unstable_mockModule('@/utils/hydra/l2-slot-context', () => ({ resolveHydraL2EvidenceSlotConfig: () => ({}) }));
jest.unstable_mockModule('./index', () => ({
	RepairValidationError: class extends Error {},
}));
jest.unstable_mockModule('@/utils/logic/l2-datum-validation', () => ({
	datumMatchesRequest: () => datumMismatch() == null,
}));
const { validateHydraRepair } = await import('./hydra-validation');
const validate = () => validateHydraRepair({ kind: 'purchase', requestId: 'request', txHash: hash });

beforeEach(() => {
	jest.clearAllMocks();
	request = makeRequest();
	head = makeHead();
	evidence = makeEvidence();
	node.hasVerifiedPinnedSessions = true;
	node.confirmedTransactionHistoryReady = true;
	node.getVerifiedCurrentOutput.mockReturnValue('serialized-output');
	manager.getNode.mockReturnValue(node);
	canonicalCheck.mockReturnValue({ valid: true, errorNote: null });
	datumMismatch.mockReturnValue(null);
	participants.mockReturnValue(true);
	upper.mockReturnValue(90n);
});
describe('Hydra repair evidence admission', () => {
	it('returns exact existing escrow and rechecks current evidence', async () => {
		const result = await validate();
		expect(result).toMatchObject({
			headId: 'head',
			currentTransactionId: 'transaction',
			outputIndex: 0,
			ownerEpoch: 3n,
			derivedOnChainState: OnChainState.FundsLocked,
		});
		expect(canonicalCheck.mock.calls).toContainEqual([decoded, request.PaidFunds, output.amount, 50]);
		result.assertFresh();
		node.getVerifiedCurrentOutput.mockReturnValue(null);
		expect(result.assertFresh).toThrow('evidence changed');
	});
	it('rejects an already-valid request', async () => {
		request.onChainState = OnChainState.FundsLocked;
		await expect(validate()).rejects.toThrow('rejected lock');
	});
	it('rejects a different existing reference', async () => {
		request.currentHydraUtxoTxHash = 'ff'.repeat(32);
		await expect(validate()).rejects.toThrow('exact current');
	});
	it('rejects a closed admission gate', async () => {
		head.isClosing = true;
		await expect(validate()).rejects.toThrow('not open');
	});
	it('rejects unauthenticated sessions', async () => {
		node.hasVerifiedPinnedSessions = false;
		await expect(validate()).rejects.toThrow('Verified Hydra history');
	});
	it('rejects spent outputs', async () => {
		node.getVerifiedCurrentOutput.mockReturnValue(null);
		await expect(validate()).rejects.toThrow('Current unspent');
	});
	it('rejects duplicate request outputs', async () => {
		evidence.outputs.push({ ...output, outputIndex: 1 });
		await expect(validate()).rejects.toThrow('ambiguous');
	});
	it('rejects mismatched request datum', async () => {
		datumMismatch.mockReturnValue('inputHash');
		await expect(validate()).rejects.toThrow('does not match');
	});
	it('rejects foreign head participants', async () => {
		participants.mockReturnValue(false);
		await expect(validate()).rejects.toThrow('participants');
	});
	it('rejects a buyer witness absent from required signers', async () => {
		evidence.requiredSignerVkeys = [];
		await expect(validate()).rejects.toThrow('body-bound');
	});
	it('rejects a required buyer without its witness', async () => {
		evidence.signerVkeys = [];
		await expect(validate()).rejects.toThrow('body-bound');
	});
	it('rejects missing signed deadline', async () => {
		upper.mockReturnValue(null);
		await expect(validate()).rejects.toThrow('deadline');
	});
	it('rejects a signed deadline past payByTime', async () => {
		upper.mockReturnValue(101n);
		await expect(validate()).rejects.toThrow('deadline');
	});
	it('propagates canonical amount or datum rejection', async () => {
		canonicalCheck.mockReturnValue({ valid: false, errorNote: 'Payment amounts do not match' });
		await expect(validate()).rejects.toThrow('Payment amounts');
	});
});
