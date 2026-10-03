import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OnChainState } from '@/generated/prisma/client';

const mockDeserializeDatum = jest.fn<(datum: string) => unknown>();
const mockDecodeV2ContractDatum = jest.fn<() => unknown>();

jest.unstable_mockModule('@meshsdk/core', () => ({
	deserializeDatum: mockDeserializeDatum,
}));

jest.unstable_mockModule('@/utils/converter/string-datum-convert', () => ({
	decodeV2ContractDatum: mockDecodeV2ContractDatum,
}));

jest.unstable_mockModule('@/utils/generator/contract-generator', () => ({
	smartContractStateEqualsOnChainState: jest.fn(() => true),
}));

const { findMatchingPaymentUtxo } = await import('./utxo-matching');

const TX_HASH = 'a'.repeat(64);
const CONTRACT_ADDRESS = 'addr_test1_contract';

const request = {
	onChainState: OnChainState.FundsLocked,
	blockchainIdentifier: 'identifier',
	inputHash: 'input-hash',
	submitResultTime: 2n,
	unlockTime: 3n,
	externalDisputeUnlockTime: 4n,
	collateralReturnLovelace: 5n,
	payByTime: 1n,
	BuyerWallet: { walletVkey: 'buyer-vkey', walletAddress: 'addr_test1_buyer' },
	SmartContractWallet: { walletVkey: 'seller-vkey', walletAddress: 'addr_test1_seller' },
};

function utxo(outputIndex: number, address = CONTRACT_ADDRESS) {
	return {
		input: { txHash: TX_HASH, outputIndex },
		output: {
			address,
			amount: [{ unit: 'lovelace', quantity: '10000000' }],
			plutusData: `datum-${outputIndex}`,
		},
	};
}

describe('Hydra escrow UTxO matching', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockDeserializeDatum.mockImplementation((datum) => datum);
		mockDecodeV2ContractDatum.mockReturnValue({
			state: 'funds-locked',
			buyerVkey: 'buyer-vkey',
			buyerAddress: 'addr_test1_buyer',
			sellerVkey: 'seller-vkey',
			sellerAddress: 'addr_test1_seller',
			blockchainIdentifier: 'identifier',
			inputHash: 'input-hash',
			resultTime: 2n,
			unlockTime: 3n,
			externalDisputeUnlockTime: 4n,
			collateralReturnLovelace: 5n,
			payByTime: 1n,
		});
	});

	it('ignores an identical-datum decoy output outside the contract address', () => {
		const decoy = utxo(0, 'addr_test1_attacker');
		const escrow = utxo(1);

		expect(findMatchingPaymentUtxo([decoy, escrow] as never, TX_HASH, request, 'preprod', CONTRACT_ADDRESS)).toBe(
			escrow,
		);
		expect(mockDeserializeDatum).toHaveBeenCalledTimes(1);
	});

	it('requires the exact persisted Hydra output index when one is available', () => {
		const firstContractOutput = utxo(0);
		const trackedContractOutput = utxo(1);

		expect(
			findMatchingPaymentUtxo(
				[firstContractOutput, trackedContractOutput] as never,
				TX_HASH,
				{
					...request,
					currentHydraUtxoTxHash: TX_HASH,
					currentHydraUtxoOutputIndex: 1,
				},
				'preprod',
				CONTRACT_ADDRESS,
			),
		).toBe(trackedContractOutput);
	});

	it('isolates malformed sibling datums instead of aborting the genuine match', () => {
		const malformedSibling = utxo(0);
		const escrow = utxo(1);
		mockDeserializeDatum.mockImplementation((datum) => {
			if (datum === 'datum-0') throw new Error('malformed CBOR');
			return datum;
		});

		expect(
			findMatchingPaymentUtxo([malformedSibling, escrow] as never, TX_HASH, request, 'preprod', CONTRACT_ADDRESS),
		).toBe(escrow);
	});

	it('refuses ambiguous datum-only compatibility matching', () => {
		expect(
			findMatchingPaymentUtxo([utxo(0), utxo(1)] as never, TX_HASH, request, 'preprod', CONTRACT_ADDRESS),
		).toBeUndefined();
	});

	it.each([
		[{ currentHydraUtxoTxHash: TX_HASH, currentHydraUtxoOutputIndex: null }],
		[{ currentHydraUtxoTxHash: null, currentHydraUtxoOutputIndex: 0 }],
		[{ currentHydraUtxoTxHash: 'b'.repeat(64), currentHydraUtxoOutputIndex: 0 }],
	])('refuses an incomplete or mismatched durable Hydra reference', (hydraReference) => {
		expect(
			findMatchingPaymentUtxo(
				[utxo(0)] as never,
				TX_HASH,
				{ ...request, ...hydraReference },
				'preprod',
				CONTRACT_ADDRESS,
			),
		).toBeUndefined();
	});
});
