import { getDatumV2 } from '../contract-generator';
import { SmartContractState } from '@masumi/payment-core';
import { OnChainState } from '@/generated/prisma/client';
import { deserializeDatum, type Data } from '@meshsdk/core';
import { fromBuilderToPlutusData } from '@meshsdk/core-cst';
import { decodeV2ContractDatum } from '@/utils/converter/string-datum-convert';
import { findMatchingPaymentUtxo } from './utxo-matching';

const PARTICIPANT = 'addr_test1vq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0c75xvdu';
const CONTRACT_ADDRESS = 'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g';
const TX_HASH = 'cc'.repeat(32);
const OUTPUT_INDEX = 1;

function datumCbor(constructor: number) {
	const datum = getDatumV2({
		buyerAddress: PARTICIPANT,
		sellerAddress: PARTICIPANT,
		referenceKey: '01'.repeat(16),
		referenceSignature: '02'.repeat(16),
		sellerNonce: '03'.repeat(32),
		buyerNonce: '04'.repeat(16),
		agentIdentifier: '05'.repeat(16),
		collateralReturnLovelace: 0n,
		inputHash: 'ab'.repeat(32),
		resultHash: null,
		payByTime: 1n,
		resultTime: 2n,
		unlockTime: 3n,
		externalDisputeUnlockTime: 4n,
		newCooldownTimeSeller: 0n,
		newCooldownTimeBuyer: 0n,
		state: SmartContractState.FundsLocked,
	});
	return fromBuilderToPlutusData({
		type: 'Mesh',
		content: { ...(datum.value as { alternative: number; fields: Data[] }), alternative: constructor },
	}).toCbor();
}

describe('Hydra escrow matching with actual datum CBOR', () => {
	it.each([0, 1, 99])('only accepts Datum constructor zero (received %s)', (constructor) => {
		const valid = decodeV2ContractDatum(deserializeDatum(datumCbor(0)), 'preprod', CONTRACT_ADDRESS)!;
		expect(valid).not.toBeNull();
		const utxo = {
			input: { txHash: TX_HASH, outputIndex: OUTPUT_INDEX },
			output: {
				address: CONTRACT_ADDRESS,
				amount: [{ unit: 'lovelace', quantity: '10000000' }],
				plutusData: datumCbor(constructor),
			},
		};
		const match = findMatchingPaymentUtxo(
			[utxo],
			TX_HASH,
			{
				onChainState: OnChainState.FundsLocked,
				blockchainIdentifier: valid.blockchainIdentifier,
				inputHash: valid.inputHash!,
				submitResultTime: valid.resultTime,
				unlockTime: valid.unlockTime,
				externalDisputeUnlockTime: valid.externalDisputeUnlockTime,
				collateralReturnLovelace: valid.collateralReturnLovelace,
				payByTime: valid.payByTime,
				currentHydraUtxoTxHash: TX_HASH,
				currentHydraUtxoOutputIndex: OUTPUT_INDEX,
				BuyerWallet: { walletVkey: valid.buyerVkey, walletAddress: valid.buyerAddress },
				SmartContractWallet: { walletVkey: valid.sellerVkey, walletAddress: valid.sellerAddress },
			},
			'preprod',
			CONTRACT_ADDRESS,
		);
		if (constructor === 0) expect(match).toBe(utxo);
		else expect(match).toBeUndefined();
	});
});
