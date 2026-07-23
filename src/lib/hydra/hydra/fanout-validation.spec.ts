import {
	Address,
	AssetName,
	BigNum,
	Credential,
	Ed25519KeyHash,
	EnterpriseAddress,
	Int,
	Mint,
	MintAssets,
	ScriptHash,
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
import { resolveTxHash } from '@meshsdk/core';
import { describe, expect, it, jest } from '@jest/globals';

import { DEFAULT_HYDRA_HEAD_SCRIPT_HASH, HYDRA_HEAD_V2_ASSET_NAME_HEX } from './head-init-validation';
import {
	HydraFanoutValidationError,
	verifyHydraFanoutOnChain,
	type HydraFanoutChainObserver,
} from './fanout-validation';
import { serializeCardanoTransactionOutput } from './snapshot-verification';

const HEAD_ID = 'ab'.repeat(28);
const LOCAL_PARTICIPANT = '11'.repeat(28);
const REMOTE_PARTICIPANT = '22'.repeat(28);
const HEAD_INPUT_HASH = '33'.repeat(32);
const STATE_UNIT = `${HEAD_ID}${HYDRA_HEAD_V2_ASSET_NAME_HEX}`;
const LOCAL_UNIT = `${HEAD_ID}${LOCAL_PARTICIPANT}`;
const REMOTE_UNIT = `${HEAD_ID}${REMOTE_PARTICIPANT}`;
const HEAD_ADDRESS = EnterpriseAddress.new(
	0,
	Credential.from_scripthash(ScriptHash.from_hex(DEFAULT_HYDRA_HEAD_SCRIPT_HASH)),
)
	.to_address()
	.to_bech32();
const OUTPUT_ADDRESS = EnterpriseAddress.new(0, Credential.from_keyhash(Ed25519KeyHash.from_hex('44'.repeat(28))))
	.to_address()
	.to_bech32();

type BuiltFanout = {
	txHash: string;
	cbor: string;
	outputs: TransactionOutput[];
};

function buildFanout(options?: {
	outputCount?: number;
	burns?: Array<{ assetName: string; quantity: number }>;
	fee?: string;
}): BuiltFanout {
	const inputs = TransactionInputs.new();
	inputs.add(TransactionInput.new(TransactionHash.from_hex(HEAD_INPUT_HASH), 0));
	const outputs = TransactionOutputs.new();
	const outputValues: TransactionOutput[] = [];
	for (let index = 0; index < (options?.outputCount ?? 1); index += 1) {
		const output = TransactionOutput.new(
			Address.from_bech32(OUTPUT_ADDRESS),
			Value.new(BigNum.from_str(String(5_000_000 + index))),
		);
		outputs.add(output);
		outputValues.push(output);
	}
	const body = TransactionBody.new_tx_body(inputs, outputs, BigNum.from_str(options?.fee ?? '200000'));
	const mintAssets = MintAssets.new();
	for (const burn of options?.burns ?? [
		{ assetName: HYDRA_HEAD_V2_ASSET_NAME_HEX, quantity: -1 },
		{ assetName: LOCAL_PARTICIPANT, quantity: -1 },
		{ assetName: REMOTE_PARTICIPANT, quantity: -1 },
	]) {
		mintAssets.insert(
			AssetName.new(Buffer.from(burn.assetName, 'hex')),
			burn.quantity < 0
				? Int.new_negative(BigNum.from_str(String(-burn.quantity)))
				: Int.new(BigNum.from_str(String(burn.quantity))),
		);
	}
	body.set_mint(Mint.new_from_entry(ScriptHash.from_hex(HEAD_ID), mintAssets));
	const transaction = Transaction.new(body, TransactionWitnessSet.new());
	const cbor = transaction.to_hex();
	return { txHash: String(resolveTxHash(cbor)).toLowerCase(), cbor, outputs: outputValues };
}

function fixture(options?: {
	fanout?: BuiltFanout;
	confirmations?: number;
	validContract?: boolean;
	headAddress?: string;
	headAmounts?: Array<{ unit: string; quantity: string }>;
}): {
	observer: HydraFanoutChainObserver;
	references: Array<{
		txHash: string;
		outputIndex: number;
		snapshotNumber: number;
		serializedOutput: string;
	}>;
	fanout: BuiltFanout;
} {
	const fanout = options?.fanout ?? buildFanout();
	const observer: HydraFanoutChainObserver = {
		txs: jest.fn(async () => ({
			hash: fanout.txHash,
			block: 'block-1',
			block_height: 123,
			block_time: 456,
			fees: '200000',
			output_amount: [{ unit: 'lovelace', quantity: '5000000' }],
			utxo_count: fanout.outputs.length,
			withdrawal_count: 0,
			asset_mint_or_burn_count: 3,
			redeemer_count: 1,
			valid_contract: options?.validContract ?? true,
		})),
		blocks: jest.fn(async () => ({ confirmations: options?.confirmations ?? 8 })),
		txsCbor: jest.fn(async () => ({ cbor: fanout.cbor })),
		txsUtxos: jest.fn(async () => ({
			hash: fanout.txHash,
			inputs: [
				{
					tx_hash: HEAD_INPUT_HASH,
					output_index: 0,
					address: options?.headAddress ?? HEAD_ADDRESS,
					amount: options?.headAmounts ?? [
						{ unit: 'lovelace', quantity: '5000000' },
						{ unit: STATE_UNIT, quantity: '1' },
						{ unit: LOCAL_UNIT, quantity: '1' },
						{ unit: REMOTE_UNIT, quantity: '1' },
					],
				},
			],
		})),
	};
	return {
		observer,
		fanout,
		references: fanout.outputs.map((output, outputIndex) => ({
			txHash: fanout.txHash,
			outputIndex,
			snapshotNumber: 7,
			serializedOutput: serializeCardanoTransactionOutput(output),
		})),
	};
}

function verify(
	value: ReturnType<typeof fixture>,
	overrides?: {
		references?: ReturnType<typeof fixture>['references'];
		observerTimeoutMs?: number;
	},
) {
	return verifyHydraFanoutOnChain({
		observer: value.observer,
		headId: HEAD_ID,
		participantVkeys: [LOCAL_PARTICIPANT, REMOTE_PARTICIPANT],
		references: overrides?.references ?? value.references,
		requiredConfirmations: 5,
		observerTimeoutMs: overrides?.observerTimeoutMs,
	});
}

describe('verifyHydraFanoutOnChain', () => {
	it('accepts one fully bound, confirmed official fanout transaction', async () => {
		const value = fixture();
		await expect(verify(value)).resolves.toEqual(
			expect.objectContaining({
				txHash: value.fanout.txHash,
				confirmations: 8,
				validContract: true,
			}),
		);
	});

	it('rejects mixed transaction hashes and repeated or missing output indices', async () => {
		const twoOutputs = fixture({ fanout: buildFanout({ outputCount: 2 }) });
		await expect(
			verify(twoOutputs, {
				references: [twoOutputs.references[0], { ...twoOutputs.references[1], txHash: '55'.repeat(32) }],
			}),
		).rejects.toThrow('one L1 fanout transaction');
		await expect(
			verify(twoOutputs, {
				references: [twoOutputs.references[0], { ...twoOutputs.references[1], outputIndex: 0 }],
			}),
		).rejects.toThrow('repeated an L1 output index');
		await expect(
			verify(twoOutputs, { references: [twoOutputs.references[1], { ...twoOutputs.references[0], outputIndex: 2 }] }),
		).rejects.toThrow('complete L1 fanout output sequence');
	});

	it('rejects insufficient confirmations, invalid phase-2 execution, and a CBOR/hash mismatch', async () => {
		await expect(verify(fixture({ confirmations: 4 }))).rejects.toThrow('confirmation depth');
		await expect(verify(fixture({ validContract: false }))).rejects.toThrow('phase-2 validity');
		const value = fixture();
		const other = buildFanout({ fee: '200001' });
		jest.mocked(value.observer.txsCbor).mockResolvedValue({ cbor: other.cbor });
		await expect(verify(value)).rejects.toThrow('CBOR hash');
	});

	it('rejects a missing or token-substituted official vHead input', async () => {
		const attackerAddress = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex('66'.repeat(28))))
			.to_address()
			.to_bech32();
		await expect(verify(fixture({ headAddress: attackerAddress }))).rejects.toThrow('official vHead');
		await expect(
			verify(
				fixture({
					headAmounts: [
						{ unit: 'lovelace', quantity: '5000000' },
						{ unit: STATE_UNIT, quantity: '1' },
						{ unit: LOCAL_UNIT, quantity: '1' },
						{ unit: `${HEAD_ID}${'77'.repeat(28)}`, quantity: '1' },
					],
				}),
			),
		).rejects.toThrow('official vHead');
	});

	it.each([
		[
			'missing',
			[
				{ assetName: HYDRA_HEAD_V2_ASSET_NAME_HEX, quantity: -1 },
				{ assetName: LOCAL_PARTICIPANT, quantity: -1 },
			],
		],
		[
			'extra',
			[
				{ assetName: HYDRA_HEAD_V2_ASSET_NAME_HEX, quantity: -1 },
				{ assetName: LOCAL_PARTICIPANT, quantity: -1 },
				{ assetName: REMOTE_PARTICIPANT, quantity: -1 },
				{ assetName: '99', quantity: -1 },
			],
		],
		[
			'wrong quantity',
			[
				{ assetName: HYDRA_HEAD_V2_ASSET_NAME_HEX, quantity: -1 },
				{ assetName: LOCAL_PARTICIPANT, quantity: -1 },
				{ assetName: REMOTE_PARTICIPANT, quantity: -2 },
			],
		],
	] as const)('rejects a %s head-policy burn', async (_label, burns) => {
		await expect(verify(fixture({ fanout: buildFanout({ burns: [...burns] }) }))).rejects.toThrow(
			'exact bound head and participant token set',
		);
	});

	it('rejects incomplete/extra output coverage and a changed serialized output', async () => {
		const extraOutput = fixture({ fanout: buildFanout({ outputCount: 2 }) });
		await expect(verify(extraOutput, { references: [extraOutput.references[0]] })).rejects.toThrow(
			'complete L1 fanout output sequence',
		);
		const value = fixture();
		await expect(
			verify(value, {
				references: [{ ...value.references[0], serializedOutput: `${value.references[0].serializedOutput}00` }],
			}),
		).rejects.toThrow('did not match the signed final snapshot');
	});

	it('bounds a hung independent observer', async () => {
		const value = fixture();
		jest.mocked(value.observer.txs).mockImplementation(async () => await new Promise(() => undefined));
		await expect(verify(value, { observerTimeoutMs: 10 })).rejects.toBeInstanceOf(HydraFanoutValidationError);
	});
});
