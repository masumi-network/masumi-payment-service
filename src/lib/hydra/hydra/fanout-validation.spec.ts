import {
	Address,
	AssetName,
	BigNum,
	Credential,
	Ed25519KeyHash,
	EnterpriseAddress,
	Int,
	Assets,
	Mint,
	MintAssets,
	MultiAsset,
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
	/** Distributed outputs only; the continuing head output is not one. */
	outputs: TransactionOutput[];
	firstDistributedIndex: number;
	/** The head state-machine output this body spends. */
	headInput: { txHash: string; index: number };
};

function headTokenValue(lovelace: number): Value {
	const value = Value.new(BigNum.from_str(String(lovelace)));
	const assets = Assets.new();
	for (const assetName of [HYDRA_HEAD_V2_ASSET_NAME_HEX, LOCAL_PARTICIPANT, REMOTE_PARTICIPANT]) {
		assets.insert(AssetName.new(Buffer.from(assetName, 'hex')), BigNum.from_str('1'));
	}
	const multiasset = MultiAsset.new();
	multiasset.insert(ScriptHash.from_hex(HEAD_ID), assets);
	value.set_multiasset(multiasset);
	return value;
}

function buildFanout(options?: {
	outputCount?: number;
	burns?: Array<{ assetName: string; quantity: number }>;
	fee?: string;
	/** Which head state-machine output this step spends. */
	headInput?: { txHash: string; index: number };
	/**
	 * Carry the head forward as output 0, the way an intermediate partial fanout
	 * step does. Such a step burns nothing, so `burns` is normally `[]` with it.
	 */
	continuingHead?: boolean;
}): BuiltFanout {
	const inputs = TransactionInputs.new();
	const headInput = options?.headInput ?? { txHash: HEAD_INPUT_HASH, index: 0 };
	inputs.add(TransactionInput.new(TransactionHash.from_hex(headInput.txHash), headInput.index));
	const outputs = TransactionOutputs.new();
	const outputValues: TransactionOutput[] = [];
	if (options?.continuingHead) {
		// Never a distributed output: it is the head itself, moving on.
		outputs.add(TransactionOutput.new(Address.from_bech32(HEAD_ADDRESS), headTokenValue(2_000_000)));
	}
	for (let index = 0; index < (options?.outputCount ?? 1); index += 1) {
		const output = TransactionOutput.new(
			Address.from_bech32(OUTPUT_ADDRESS),
			Value.new(BigNum.from_str(String(5_000_000 + index))),
		);
		outputs.add(output);
		outputValues.push(output);
	}
	const body = TransactionBody.new_tx_body(inputs, outputs, BigNum.from_str(options?.fee ?? '200000'));
	const burns = options?.burns ?? [
		{ assetName: HYDRA_HEAD_V2_ASSET_NAME_HEX, quantity: -1 },
		{ assetName: LOCAL_PARTICIPANT, quantity: -1 },
		{ assetName: REMOTE_PARTICIPANT, quantity: -1 },
	];
	if (burns.length > 0) {
		const mintAssets = MintAssets.new();
		for (const burn of burns) {
			mintAssets.insert(
				AssetName.new(Buffer.from(burn.assetName, 'hex')),
				burn.quantity < 0
					? Int.new_negative(BigNum.from_str(String(-burn.quantity)))
					: Int.new(BigNum.from_str(String(burn.quantity))),
			);
		}
		body.set_mint(Mint.new_from_entry(ScriptHash.from_hex(HEAD_ID), mintAssets));
	}
	const transaction = Transaction.new(body, TransactionWitnessSet.new());
	const cbor = transaction.to_hex();
	return {
		txHash: String(resolveTxHash(cbor)).toLowerCase(),
		cbor,
		outputs: outputValues,
		firstDistributedIndex: options?.continuingHead ? 1 : 0,
		headInput,
	};
}

function fixture(options?: {
	fanout?: BuiltFanout;
	/** A whole chain, in order, terminal last. Overrides `fanout`. */
	chain?: BuiltFanout[];
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
	chain: BuiltFanout[];
} {
	const chain = options?.chain ?? [options?.fanout ?? buildFanout()];
	const byTxHash = new Map(chain.map((step) => [step.txHash, step]));
	const stepFor = (txHash: string): BuiltFanout => {
		const step = byTxHash.get(txHash);
		if (!step) throw new Error(`fixture asked for an unknown fanout transaction ${txHash}`);
		return step;
	};
	// Whatever the body actually spends, not what its position implies — a test
	// that builds a broken link has to be able to report the broken link.
	const headInputOf = (txHash: string): { tx_hash: string; output_index: number } => ({
		tx_hash: stepFor(txHash).headInput.txHash,
		output_index: stepFor(txHash).headInput.index,
	});
	const observer: HydraFanoutChainObserver = {
		txs: jest.fn(async (txHash: string) => ({
			hash: stepFor(txHash).txHash,
			block: 'block-1',
			block_height: 123,
			block_time: 456,
			fees: '200000',
			output_amount: [{ unit: 'lovelace', quantity: '5000000' }],
			utxo_count: stepFor(txHash).outputs.length,
			withdrawal_count: 0,
			asset_mint_or_burn_count: 3,
			redeemer_count: 1,
			valid_contract: options?.validContract ?? true,
		})),
		blocks: jest.fn(async () => ({ confirmations: options?.confirmations ?? 8 })),
		txsCbor: jest.fn(async (txHash: string) => ({ cbor: stepFor(txHash).cbor })),
		txsUtxos: jest.fn(async (txHash: string) => ({
			hash: stepFor(txHash).txHash,
			inputs: [
				{
					...headInputOf(txHash),
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
		fanout: chain[chain.length - 1],
		chain,
		references: chain.flatMap((step) =>
			step.outputs.map((output, offset) => ({
				txHash: step.txHash,
				outputIndex: offset + step.firstDistributedIndex,
				snapshotNumber: 7,
				serializedOutput: serializeCardanoTransactionOutput(output),
			})),
		),
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
		await expect(verify(value)).resolves.toEqual([
			expect.objectContaining({
				txHash: value.fanout.txHash,
				confirmations: 8,
				validContract: true,
			}),
		]);
	});

	it('rejects repeated or missing output indices', async () => {
		const twoOutputs = fixture({ fanout: buildFanout({ outputCount: 2 }) });
		await expect(
			verify(twoOutputs, {
				references: [twoOutputs.references[0], { ...twoOutputs.references[1], outputIndex: 0 }],
			}),
		).rejects.toThrow('repeated an L1 output index');
		await expect(
			verify(twoOutputs, { references: [twoOutputs.references[1], { ...twoOutputs.references[0], outputIndex: 2 }] }),
		).rejects.toThrow('complete L1 fanout output sequence');
	});

	// A head too large to empty in one transaction is fanned out over several
	// (hydra-node 2.2.0). Rejecting that outright left every escrow in such a
	// head marked L2 against a head that no longer existed.
	describe('partial fanout chains', () => {
		/** Two partial steps, then the step that burns the head tokens. */
		function chainFixture() {
			const first = buildFanout({ outputCount: 2, continuingHead: true, burns: [] });
			const second = buildFanout({
				outputCount: 2,
				continuingHead: true,
				burns: [],
				headInput: { txHash: first.txHash, index: 0 },
			});
			const terminal = buildFanout({ outputCount: 1, headInput: { txHash: second.txHash, index: 0 } });
			return fixture({ chain: [first, second, terminal] });
		}

		it('accepts a chain of partial steps ending in the token burn', async () => {
			const value = chainFixture();

			await expect(verify(value)).resolves.toEqual([
				expect.objectContaining({ txHash: value.chain[0].txHash }),
				expect.objectContaining({ txHash: value.chain[1].txHash }),
				expect.objectContaining({ txHash: value.chain[2].txHash }),
			]);
		});

		// The distributed outputs of a partial step start after the head it carries
		// forward. Reading them from index 0 would adopt the head output itself.
		it('never treats the continuing head output as distributed', async () => {
			const value = chainFixture();

			expect(value.references.filter((reference) => reference.txHash === value.chain[0].txHash)).toEqual([
				expect.objectContaining({ outputIndex: 1 }),
				expect.objectContaining({ outputIndex: 2 }),
			]);
		});

		// The burn is what ends the head on chain, so it cannot happen twice.
		it('rejects a chain with more than one burning step', async () => {
			const first = buildFanout({ outputCount: 1 });
			const second = buildFanout({ outputCount: 1, headInput: { txHash: first.txHash, index: 0 } });

			await expect(verify(fixture({ chain: [first, second] }))).rejects.toThrow('exactly once');
		});

		it('rejects a chain that never burns the head tokens', async () => {
			const only = buildFanout({ outputCount: 1, continuingHead: true, burns: [] });

			await expect(verify(fixture({ chain: [only] }))).rejects.toThrow('exactly once');
		});

		// Without the linkage check, any transaction that merely spends some head
		// output could be spliced in beside the real chain.
		it('rejects a step that does not consume its predecessor', async () => {
			const first = buildFanout({ outputCount: 1, continuingHead: true, burns: [] });
			const unlinked = buildFanout({ outputCount: 1, headInput: { txHash: '66'.repeat(32), index: 0 } });
			const value = fixture({ chain: [first, unlinked] });

			await expect(verify(value)).rejects.toThrow('outside the chain ending in its token burn');
		});

		// The head may only be picked up where its predecessor actually put it.
		it('rejects a step consuming an output that is not the continuing head', async () => {
			const first = buildFanout({ outputCount: 1, continuingHead: true, burns: [] });
			const terminal = buildFanout({ outputCount: 1, headInput: { txHash: first.txHash, index: 1 } });
			const value = fixture({ chain: [first, terminal] });
			// The fixture links steps at index 0; point this one at index 1 instead.
			value.observer.txsUtxos = jest.fn(async (txHash: string) => ({
				hash: txHash,
				inputs: [
					{
						tx_hash: txHash === terminal.txHash ? first.txHash : HEAD_INPUT_HASH,
						output_index: txHash === terminal.txHash ? 1 : 0,
						address: HEAD_ADDRESS,
						amount: [
							{ unit: 'lovelace', quantity: '5000000' },
							{ unit: STATE_UNIT, quantity: '1' },
							{ unit: LOCAL_UNIT, quantity: '1' },
							{ unit: REMOTE_UNIT, quantity: '1' },
						],
					},
				],
			})) as HydraFanoutChainObserver['txsUtxos'];

			await expect(verify(value)).rejects.toThrow('continuing head output of its predecessor');
		});

		it('rejects a partial step that touches the head tokens', async () => {
			const first = buildFanout({
				outputCount: 1,
				continuingHead: true,
				burns: [{ assetName: LOCAL_PARTICIPANT, quantity: -1 }],
			});
			const terminal = buildFanout({ outputCount: 1, headInput: { txHash: first.txHash, index: 0 } });

			await expect(verify(fixture({ chain: [first, terminal] }))).rejects.toThrow(
				'minted or burned head-policy tokens',
			);
		});

		// Without the head carried forward there is nothing for the next step to
		// spend, so a step shaped like this cannot be part of a real chain.
		it('rejects a non-burning step with no continuing head output', async () => {
			const first = buildFanout({ outputCount: 1, burns: [] });
			const terminal = buildFanout({ outputCount: 1, headInput: { txHash: first.txHash, index: 0 } });
			const value = fixture({ chain: [first, terminal] });

			await expect(verify(value)).rejects.toThrow('produced no continuing head output');
		});
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
			'minted or burned head-policy tokens',
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
