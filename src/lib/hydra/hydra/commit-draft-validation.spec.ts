import { describe, expect, it } from '@jest/globals';
import {
	Address,
	BaseAddress,
	BigInt as CardanoBigInt,
	BigNum,
	ConstrPlutusData,
	Credential,
	Ed25519KeyHash,
	EnterpriseAddress,
	PlutusData,
	PlutusList,
	Transaction,
	TransactionBody,
	TransactionHash,
	TransactionInput,
	TransactionInputs,
	TransactionOutput,
	TransactionOutputs,
	TransactionWitnessSet,
	Value,
} from '@emurgo/cardano-serialization-lib-nodejs';
import type { UTxO } from '@meshsdk/core';
import { HydraTransactionType, type HydraTransaction } from './types';
import {
	assertHydraCommitSignedBody,
	DEFAULT_HYDRA_DEPOSIT_SCRIPT_HASH,
	validateHydraCommitDraft,
} from './commit-draft-validation';

const COMMIT_TX_HASH = 'a6fcca277c6ff7595131b6112b1ec6ccbff8a16b8c5db1e1a86b4fa7ccd23ab4';
const FUEL_TX_HASH = 'b'.repeat(64);
const OTHER_WALLET_TX_HASH = 'c'.repeat(64);
const HEAD_ID = '22cc3e117a6e471dd7a34cfa8d0ae7ba057068ddf01c44a97513ec03';
const COMMIT_ADDRESS =
	'addr_test1qp6ctf8vcjxzd53et7p0hlqyncn59stnfd4g8mp978v33r6dlzjvt4s2t6wn3v993pu9aea4h3z0jeyn6lsvw6hugtesfx55dd';
const NODE_CHANGE_ADDRESS = 'addr_test1vp6ctf8vcjxzd53et7p0hlqyncn59stnfd4g8mp978v33rca69gdx';
const ATTACKER_CHANGE_ADDRESS = 'addr_test1vr0k7n76m2s9gsnha2n47umajyuwhe3rqsr7pnh2cgfc7yg60l8fh';
const DEPOSIT_ADDRESS = 'addr_test1wrrcaryjq4epavl0gsg08kuuv95l5md5jlpyvswjnss998qyu7lhm';
const OTHER_SCRIPT_ADDRESS = 'addr_test1wq4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3gn6jry8';
const NOW_MS = 1_784_735_000_000;
const SLOT_CONFIG = {
	zeroTime: NOW_MS,
	zeroSlot: 129_100_000,
	slotLength: 1_000,
	startEpoch: 0,
	epochLength: 432_000,
};
const SERIALIZED_COMMIT_OUTPUT =
	'd8799fd8799fd8799f581c7585a4ecc48c26d2395f82fbfc049e2742c1734b6a83ec25f1d9188fffd8799fd8799fd8799f581c4df8a4c5d60a5e9d38b0a588785ee7b5bc44f96493d7e0c76afc42f3ffffffffa140a1401a004c4b40d87980d87a80ff';

const commitUtxo = utxo(COMMIT_TX_HASH, 1, COMMIT_ADDRESS, '5000000');
const fuelUtxo = utxo(FUEL_TX_HASH, 0, COMMIT_ADDRESS, '1000000000');
const otherWalletUtxo = utxo(OTHER_WALLET_TX_HASH, 0, COMMIT_ADDRESS, '7000000');

describe('validateHydraCommitDraft', () => {
	it('accepts a draft that exactly commits the requested plain output', () => {
		const draft = buildDraft();
		const result = validate(draft);

		expect(result.txId).toMatch(/^[0-9a-f]{64}$/);
		expect(result.deadlineMs).toBe(NOW_MS + 60_000);
		expect(result.depositOutputIndex).toBe(0);
		expect(result.invalidHereafterSlot).toBe(129_100_000n);
	});

	it('rejects an advertised id that does not hash to the body', () => {
		const draft = { ...buildDraft(), txId: 'f'.repeat(64) };
		expect(() => validate(draft)).toThrow('advertised transaction id does not match');
	});

	it('rejects a deposit for another Hydra head', () => {
		expect(() =>
			validateHydraCommitDraft({
				...baseValidationOptions(buildDraft()),
				expectedHeadId: 'd'.repeat(56),
			}),
		).toThrow('head id does not match');
	});

	it('rejects a serialized commit output that changes the committed value', () => {
		const alteredOutput = SERIALIZED_COMMIT_OUTPUT.replace('1a004c4b40', '1a004c4b41');
		expect(() => validate(buildDraft({ serializedOutput: alteredOutput }))).toThrow(
			'does not exactly match the expected value',
		);
	});

	it('rejects spending a wallet input that was not approved as fuel', () => {
		const draft = buildDraft({ feeInputHashes: [OTHER_WALLET_TX_HASH] });
		expect(() =>
			validateHydraCommitDraft({
				...baseValidationOptions(draft),
				walletUtxos: [commitUtxo, fuelUtxo, otherWalletUtxo],
			}),
		).toThrow(`fee input ${OTHER_WALLET_TX_HASH}#0 was not explicitly reserved`);
	});

	it('allows the one explicitly reserved wallet input to be used as fee fuel', () => {
		expect(() => validate(buildDraft({ feeInputHashes: [FUEL_TX_HASH] }))).not.toThrow();
	});

	it('rejects an unresolved node-selected fee input', () => {
		expect(() => validate(buildDraft({ feeInputHashes: ['e'.repeat(64)] }))).toThrow('was not explicitly reserved');
	});

	it('rejects fee change redirected away from the reserved wallet key', () => {
		expect(() => validate(buildDraft({ changeAddress: ATTACKER_CHANGE_ADDRESS }))).toThrow(
			'does not return control to the reserved fuel wallet',
		);
	});

	it('rejects fee change that delegates the wallet value to an attacker stake key', () => {
		const paymentCredential = EnterpriseAddress.from_address(Address.from_bech32(NODE_CHANGE_ADDRESS))?.payment_cred();
		expect(paymentCredential).toBeDefined();
		const attackerStakeAddress = BaseAddress.new(
			0,
			paymentCredential!,
			Credential.from_keyhash(Ed25519KeyHash.from_hex('d'.repeat(56))),
		)
			.to_address()
			.to_bech32();
		expect(() => validate(buildDraft({ changeAddress: attackerStakeAddress }))).toThrow(
			'does not return control to the reserved fuel wallet',
		);
	});

	it('rejects an imbalanced fee change value', () => {
		expect(() => validate(buildDraft({ changeLovelace: 999_599_999n }))).toThrow(
			'transaction input/output value balance does not exactly match',
		);
	});

	it('rejects more than one node-controlled fee input', () => {
		expect(() => validate(buildDraft({ feeInputHashes: [FUEL_TX_HASH, 'd'.repeat(64)] }))).toThrow(
			'exactly one L1 fee input',
		);
	});

	it('rejects a lookalike output at an untrusted script', () => {
		expect(() => validate(buildDraft({ depositAddress: OTHER_SCRIPT_ADDRESS }))).toThrow(
			'exactly one output at the trusted Hydra deposit script',
		);
	});

	it('rejects a trusted payment script wrapped in an attacker staking address', () => {
		const scriptCredential = EnterpriseAddress.from_address(Address.from_bech32(DEPOSIT_ADDRESS))?.payment_cred();
		expect(scriptCredential).toBeDefined();
		const stakedDepositAddress = BaseAddress.new(
			0,
			scriptCredential!,
			Credential.from_keyhash(Ed25519KeyHash.from_hex('e'.repeat(56))),
		)
			.to_address()
			.to_bech32();
		expect(() => validate(buildDraft({ depositAddress: stakedDepositAddress }))).toThrow(
			'trusted enterprise script address shape',
		);
	});

	it('rejects an excessive L1 fee', () => {
		expect(() => validate(buildDraft({ fee: 10_000_001n }))).toThrow('exceeds the 10000000 lovelace limit');
	});

	it('rejects an expired deposit deadline', () => {
		expect(() => validate(buildDraft({ deadlineMs: NOW_MS - 600_000 }))).toThrow(
			'deadline is expired or unreasonably far',
		);
	});

	it('rejects a validity upper bound detached from the current L1 slot', () => {
		expect(() => validate(buildDraft({ ttl: 129_200_000 }))).toThrow(
			'upper validity bound is stale or unreasonably far in the future',
		);
	});

	it('requires the validity upper bound to precede the recovery deadline', () => {
		expect(() => validate(buildDraft({ ttl: 129_100_060 }))).toThrow(
			'upper validity bound does not precede the deposit deadline',
		);
	});

	it('pins the trusted deposit script catalogue hash', () => {
		expect(DEFAULT_HYDRA_DEPOSIT_SCRIPT_HASH).toBe('c78e8c9205721eb3ef4410f3db9c6169fa6db497c24641d29c20529c');
	});
});

describe('assertHydraCommitSignedBody', () => {
	it('accepts witness-only signing and rejects a changed transaction body', () => {
		const original = buildDraft();
		const validated = validate(original);

		expect(() => assertHydraCommitSignedBody(original.cborHex, validated.txId)).not.toThrow();
		expect(() => assertHydraCommitSignedBody(buildDraft({ fee: 400_001n }).cborHex, validated.txId)).toThrow(
			'changed the validated commit transaction body',
		);
	});
});

function validate(draft: HydraTransaction) {
	return validateHydraCommitDraft(baseValidationOptions(draft));
}

function baseValidationOptions(draft: HydraTransaction) {
	return {
		draft,
		commitUtxos: [commitUtxo],
		fuelUtxos: [fuelUtxo],
		walletUtxos: [commitUtxo, fuelUtxo],
		expectedHeadId: HEAD_ID,
		nowMs: NOW_MS,
		slotConfig: SLOT_CONFIG,
	};
}

function utxo(txHash: string, outputIndex: number, address: string, lovelace: string): UTxO {
	return {
		input: { txHash, outputIndex },
		output: {
			address,
			amount: [{ unit: 'lovelace', quantity: lovelace }],
		},
	};
}

function buildDraft({
	serializedOutput = SERIALIZED_COMMIT_OUTPUT,
	depositAddress = DEPOSIT_ADDRESS,
	deadlineMs = NOW_MS + 60_000,
	feeInputHashes = [FUEL_TX_HASH],
	fee = 400_000n,
	changeAddress = NODE_CHANGE_ADDRESS,
	changeLovelace = 999_600_000n,
	ttl = 129_100_000,
}: {
	serializedOutput?: string;
	depositAddress?: string;
	deadlineMs?: number;
	feeInputHashes?: string[];
	fee?: bigint;
	changeAddress?: string;
	changeLovelace?: bigint;
	ttl?: number;
} = {}): HydraTransaction {
	const inputs = TransactionInputs.new();
	inputs.add(TransactionInput.new(TransactionHash.from_hex(COMMIT_TX_HASH), 1));
	for (const txHash of feeInputHashes) {
		inputs.add(TransactionInput.new(TransactionHash.from_hex(txHash), 0));
	}

	const depositOutput = TransactionOutput.new(
		Address.from_bech32(depositAddress),
		Value.new(BigNum.from_str('5000000')),
	);
	depositOutput.set_plutus_data(
		constructor(0, [
			PlutusData.new_bytes(Buffer.from(HEAD_ID, 'hex')),
			PlutusData.new_integer(CardanoBigInt.from_str(deadlineMs.toString())),
			list([
				constructor(0, [
					constructor(0, [
						PlutusData.new_bytes(Buffer.from(COMMIT_TX_HASH, 'hex')),
						PlutusData.new_integer(CardanoBigInt.from_str('1')),
					]),
					PlutusData.new_bytes(Buffer.from(serializedOutput, 'hex')),
				]),
			]),
		]),
	);
	const changeOutput = TransactionOutput.new(
		Address.from_bech32(changeAddress),
		Value.new(BigNum.from_str(changeLovelace.toString())),
	);
	const outputs = TransactionOutputs.new();
	outputs.add(depositOutput);
	outputs.add(changeOutput);

	const body = TransactionBody.new_tx_body(inputs, outputs, BigNum.from_str(fee.toString()));
	body.set_ttl(BigNum.from_str(ttl.toString()));
	const transaction = Transaction.new(body, TransactionWitnessSet.new());
	return {
		type: HydraTransactionType.TxConwayEra,
		description: '',
		cborHex: transaction.to_hex(),
	};
}

function constructor(alternative: number, fields: PlutusData[]): PlutusData {
	const fieldList = PlutusList.new();
	for (const field of fields) fieldList.add(field);
	return PlutusData.new_constr_plutus_data(ConstrPlutusData.new(BigNum.from_str(alternative.toString()), fieldList));
}

function list(items: PlutusData[]): PlutusData {
	const values = PlutusList.new();
	for (const item of items) values.add(item);
	return PlutusData.new_list(values);
}
