import { describe, expect, it } from '@jest/globals';
import { FixedTransaction, PlutusData } from '@emurgo/cardano-serialization-lib-nodejs';
import { MeshWallet, resolvePaymentKeyHash, type UTxO } from '@meshsdk/core';
import {
	buildOwnerDecommitTx,
	buildOwnerDepositBlueprint,
	L2_WALLET_SPEND_EX_UNITS,
	prepareOwnerDecommit,
} from './hydra-transfer';
import { SmartWalletAction } from './wallet';
import { loadSmartWalletScript } from './wallet-lifecycle';

const WALLET_DATUM = 'd8799f4100ff';

async function newAddress(): Promise<string> {
	const wallet = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words: MeshWallet.brew() as string[] } });
	await wallet.init();
	return await wallet.getChangeAddress();
}

async function fixture() {
	const ownerAddress = await newAddress();
	const agentAddress = await newAddress();
	const script = loadSmartWalletScript({
		ownerAddress,
		quorumVkhs: ['a1'.repeat(28), 'a2'.repeat(28)],
		threshold: 2,
		network: 'preprod',
	});
	const walletUtxo: UTxO = {
		input: { txHash: 'ee'.repeat(32), outputIndex: 2 },
		output: {
			address: script.address,
			amount: [
				{ unit: 'lovelace', quantity: '100000000' },
				{ unit: `${script.policyId}${'dd'.repeat(32)}`, quantity: '1' },
			],
			plutusData: WALLET_DATUM,
		},
	};
	const collateral: UTxO = {
		input: { txHash: 'ff'.repeat(32), outputIndex: 0 },
		output: { address: agentAddress, amount: [{ unit: 'lovelace', quantity: '6000000' }] },
	};
	return { script, ownerAddress, agentAddress, walletUtxo, collateral };
}

function requiredSigners(cborHex: string): string[] {
	const signers = FixedTransaction.from_hex(cborHex).body().required_signers();
	return Array.from({ length: signers?.len() ?? 0 }, (_, i) => signers!.get(i).to_hex());
}

describe('buildOwnerDepositBlueprint', () => {
	it('spends the wallet under OwnerSpend, signed by the owner alone, with no outputs', async () => {
		const { script, ownerAddress, walletUtxo } = await fixture();

		const blueprint = buildOwnerDepositBlueprint({ script, walletUtxo, network: 'preprod' });

		const tx = FixedTransaction.from_hex(blueprint);
		expect(tx.body().inputs().len()).toBe(1);
		expect(tx.body().inputs().get(0).index()).toBe(2);
		expect(tx.body().outputs().len()).toBe(0);
		expect(requiredSigners(blueprint)).toEqual([resolvePaymentKeyHash(ownerAddress)]);
		expect(tx.witness_set().redeemers()?.get(0).data().as_constr_plutus_data()?.alternative().to_str()).toBe(
			String(SmartWalletAction.OwnerSpend),
		);
	});
});

describe('buildOwnerDecommitTx', () => {
	it('recreates the wallet output unchanged at zero fee, the collateral returned to the agent', async () => {
		const { script, ownerAddress, agentAddress, walletUtxo, collateral } = await fixture();

		const { unsignedTx, txHash } = await buildOwnerDecommitTx({
			script,
			walletUtxo,
			collateral,
			headCostModels: {},
			network: 'preprod',
		});

		const tx = FixedTransaction.from_hex(unsignedTx);
		const body = tx.body();
		expect(tx.transaction_hash().to_hex()).toBe(txHash);
		expect(body.fee().to_str()).toBe('0');
		expect(body.total_collateral()?.to_str()).toBe('0');
		expect(body.collateral_return()?.address().to_bech32()).toBe(agentAddress);
		expect(body.collateral_return()?.amount().coin().to_str()).toBe('6000000');
		expect(body.outputs().len()).toBe(1);
		const out = body.outputs().get(0);
		expect(out.address().to_bech32()).toBe(script.address);
		expect(out.amount().coin().to_str()).toBe('100000000');
		expect(out.amount().multiasset()?.len()).toBe(1);
		expect(out.plutus_data()?.to_hex()).toBe(PlutusData.from_hex(WALLET_DATUM).to_hex());
		expect(requiredSigners(unsignedTx)).toEqual([resolvePaymentKeyHash(ownerAddress)]);
		const redeemer = tx.witness_set().redeemers()?.get(0);
		expect(redeemer?.data().as_constr_plutus_data()?.alternative().to_str()).toBe(String(SmartWalletAction.OwnerSpend));
		expect(redeemer?.ex_units().mem().to_str()).toBe(String(L2_WALLET_SPEND_EX_UNITS.mem));
	});

	it('refuses a wallet UTxO without an inline datum', async () => {
		const { script, walletUtxo, collateral } = await fixture();
		const bare = { ...walletUtxo, output: { ...walletUtxo.output, plutusData: undefined } };

		await expect(
			buildOwnerDecommitTx({ script, walletUtxo: bare, collateral, headCostModels: {}, network: 'preprod' }),
		).rejects.toThrow('carries no inline datum');
	});
});

describe('prepareOwnerDecommit', () => {
	it('adds the agent witness without changing the body the owner signs', async () => {
		const { ownerAddress, walletUtxo, collateral } = await fixture();
		const agentMnemonic = MeshWallet.brew() as string[];

		const prepared = await prepareOwnerDecommit({
			wallet: {
				ownerAddress,
				quorumVkhs: ['a1'.repeat(28), 'a2'.repeat(28)],
				threshold: 2,
				stateTokenName: 'dd'.repeat(32),
				network: 'preprod',
			},
			walletUtxo,
			collateral,
			headCostModels: {},
			agentMnemonic,
		});

		const tx = FixedTransaction.from_hex(prepared.unsignedTx);
		expect(tx.transaction_hash().to_hex()).toBe(prepared.txHash);
		expect(tx.witness_set().vkeys()?.len()).toBe(1);
		expect(prepared.ownerKeyHash).toBe(resolvePaymentKeyHash(ownerAddress));
	});
});
