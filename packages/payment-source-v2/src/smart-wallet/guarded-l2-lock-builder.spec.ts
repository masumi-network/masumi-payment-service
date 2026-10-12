import { describe, expect, it } from '@jest/globals';
import { FixedTransaction } from '@emurgo/cardano-serialization-lib-nodejs';
import {
	DEFAULT_PROTOCOL_PARAMETERS,
	MeshWallet,
	resolvePaymentKeyHash,
	resolveSlotNo,
	serializePlutusScript,
	type UTxO,
} from '@meshsdk/core';
import { buildGuardedL2LockTx, type BuildGuardedL2LockParams } from './guarded-l2-lock-builder';
import { L2_WALLET_SPEND_EX_UNITS } from './hydra-transfer';
import { loadSmartWalletScript } from './wallet-lifecycle';
import type { WalletDatum } from './wallet';

const STATE_TOKEN_NAME = 'dd'.repeat(32);
const COSIGNERS = ['a1'.repeat(28), 'a2'.repeat(28)];
const ESCROW_ADDRESS = serializePlutusScript(
	{ code: '4e4d01000033222220051200120011', version: 'V3' },
	undefined,
	0,
).address;

async function newAddress(): Promise<string> {
	const wallet = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words: MeshWallet.brew() as string[] } });
	await wallet.init();
	return await wallet.getChangeAddress();
}

function lovelaceValue(quantity: bigint) {
	return new Map([['', new Map([['', quantity]])]]);
}

async function fixture(overrides: Partial<BuildGuardedL2LockParams> = {}) {
	const ownerAddress = await newAddress();
	const agentAddress = await newAddress();
	const script = loadSmartWalletScript({ ownerAddress, quorumVkhs: COSIGNERS, threshold: 2, network: 'preprod' });
	const nowSlot = Number(resolveSlotNo('preprod', Date.now()));
	const walletDatum: WalletDatum = {
		agent: resolvePaymentKeyHash(agentAddress),
		limit: lovelaceValue(50_000_000n),
		periodLength: 86_400_000n,
		periodStart: BigInt(Date.now() - 1_000),
		spentInPeriod: lovelaceValue(0n),
		minBalanceLovelace: 5_000_000n,
	};
	const walletUtxo: UTxO = {
		input: { txHash: 'ee'.repeat(32), outputIndex: 0 },
		output: {
			address: script.address,
			amount: [
				{ unit: 'lovelace', quantity: '100000000' },
				{ unit: `${script.policyId}${STATE_TOKEN_NAME}`, quantity: '1' },
			],
			plutusData: 'd87980',
		},
	};
	const collateral: UTxO = {
		input: { txHash: 'ff'.repeat(32), outputIndex: 1 },
		output: { address: agentAddress, amount: [{ unit: 'lovelace', quantity: '10000000' }] },
	};
	const params: BuildGuardedL2LockParams = {
		network: 'preprod',
		wallet: { scriptCode: script.scriptCode, address: script.address },
		walletUtxo,
		walletDatum,
		agentAddress,
		collateral,
		cosignerVkhs: COSIGNERS,
		locks: [
			{
				address: ESCROW_ADDRESS,
				amount: [{ unit: 'lovelace', quantity: '7000000' }],
				datum: { alternative: 0, fields: [] },
			},
		],
		window: { invalidBefore: nowSlot - 60, invalidAfter: nowSlot + 600 },
		protocolParameters: DEFAULT_PROTOCOL_PARAMETERS,
		headCostModels: {},
		...overrides,
	};
	return { params, script, agentAddress };
}

describe('buildGuardedL2LockTx', () => {
	it('builds a fee-free head body the quorum and the agent must sign', async () => {
		const { params, script, agentAddress } = await fixture();

		const built = await buildGuardedL2LockTx(params);

		const body = FixedTransaction.from_hex(built.unsignedTx).body();
		expect(body.fee().to_str()).toBe('0');
		expect(body.total_collateral()?.to_str()).toBe('0');
		expect(body.collateral_return()?.address().to_bech32()).toBe(agentAddress);
		expect(body.collateral_return()?.amount().coin().to_str()).toBe('10000000');
		expect(body.outputs().len()).toBe(2);
		expect(body.collateral()?.get(0).transaction_id().to_hex()).toBe('ff'.repeat(32));
		const signers = body.required_signers();
		const signerHexes = Array.from({ length: signers?.len() ?? 0 }, (_, i) => signers!.get(i).to_hex());
		expect(signerHexes).toEqual([resolvePaymentKeyHash(agentAddress), ...COSIGNERS]);
		expect(body.validity_start_interval_bignum()?.to_str()).toBe(String(params.window.invalidBefore));
		expect(body.ttl_bignum()?.to_str()).toBe(String(params.window.invalidAfter));
		expect(body.script_data_hash()).toBeDefined();

		// The continuing wallet output comes first, the lock after it.
		expect(body.outputs().get(0).address().to_bech32()).toBe(script.address);
		expect(body.outputs().get(0).amount().coin().to_str()).toBe('93000000');
		expect(built.lockOutputIndexes).toEqual([1]);
		expect(built.nextDatum.spentInPeriod).toEqual(lovelaceValue(7_000_000n));

		const redeemers = FixedTransaction.from_hex(built.unsignedTx).witness_set().redeemers();
		expect(redeemers?.len()).toBe(1);
		expect(redeemers?.get(0).ex_units().mem().to_str()).toBe(String(L2_WALLET_SPEND_EX_UNITS.mem));
		expect(redeemers?.get(0).ex_units().steps().to_str()).toBe(String(L2_WALLET_SPEND_EX_UNITS.steps));
	});

	it('refuses collateral the agent key does not hold', async () => {
		const { params } = await fixture();
		const foreign = { ...params.collateral, output: { ...params.collateral.output, address: await newAddress() } };

		await expect(buildGuardedL2LockTx({ ...params, collateral: foreign })).rejects.toThrow(
			'collateral must belong to the agent',
		);
	});

	it('refuses a lock that leaves the wallet below its minimum balance', async () => {
		const { params } = await fixture();
		const locks = [{ ...params.locks[0]!, amount: [{ unit: 'lovelace', quantity: '96000000' }] }];

		await expect(buildGuardedL2LockTx({ ...params, locks })).rejects.toThrow('min_balance_lovelace');
	});
});
