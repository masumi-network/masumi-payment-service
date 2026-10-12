import { describe, expect, it, jest } from '@jest/globals';
import {
	applyCborEncoding,
	DEFAULT_PROTOCOL_PARAMETERS,
	resolveScriptHash,
	SLOT_CONFIG_NETWORK,
	slotToBeginUnixTime,
	unixTimeToEnclosingSlot,
	type UTxO,
} from '@meshsdk/core';
import { ConstrPlutusData, deserializeTx, PlutusData, PlutusList, PlutusMap } from '@meshsdk/core-cst';

type Budgets = Map<string, { mem: number; steps: number }>;
jest.unstable_mockModule('../smart-wallet/guarded-lock-builder', () => ({
	loadV2ProtocolParameters: () => Promise.resolve(DEFAULT_PROTOCOL_PARAMETERS),
	buildWithEvaluatedBudgets: async (_provider: unknown, _tags: unknown, build: (b: Budgets) => Promise<string>) => ({
		tx: await build(new Map([['SPEND', { mem: 1_000_000, steps: 500_000_000 }]])),
	}),
}));

const { HYDRA_DEPOSIT_COMPILED_CODE, HYDRA_DEPOSIT_SCRIPT_HASH } = await import('./deposit-script');
const {
	buildDepositRecoverTx,
	DepositNotRecoverableError,
	fetchDepositUtxo,
	firstRecoverSlot,
	RECOVER_TIP_MARGIN_MS,
	RECOVER_VALIDITY_MS,
} = await import('./recover-tx');

// Preprod deposit 4bb387c4…d0e3#0 (see deposit-datum.spec.ts): head 6a5b9ba1…,
// deadline 1789195305856, one commit of 1159390 lovelace and 1000000 tUSDM.
const DEPOSIT_DATUM =
	'd8799f581c6a5b9ba16b74b39ca18e378075c6709ad7e442028e401c505f01135a1b000001a09459c3809fd8799fd8799f58206c96879502eec7ee84daedf8a8702aa96e137d5ce8ad7b1705039534fd723a8e00ff5f5840d8799fd8799fd8799f581ce2559df4629eac5176a6d585d3479551863188ee6242baf362d754c4ffd8799fd8799fd8799f581c9d5dbf261545c91c0a2bce4efd584024e420901ffbf052873b187b18cb5effffffffa240a1401a0011b0de581cc8fc35bde37cbf2a7a25bcb0be52ce7de8a60b3341b5af2fd0f7a324a145745348534d481a000f4240d87980d87a80ffffffffff';
const DEADLINE_MS = 1_789_195_305_856n;
const HEAD_ID = '6a5b9ba16b74b39ca18e378075c6709ad7e442028e401c505f01135a';
const DEPOSIT_ADDRESS = 'addr_test1wr404ckr97v6kdru0wc4jc0qapx8gvzljzyvrfac40ugulcpczsyc';
const OWNER =
	'addr_test1qr39t805v202c5tk5m2ct568j4gcvvvgae3y9whnvtt4f3yatkljv929eywq527wfm7jfepqjq0lhuzjsua3s7cced0qdhh5vd';
const FEE_ADDRESS = 'addr_test1vqau6vf2cc0p4s409yuyy4ep0nl0ax7zh3dj0vt4dlvtfmq48yln5';
const TUSDM = 'c8fc35bde37cbf2a7a25bcb0be52ce7de8a60b3341b5af2fd0f7a3247453485348';
const slotConfig = SLOT_CONFIG_NETWORK.preprod;

const depositUtxo: UTxO = {
	input: { txHash: '4bb387c404e09a01bab48cb1deb39fbf75d1c10a9f9c33fba13f1d0099eed0e3', outputIndex: 0 },
	output: {
		address: DEPOSIT_ADDRESS,
		amount: [
			{ unit: 'lovelace', quantity: '2094660' },
			{ unit: TUSDM, quantity: '1000000' },
		],
		plutusData: DEPOSIT_DATUM,
	},
};
const feeUtxo = (txHash: string, lovelace: string): UTxO => ({
	input: { txHash, outputIndex: 1 },
	output: { address: FEE_ADDRESS, amount: [{ unit: 'lovelace', quantity: lovelace }] },
});
const provider = {
	evaluateTx: jest.fn(),
	fetchProtocolParameters: () => Promise.resolve(DEFAULT_PROTOCOL_PARAMETERS),
} as never;
const afterDeadline = Number(DEADLINE_MS) + RECOVER_TIP_MARGIN_MS + 60_000;

function build(overrides: Partial<Parameters<typeof buildDepositRecoverTx>[0]> = {}) {
	return buildDepositRecoverTx({
		provider,
		rpcApiKey: 'key',
		network: 'preprod',
		slotConfig,
		depositUtxo,
		expectedHeadId: HEAD_ID,
		feeAddress: FEE_ADDRESS,
		feeUtxos: [feeUtxo('aa'.repeat(32), '20000000'), feeUtxo('bb'.repeat(32), '6000000')],
		nowMs: afterDeadline,
		...overrides,
	});
}

describe('HYDRA_DEPOSIT_COMPILED_CODE', () => {
	it('is the script every 2.4.x deposit locks at', () => {
		expect(resolveScriptHash(applyCborEncoding(HYDRA_DEPOSIT_COMPILED_CODE), 'V3')).toBe(HYDRA_DEPOSIT_SCRIPT_HASH);
	});
});

describe('firstRecoverSlot', () => {
	it('starts strictly after the deadline, as after_deadline requires', () => {
		const slot = firstRecoverSlot(DEADLINE_MS, slotConfig);
		expect(slotToBeginUnixTime(slot, slotConfig)).toBeGreaterThan(Number(DEADLINE_MS));
		expect(slotToBeginUnixTime(slot - 1, slotConfig)).toBeLessThanOrEqual(Number(DEADLINE_MS));
	});
});

describe('buildDepositRecoverTx', () => {
	it('spends only the deposit with Recover(n) and recreates the committed output first', async () => {
		const built = await build();
		const body = deserializeTx(built.unsignedTx).body();
		const witnesses = deserializeTx(built.unsignedTx).witnessSet();

		const outputs = body.outputs();
		expect(outputs[0].address().toBech32()).toBe(OWNER);
		expect(outputs[0].amount().coin()).toBe(1_159_390n);
		expect([...(outputs[0].amount().multiasset()?.entries() ?? [])]).toEqual([[TUSDM, 1_000_000n]]);
		expect(outputs[0].datum()).toBeUndefined();
		// The rest of the deposit and the fee input come back as change.
		expect(outputs.slice(1).every((output) => output.address().toBech32() === FEE_ADDRESS)).toBe(true);

		expect(Number(body.validityStartInterval())).toBe(firstRecoverSlot(DEADLINE_MS, slotConfig));
		// Expires, so a dropped recover cannot land after its fee wallet is released.
		expect(Number(body.ttl())).toBe(unixTimeToEnclosingSlot(afterDeadline + RECOVER_VALIDITY_MS, slotConfig));
		expect(built.validUntilMs).toBe(slotToBeginUnixTime(Number(body.ttl()), slotConfig));
		expect(body.requiredSigners()).toBeUndefined();
		const inputs = body.inputs().values();
		expect(inputs.filter((input) => input.transactionId() === depositUtxo.input.txHash)).toHaveLength(1);
		expect(body.collateral()?.size()).toBe(1);

		const redeemers = witnesses.redeemers()?.values() ?? [];
		expect(redeemers).toHaveLength(1);
		expect(redeemers[0].data().toCbor()).toBe('d87a9f01ff');
	});

	it('recreates every commit in output-reference order, inline datums included', async () => {
		const pd = {
			constr: (alternative: number, fields: PlutusData[]) => {
				const list = new PlutusList();
				for (const field of fields) list.add(field);
				return PlutusData.newConstrPlutusData(new ConstrPlutusData(BigInt(alternative), list));
			},
			bytes: (hex: string) => PlutusData.newBytes(Buffer.from(hex, 'hex')),
			int: (value: bigint) => PlutusData.newInteger(value),
			map: (pairs: Array<[PlutusData, PlutusData]>) => {
				const value = new PlutusMap();
				for (const [key, entry] of pairs) value.insert(key, entry);
				return PlutusData.newMap(value);
			},
		};
		const keyAddress = pd.constr(0, [pd.constr(0, [pd.bytes('0'.repeat(55) + '1')]), pd.constr(1, [])]);
		const inline = pd.constr(0, [pd.bytes('cafe')]);
		const out = (lovelace: bigint, datum: PlutusData) =>
			pd.constr(0, [
				keyAddress,
				pd.map([[pd.bytes(''), pd.map([[pd.bytes(''), pd.int(lovelace)]])]]),
				datum,
				pd.constr(1, []),
			]);
		const commit = (txHash: string, lovelace: bigint, datum: PlutusData) =>
			pd.constr(0, [pd.constr(0, [pd.bytes(txHash), pd.int(0n)]), pd.bytes(out(lovelace, datum).toCbor())]);
		const commits = new PlutusList();
		commits.add(commit('bb'.repeat(32), 3_000_000n, pd.constr(0, [])));
		commits.add(commit('aa'.repeat(32), 2_000_000n, pd.constr(2, [inline])));
		const datum = pd.constr(0, [pd.bytes(HEAD_ID), pd.int(DEADLINE_MS), PlutusData.newList(commits)]).toCbor();
		const twoCommits: UTxO = {
			...depositUtxo,
			output: { ...depositUtxo.output, amount: [{ unit: 'lovelace', quantity: '5000000' }], plutusData: datum },
		};

		const built = await build({ depositUtxo: twoCommits });
		const outputs = deserializeTx(built.unsignedTx).body().outputs();
		expect(outputs[0].amount().coin()).toBe(2_000_000n);
		expect(outputs[0].datum()?.asInlineData()?.toCbor()).toBe(inline.toCbor());
		expect(outputs[1].amount().coin()).toBe(3_000_000n);
		expect(outputs[1].datum()).toBeUndefined();
		const redeemer = deserializeTx(built.unsignedTx).witnessSet().redeemers()?.values()[0];
		expect(redeemer?.data().toCbor()).toBe('d87a9f02ff');
	});

	it('refuses commits worth more than the deposit holds', async () => {
		const short: UTxO = {
			...depositUtxo,
			output: { ...depositUtxo.output, amount: [{ unit: 'lovelace', quantity: '2094660' }] },
		};
		await expect(build({ depositUtxo: short })).rejects.toThrow(/commits more/);
	});

	it('refuses before the deadline plus the tip margin', async () => {
		await expect(build({ nowMs: Number(DEADLINE_MS) + 1_000 })).rejects.toMatchObject({ reason: 'too-early' });
	});

	it('refuses a deposit into another head', async () => {
		await expect(build({ expectedHeadId: 'cd'.repeat(28) })).rejects.toMatchObject({ reason: 'wrong-head' });
	});

	it('needs a collateral UTxO in the fee wallet', async () => {
		await expect(build({ feeUtxos: [feeUtxo('aa'.repeat(32), '3000000')] })).rejects.toThrow(/collateral/);
	});
});

describe('fetchDepositUtxo', () => {
	const txHash = depositUtxo.input.txHash;
	const fetcher = (outputs: unknown[]) => ({
		get: jest.fn(() => Promise.resolve({ outputs })),
		fetchUTxOs: jest.fn((_hash: string, _index?: number) => Promise.resolve([depositUtxo])),
	});

	it('returns the unspent deposit output', async () => {
		const provider = fetcher([
			{ address: FEE_ADDRESS, output_index: 1, consumed_by_tx: null },
			{ address: DEPOSIT_ADDRESS, output_index: 0, consumed_by_tx: null },
		]);
		await expect(fetchDepositUtxo(provider as never, txHash)).resolves.toBe(depositUtxo);
		expect(provider.fetchUTxOs).toHaveBeenCalledWith(txHash, 0);
	});

	it('reports a deposit the head took in or someone recovered', async () => {
		const provider = fetcher([{ address: DEPOSIT_ADDRESS, output_index: 0, consumed_by_tx: 'ff'.repeat(32) }]);
		await expect(fetchDepositUtxo(provider as never, txHash)).rejects.toMatchObject({ reason: 'spent' });
	});

	it('tells an absent transaction from a Blockfrost outage', async () => {
		const failing = (status: number) => ({
			get: jest.fn(() => Promise.reject(JSON.stringify({ data: {}, status }))),
			fetchUTxOs: jest.fn(),
		});
		await expect(fetchDepositUtxo(failing(404) as never, txHash)).rejects.toMatchObject({ reason: 'not-found' });
		const outage = fetchDepositUtxo(failing(503) as never, txHash);
		await expect(outage).rejects.toThrow(/Could not read/);
		await expect(outage).rejects.not.toBeInstanceOf(DepositNotRecoverableError);
	});

	it('reports a transaction without a deposit output', async () => {
		const provider = fetcher([{ address: FEE_ADDRESS, output_index: 0, consumed_by_tx: null }]);
		await expect(fetchDepositUtxo(provider as never, txHash)).rejects.toBeInstanceOf(DepositNotRecoverableError);
	});
});
