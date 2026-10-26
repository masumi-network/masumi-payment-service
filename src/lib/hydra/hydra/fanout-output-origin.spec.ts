import {
	Address,
	AssetName,
	Assets,
	BigNum,
	Credential,
	Ed25519KeyHash,
	EnterpriseAddress,
	Int,
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
import { TransactionLayer } from '@/generated/prisma/client';
import { DEFAULT_HYDRA_HEAD_SCRIPT_HASH, HYDRA_HEAD_V2_ASSET_NAME_HEX } from './head-init-validation';
import { isBoundFanoutOutputOrigin } from './fanout-output-origin';
import type { HydraFanoutChainObserver } from './fanout-validation';

const HEAD_ID = 'ab'.repeat(28);
const LOCAL = '11'.repeat(28);
const REMOTE = '22'.repeat(28);
const LOCAL_FUNDING_WALLET = '66'.repeat(28);
const REMOTE_FUNDING_WALLET = '77'.repeat(28);
const INPUT_HASH = '33'.repeat(32);
const mockFindHead = jest.fn<(_query: unknown) => Promise<unknown>>();
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHead: { findUnique: mockFindHead } },
}));
const { deferSpendUntilFanoutHandoff, PendingFanoutHandoffError } =
	await import('@/services/transactions/tx-sync/tx/pending-fanout-handoff');
const headAddress = EnterpriseAddress.new(
	0,
	Credential.from_scripthash(ScriptHash.from_hex(DEFAULT_HYDRA_HEAD_SCRIPT_HASH)),
)
	.to_address()
	.to_bech32();
const contractAddress = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex('44'.repeat(28))))
	.to_address()
	.to_bech32();

function headValue(): Value {
	const value = Value.new(BigNum.from_str('2000000'));
	const assets = Assets.new();
	for (const name of [HYDRA_HEAD_V2_ASSET_NAME_HEX, LOCAL, REMOTE]) {
		assets.insert(AssetName.new(Buffer.from(name, 'hex')), BigNum.from_str('1'));
	}
	const multiasset = MultiAsset.new();
	multiasset.insert(ScriptHash.from_hex(HEAD_ID), assets);
	value.set_multiasset(multiasset);
	return value;
}

function fixture(inputAddress = headAddress, terminal = false) {
	const inputs = TransactionInputs.new();
	inputs.add(TransactionInput.new(TransactionHash.from_hex(INPUT_HASH), 0));
	const outputs = TransactionOutputs.new();
	if (!terminal) outputs.add(TransactionOutput.new(Address.from_bech32(headAddress), headValue()));
	outputs.add(TransactionOutput.new(Address.from_bech32(contractAddress), Value.new(BigNum.from_str('5000000'))));
	const body = TransactionBody.new_tx_body(inputs, outputs, BigNum.from_str('200000'));
	if (terminal) {
		const burns = MintAssets.new();
		for (const name of [HYDRA_HEAD_V2_ASSET_NAME_HEX, LOCAL, REMOTE]) {
			burns.insert(AssetName.new(Buffer.from(name, 'hex')), Int.new_negative(BigNum.from_str('1')));
		}
		body.set_mint(Mint.new_from_entry(ScriptHash.from_hex(HEAD_ID), burns));
	}
	const cbor = Transaction.new(body, TransactionWitnessSet.new()).to_hex();
	const txHash = String(resolveTxHash(cbor)).toLowerCase();
	const observer: HydraFanoutChainObserver = {
		txs: jest.fn(async () => ({ hash: txHash, valid_contract: true })) as never,
		txsCbor: jest.fn(async () => ({ cbor })),
		txsUtxos: jest.fn(async () => ({
			hash: txHash,
			inputs: [
				{
					tx_hash: INPUT_HASH,
					output_index: 0,
					address: inputAddress,
					amount: [
						{ unit: 'lovelace', quantity: '2000000' },
						...[HYDRA_HEAD_V2_ASSET_NAME_HEX, LOCAL, REMOTE].map((name) => ({
							unit: `${HEAD_ID}${name}`,
							quantity: '1',
						})),
					],
				},
			],
		})),
		blocks: jest.fn(async () => ({ confirmations: 10 })),
	};
	return { observer, txHash };
}

describe('partial fanout output origin', () => {
	it.each([false, true])('defers a fanout spend with separate funding wallet keys (terminal: %s)', async (terminal) => {
		const { observer, txHash } = fixture(headAddress, terminal);
		mockFindHead.mockResolvedValue({
			headIdentifier: HEAD_ID,
			LocalParticipant: { cardanoVkey: LOCAL },
			RemoteParticipants: [{ cardanoVkey: REMOTE }],
			HydraRelation: {
				LocalHotWallet: { walletVkey: LOCAL_FUNDING_WALLET },
				RemoteWallet: { walletVkey: REMOTE_FUNDING_WALLET },
			},
		});
		await expect(
			deferSpendUntilFanoutHandoff(
				{
					layer: TransactionLayer.L2,
					CurrentTransaction: { layer: TransactionLayer.L2, hydraHeadId: 'head-1' },
				},
				{
					tx_hash: txHash,
					output_index: terminal ? 0 : 1,
					amount: [{ unit: 'lovelace', quantity: '5000000' }],
				},
				contractAddress,
				observer as never,
			),
		).rejects.toBeInstanceOf(PendingFanoutHandoffError);
	});

	it('recognizes a spendable output from this head state token', async () => {
		const { observer, txHash } = fixture();
		await expect(
			isBoundFanoutOutputOrigin({
				observer,
				headId: HEAD_ID,
				participantVkeys: [LOCAL, REMOTE],
				producerTxHash: txHash,
				outputIndex: 1,
				contractAddress,
				indexedAmounts: [{ unit: 'lovelace', quantity: '5000000' }],
			}),
		).resolves.toBe(true);
	});

	it('rejects a copied datum whose producer never spent this head', async () => {
		const attackerAddress = EnterpriseAddress.new(0, Credential.from_keyhash(Ed25519KeyHash.from_hex('55'.repeat(28))))
			.to_address()
			.to_bech32();
		const { observer, txHash } = fixture(attackerAddress);
		await expect(
			isBoundFanoutOutputOrigin({
				observer,
				headId: HEAD_ID,
				participantVkeys: [LOCAL, REMOTE],
				producerTxHash: txHash,
				outputIndex: 1,
				contractAddress,
				indexedAmounts: [{ unit: 'lovelace', quantity: '5000000' }],
			}),
		).resolves.toBe(false);
	});

	it('also recognizes the final step that burns the head tokens', async () => {
		const { observer, txHash } = fixture(headAddress, true);
		await expect(
			isBoundFanoutOutputOrigin({
				observer,
				headId: HEAD_ID,
				participantVkeys: [LOCAL, REMOTE],
				producerTxHash: txHash,
				outputIndex: 0,
				contractAddress,
				indexedAmounts: [{ unit: 'lovelace', quantity: '5000000' }],
			}),
		).resolves.toBe(true);
	});
});
