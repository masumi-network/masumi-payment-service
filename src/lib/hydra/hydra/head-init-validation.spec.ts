import {
	Address,
	BigInt as CardanoBigInt,
	BigNum,
	ConstrPlutusData,
	Credential,
	EnterpriseAddress,
	PlutusData,
	PlutusList,
	ScriptHash,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { describe, expect, it, jest } from '@jest/globals';

import {
	DEFAULT_HYDRA_HEAD_SCRIPT_HASH,
	HYDRA_HEAD_V2_ASSET_NAME_HEX,
	HydraHeadInitObservationError,
	verifyHydraHeadInitOnChain,
	type HydraHeadChainObserver,
} from './head-init-validation';

const HEAD_ID = 'ab'.repeat(28);
const INIT_TX_HASH = 'cd'.repeat(32);
const LOCAL_KEY = '11'.repeat(32);
const REMOTE_KEY = '22'.repeat(32);
const LOCAL_PARTICIPANT = '55'.repeat(28);
const REMOTE_PARTICIPANT = '66'.repeat(28);
const CONTESTATION_SECONDS = 86_400n;
const STATE_TOKEN = `${HEAD_ID}${HYDRA_HEAD_V2_ASSET_NAME_HEX}`;
const HEAD_ADDRESS = EnterpriseAddress.new(
	0,
	Credential.from_scripthash(ScriptHash.from_hex(DEFAULT_HYDRA_HEAD_SCRIPT_HASH)),
)
	.to_address()
	.to_bech32();

function constructor(alternative: number, fields: PlutusData[]): PlutusData {
	const values = PlutusList.new();
	for (const field of fields) values.add(field);
	return PlutusData.new_constr_plutus_data(ConstrPlutusData.new(BigNum.from_str(alternative.toString()), values));
}

function list(items: PlutusData[]): PlutusData {
	const values = PlutusList.new();
	for (const item of items) values.add(item);
	return PlutusData.new_list(values);
}

function openDatum(options?: { headId?: string; parties?: string[]; periodMs?: bigint; version?: bigint }): string {
	return constructor(0, [
		constructor(0, [
			constructor(0, [
				constructor(0, [PlutusData.new_bytes(Buffer.from('33'.repeat(32), 'hex'))]),
				PlutusData.new_integer(CardanoBigInt.from_str('0')),
			]),
			PlutusData.new_bytes(Buffer.from(options?.headId ?? HEAD_ID, 'hex')),
			list((options?.parties ?? [LOCAL_KEY, REMOTE_KEY]).map((key) => PlutusData.new_bytes(Buffer.from(key, 'hex')))),
			constructor(0, [
				PlutusData.new_integer(CardanoBigInt.from_str((options?.periodMs ?? CONTESTATION_SECONDS * 1000n).toString())),
			]),
			PlutusData.new_integer(CardanoBigInt.from_str((options?.version ?? 0n).toString())),
			PlutusData.new_bytes(Buffer.from('44'.repeat(32), 'hex')),
			PlutusData.new_integer(CardanoBigInt.from_str('5000000')),
		]),
	]).to_hex();
}

function observer(datum = openDatum(), address = HEAD_ADDRESS): HydraHeadChainObserver {
	return {
		assetsTransactions: jest.fn(async () => [{ tx_hash: INIT_TX_HASH }]),
		txsUtxos: jest.fn(async () => ({
			hash: INIT_TX_HASH,
			outputs: [
				{
					address,
					amount: [
						{ unit: 'lovelace', quantity: '5000000' },
						{ unit: STATE_TOKEN, quantity: '1' },
						{ unit: `${HEAD_ID}${LOCAL_PARTICIPANT}`, quantity: '1' },
						{ unit: `${HEAD_ID}${REMOTE_PARTICIPANT}`, quantity: '1' },
					],
					inline_datum: datum,
				},
			],
		})),
	};
}

describe('verifyHydraHeadInitOnChain', () => {
	it('accepts the exact official Open head configuration', async () => {
		const chain = observer();
		await expect(
			verifyHydraHeadInitOnChain({
				observer: chain,
				headId: HEAD_ID.toUpperCase(),
				expectedVerificationKeys: [LOCAL_KEY, REMOTE_KEY],
				expectedParticipantVkeys: [LOCAL_PARTICIPANT, REMOTE_PARTICIPANT],
				contestationPeriodSeconds: CONTESTATION_SECONDS,
			}),
		).resolves.toEqual({ initTxHash: INIT_TX_HASH });
		expect(chain.assetsTransactions).toHaveBeenCalledWith(STATE_TOKEN, { page: 1, order: 'asc', count: 1 });
	});

	it('classifies an indexing lag as retryable observation evidence', async () => {
		const chain = observer();
		jest.mocked(chain.assetsTransactions).mockResolvedValue([]);

		await expect(
			verifyHydraHeadInitOnChain({
				observer: chain,
				headId: HEAD_ID,
				expectedVerificationKeys: [LOCAL_KEY, REMOTE_KEY],
				expectedParticipantVkeys: [LOCAL_PARTICIPANT, REMOTE_PARTICIPANT],
				contestationPeriodSeconds: CONTESTATION_SECONDS,
			}),
		).rejects.toBeInstanceOf(HydraHeadInitObservationError);
	});

	it('classifies an observer transport failure as retryable evidence', async () => {
		const chain = observer();
		jest.mocked(chain.txsUtxos).mockRejectedValue(new Error('rate limited'));

		await expect(
			verifyHydraHeadInitOnChain({
				observer: chain,
				headId: HEAD_ID,
				expectedVerificationKeys: [LOCAL_KEY, REMOTE_KEY],
				expectedParticipantVkeys: [LOCAL_PARTICIPANT, REMOTE_PARTICIPANT],
				contestationPeriodSeconds: CONTESTATION_SECONDS,
			}),
		).rejects.toBeInstanceOf(HydraHeadInitObservationError);
	});

	it('bounds the complete independent observer pass', async () => {
		const chain = observer();
		jest.mocked(chain.txsUtxos).mockImplementation(async () => await new Promise(() => undefined));

		await expect(
			verifyHydraHeadInitOnChain({
				observer: chain,
				headId: HEAD_ID,
				expectedVerificationKeys: [LOCAL_KEY, REMOTE_KEY],
				expectedParticipantVkeys: [LOCAL_PARTICIPANT, REMOTE_PARTICIPANT],
				contestationPeriodSeconds: CONTESTATION_SECONDS,
				observerTimeoutMs: 10,
			}),
		).rejects.toThrow('observer timed out');
	});

	it.each([
		['party substitution', openDatum({ parties: [LOCAL_KEY, '55'.repeat(32)] })],
		['shorter contestation period', openDatum({ periodMs: 1_000n })],
		['non-initial version', openDatum({ version: 1n })],
	])('rejects %s', async (_label, datum) => {
		await expect(
			verifyHydraHeadInitOnChain({
				observer: observer(datum),
				headId: HEAD_ID,
				expectedVerificationKeys: [LOCAL_KEY, REMOTE_KEY],
				expectedParticipantVkeys: [LOCAL_PARTICIPANT, REMOTE_PARTICIPANT],
				contestationPeriodSeconds: CONTESTATION_SECONDS,
			}),
		).rejects.toThrow();
	});

	it('accepts the configured party set in the protocol canonical order', async () => {
		await expect(
			verifyHydraHeadInitOnChain({
				observer: observer(openDatum({ parties: [REMOTE_KEY, LOCAL_KEY] })),
				headId: HEAD_ID,
				expectedVerificationKeys: [LOCAL_KEY, REMOTE_KEY],
				expectedParticipantVkeys: [LOCAL_PARTICIPANT, REMOTE_PARTICIPANT],
				contestationPeriodSeconds: CONTESTATION_SECONDS,
			}),
		).resolves.toEqual({ initTxHash: INIT_TX_HASH });
	});

	it('rejects a state token sent to a non-head script', async () => {
		const attackerAddress = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex('66'.repeat(28))))
			.to_address()
			.to_bech32();
		expect(Address.from_bech32(attackerAddress).payment_cred()?.to_scripthash()?.to_hex()).not.toBe(
			DEFAULT_HYDRA_HEAD_SCRIPT_HASH,
		);
		await expect(
			verifyHydraHeadInitOnChain({
				observer: observer(openDatum(), attackerAddress),
				headId: HEAD_ID,
				expectedVerificationKeys: [LOCAL_KEY, REMOTE_KEY],
				expectedParticipantVkeys: [LOCAL_PARTICIPANT, REMOTE_PARTICIPANT],
				contestationPeriodSeconds: CONTESTATION_SECONDS,
			}),
		).rejects.toThrow('exactly one official head output');
	});

	it('rejects Cardano participant-token substitution', async () => {
		const chain = observer();
		const output = (await chain.txsUtxos(INIT_TX_HASH)).outputs[0];
		if (!output) throw new Error('missing test output');
		output.amount = output.amount.map((amount) =>
			amount.unit === `${HEAD_ID}${REMOTE_PARTICIPANT}` ? { ...amount, unit: `${HEAD_ID}${'77'.repeat(28)}` } : amount,
		);
		jest.mocked(chain.txsUtxos).mockResolvedValue({ hash: INIT_TX_HASH, outputs: [output] });

		await expect(
			verifyHydraHeadInitOnChain({
				observer: chain,
				headId: HEAD_ID,
				expectedVerificationKeys: [LOCAL_KEY, REMOTE_KEY],
				expectedParticipantVkeys: [LOCAL_PARTICIPANT, REMOTE_PARTICIPANT],
				contestationPeriodSeconds: CONTESTATION_SECONDS,
			}),
		).rejects.toThrow('participant tokens');
	});
});
