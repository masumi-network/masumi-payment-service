import { describe, expect, it } from '@jest/globals';
import {
	Address,
	AssetName,
	Assets,
	BigInt as CardanoBigInt,
	BigNum,
	Credential,
	Ed25519KeyHash,
	Ed25519KeyHashes,
	EnterpriseAddress,
	FixedTransaction,
	make_vkey_witness,
	MultiAsset,
	PlutusData,
	PrivateKey,
	ScriptHash,
	Transaction,
	TransactionBody,
	TransactionInputs,
	TransactionOutput,
	TransactionOutputs,
	TransactionWitnessSet,
	Value,
	Vkeywitness,
	Vkeywitnesses,
} from '@emurgo/cardano-serialization-lib-nodejs';
import {
	canonicalizeHydraAmounts,
	hydraAmountListCovers,
	hydraValidityLowerBoundTimeMs,
	hydraValidityUpperBoundTimeMs,
	parseHydraTransactionEvidence,
} from './hydra-transaction-evidence';

describe('canonical Hydra values', () => {
	it('sums duplicate units and normalizes unit casing deterministically', () => {
		expect(
			canonicalizeHydraAmounts([
				{ unit: '', quantity: '2' },
				{ unit: 'LOVELACE', quantity: '3' },
				{ unit: 'AABB', quantity: '4' },
				{ unit: 'aabb', quantity: '5' },
			]),
		).toEqual([
			{ unit: 'aabb', quantity: '9' },
			{ unit: 'lovelace', quantity: '5' },
		]);
	});

	it('compares coverage after summing duplicates and rejects negative quantities', () => {
		expect(
			hydraAmountListCovers(
				[
					{ unit: 'lovelace', quantity: '5' },
					{ unit: '', quantity: '5' },
				],
				[{ unit: 'lovelace', quantity: '10' }],
			),
		).toBe(true);
		expect(canonicalizeHydraAmounts([{ unit: 'lovelace', quantity: '-1' }])).toBeNull();
	});
});

function makeAddress(seed: number): Address {
	const keyHash = Ed25519KeyHash.from_bytes(new Uint8Array(28).fill(seed));
	return EnterpriseAddress.new(0, Credential.from_keyhash(keyHash)).to_address();
}

function transactionHash(body: TransactionBody) {
	return FixedTransaction.new_from_body_bytes(body.to_bytes()).transaction_hash();
}

describe('parseHydraTransactionEvidence', () => {
	it('extracts immutable output index, address, amounts, and inline datum CBOR', () => {
		const outputs = TransactionOutputs.new();
		outputs.add(TransactionOutput.new(makeAddress(1), Value.new(BigNum.from_str('2000000'))));

		const contractAddress = makeAddress(2);
		const policyId = ScriptHash.from_bytes(new Uint8Array(28).fill(3));
		const assetName = AssetName.new(Uint8Array.from([0xaa, 0xbb]));
		const assets = Assets.new();
		assets.insert(assetName, BigNum.from_str('42'));
		const multiAsset = MultiAsset.new();
		multiAsset.insert(policyId, assets);
		const contractOutput = TransactionOutput.new(
			contractAddress,
			Value.new_with_assets(BigNum.from_str('10000000'), multiAsset),
		);
		const datum = PlutusData.new_integer(CardanoBigInt.from_str('7'));
		contractOutput.set_plutus_data(datum);
		outputs.add(contractOutput);

		const body = TransactionBody.new(TransactionInputs.new(), outputs, BigNum.from_str('1'));
		const transaction = Transaction.new(body, TransactionWitnessSet.new());
		const evidence = parseHydraTransactionEvidence(Buffer.from(transaction.to_bytes()).toString('hex'));

		expect(evidence).not.toBeNull();
		expect(evidence?.txHash).toBe(transactionHash(body).to_hex());
		expect(evidence?.outputs[1]).toEqual({
			outputIndex: 1,
			address: contractAddress.to_bech32(),
			amount: [
				{ unit: 'lovelace', quantity: '10000000' },
				{ unit: `${policyId.to_hex()}${assetName.to_hex()}`, quantity: '42' },
			],
			plutusData: Buffer.from(datum.to_bytes()).toString('hex'),
		});
	});

	it('rejects phase-2-invalid transactions whose regular spends and outputs did not take effect', () => {
		const body = TransactionBody.new(TransactionInputs.new(), TransactionOutputs.new(), BigNum.from_str('1'));
		const transaction = Transaction.new(body, TransactionWitnessSet.new());
		transaction.set_is_valid(false);

		expect(parseHydraTransactionEvidence(Buffer.from(transaction.to_bytes()).toString('hex'))).toBeNull();
	});

	it('extracts the signed invalid-hereafter slot without number truncation', () => {
		const body = TransactionBody.new(TransactionInputs.new(), TransactionOutputs.new(), BigNum.from_str('1'));
		body.set_ttl(BigNum.from_str('9007199254740993'));
		const transaction = Transaction.new(body, TransactionWitnessSet.new());

		const evidence = parseHydraTransactionEvidence(Buffer.from(transaction.to_bytes()).toString('hex'));

		expect(evidence?.validityUpperSlot).toBe(9_007_199_254_740_993n);
	});

	it('extracts the signed lower-validity slot and converts its slot start', () => {
		const body = TransactionBody.new(TransactionInputs.new(), TransactionOutputs.new(), BigNum.from_str('1'));
		body.set_validity_start_interval_bignum(BigNum.from_str('50'));
		const transaction = Transaction.new(body, TransactionWitnessSet.new());
		const evidence = parseHydraTransactionEvidence(Buffer.from(transaction.to_bytes()).toString('hex'));

		expect(evidence?.validityLowerSlot).toBe(50n);
		expect(
			hydraValidityLowerBoundTimeMs(evidence ?? { validityLowerSlot: null }, {
				zeroTime: 1_000,
				zeroSlot: 0,
				slotLength: 100,
				startEpoch: 0,
				epochLength: 100,
			}),
		).toBe(6_000n);
	});

	it('keeps a missing invalid-hereafter explicit and fail-closed', () => {
		const body = TransactionBody.new(TransactionInputs.new(), TransactionOutputs.new(), BigNum.from_str('1'));
		const transaction = Transaction.new(body, TransactionWitnessSet.new());

		const evidence = parseHydraTransactionEvidence(Buffer.from(transaction.to_bytes()).toString('hex'));

		expect(evidence?.validityUpperSlot).toBeNull();
		expect(
			hydraValidityUpperBoundTimeMs(evidence ?? { validityUpperSlot: null }, {
				zeroTime: 1_000,
				zeroSlot: 0,
				slotLength: 100,
				startEpoch: 0,
				epochLength: 100,
			}),
		).toBeNull();
	});

	it('converts the signed slot using the supplied head timeline', () => {
		expect(
			hydraValidityUpperBoundTimeMs(
				{ validityUpperSlot: 50n },
				{ zeroTime: 1_000, zeroSlot: 0, slotLength: 100, startEpoch: 0, epochLength: 100 },
			),
		).toBe(6_100n);
	});

	it('includes only a VKey witness whose signature verifies against the transaction body hash', () => {
		const body = TransactionBody.new(TransactionInputs.new(), TransactionOutputs.new(), BigNum.from_str('1'));
		const privateKey = PrivateKey.generate_ed25519();
		const vkeys = Vkeywitnesses.new();
		vkeys.add(make_vkey_witness(transactionHash(body), privateKey));
		const witnessSet = TransactionWitnessSet.new();
		witnessSet.set_vkeys(vkeys);
		const transaction = Transaction.new(body, witnessSet);

		const evidence = parseHydraTransactionEvidence(Buffer.from(transaction.to_bytes()).toString('hex'));

		expect(evidence?.signerVkeys).toEqual([Buffer.from(privateKey.to_public().hash().to_bytes()).toString('hex')]);
	});

	it('separates a body-required actor from unrelated valid witnesses', () => {
		const body = TransactionBody.new(TransactionInputs.new(), TransactionOutputs.new(), BigNum.from_str('1'));
		const requiredKey = PrivateKey.generate_ed25519();
		const witnessKey = PrivateKey.generate_ed25519();
		const requiredSigners = Ed25519KeyHashes.new();
		requiredSigners.add(requiredKey.to_public().hash());
		body.set_required_signers(requiredSigners);
		const vkeys = Vkeywitnesses.new();
		vkeys.add(make_vkey_witness(transactionHash(body), witnessKey));
		const witnessSet = TransactionWitnessSet.new();
		witnessSet.set_vkeys(vkeys);
		const transaction = Transaction.new(body, witnessSet);

		const evidence = parseHydraTransactionEvidence(Buffer.from(transaction.to_bytes()).toString('hex'));

		expect(evidence?.requiredSignerVkeys).toEqual([requiredKey.to_public().hash().to_hex()]);
		expect(evidence?.signerVkeys).toEqual([witnessKey.to_public().hash().to_hex()]);
	});

	it('rejects the entire transaction when a VKey witness carries a bogus signature', () => {
		const body = TransactionBody.new(TransactionInputs.new(), TransactionOutputs.new(), BigNum.from_str('1'));
		const claimedKey = PrivateKey.generate_ed25519();
		const attackerKey = PrivateKey.generate_ed25519();
		const bodyHash = transactionHash(body);
		const claimedWitness = make_vkey_witness(bodyHash, claimedKey);
		const attackerWitness = make_vkey_witness(bodyHash, attackerKey);
		const vkeys = Vkeywitnesses.new();
		vkeys.add(Vkeywitness.new(claimedWitness.vkey(), attackerWitness.signature()));
		const witnessSet = TransactionWitnessSet.new();
		witnessSet.set_vkeys(vkeys);
		const transaction = Transaction.new(body, witnessSet);

		expect(parseHydraTransactionEvidence(Buffer.from(transaction.to_bytes()).toString('hex'))).toBeNull();
	});
});
