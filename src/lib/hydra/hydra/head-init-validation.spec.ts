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
	LEGACY_HYDRA_HEAD_SCRIPT_HASHES,
	resolveHydraInitChainAnchor,
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
const DEPOSIT_SECONDS = 300n;
const STATE_TOKEN = `${HEAD_ID}${HYDRA_HEAD_V2_ASSET_NAME_HEX}`;
function headAddressForScriptHash(scriptHash: string): string {
	return EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(scriptHash)))
		.to_address()
		.to_bech32();
}

const HEAD_ADDRESS = headAddressForScriptHash(DEFAULT_HYDRA_HEAD_SCRIPT_HASH);

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

/**
 * The head's Open datum. Defaults to hydra-node 2.4's eight-field layout, which
 * carries the deposit period on chain right after the contestation period
 * (`Hydra.Contract.HeadState.OpenDatum` at tag 2.4.1). `legacy: true` emits
 * 2.3.0's seven-field layout, which has no deposit period at all.
 */
function openDatum(options?: {
	headId?: string;
	parties?: string[];
	periodMs?: bigint;
	depositPeriodMs?: bigint;
	version?: bigint;
	legacy?: boolean;
}): string {
	const fields = [
		constructor(0, [
			constructor(0, [PlutusData.new_bytes(Buffer.from('33'.repeat(32), 'hex'))]),
			PlutusData.new_integer(CardanoBigInt.from_str('0')),
		]),
		PlutusData.new_bytes(Buffer.from(options?.headId ?? HEAD_ID, 'hex')),
		list((options?.parties ?? [LOCAL_KEY, REMOTE_KEY]).map((key) => PlutusData.new_bytes(Buffer.from(key, 'hex')))),
		constructor(0, [
			PlutusData.new_integer(CardanoBigInt.from_str((options?.periodMs ?? CONTESTATION_SECONDS * 1000n).toString())),
		]),
		...(options?.legacy
			? []
			: [
					constructor(0, [
						PlutusData.new_integer(
							CardanoBigInt.from_str((options?.depositPeriodMs ?? DEPOSIT_SECONDS * 1000n).toString()),
						),
					]),
				]),
		PlutusData.new_integer(CardanoBigInt.from_str((options?.version ?? 0n).toString())),
		PlutusData.new_bytes(Buffer.from('44'.repeat(32), 'hex')),
		PlutusData.new_integer(CardanoBigInt.from_str('5000000')),
	];
	return constructor(0, [constructor(0, fields)]).to_hex();
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
		).resolves.toEqual({ initTxHash: INIT_TX_HASH, depositPeriodMilliseconds: DEPOSIT_SECONDS * 1000n });
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
		).resolves.toEqual({ initTxHash: INIT_TX_HASH, depositPeriodMilliseconds: DEPOSIT_SECONDS * 1000n });
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

	it('accepts a legacy 2.3.0 head script hash after the current pin moves on', async () => {
		const legacyHash = LEGACY_HYDRA_HEAD_SCRIPT_HASHES[0];
		if (!legacyHash) throw new Error('no legacy head script hash configured');
		expect(legacyHash).not.toBe(DEFAULT_HYDRA_HEAD_SCRIPT_HASH);
		await expect(
			verifyHydraHeadInitOnChain({
				observer: observer(openDatum({ legacy: true }), headAddressForScriptHash(legacyHash)),
				headId: HEAD_ID,
				expectedVerificationKeys: [LOCAL_KEY, REMOTE_KEY],
				expectedParticipantVkeys: [LOCAL_PARTICIPANT, REMOTE_PARTICIPANT],
				contestationPeriodSeconds: CONTESTATION_SECONDS,
			}),
		).resolves.toEqual({ initTxHash: INIT_TX_HASH, depositPeriodMilliseconds: null });
	});

	// hydra-node 2.4 moved the deposit period on chain: OpenDatum gained a
	// `depositPeriod` field between the contestation period and the version
	// (Hydra.Contract.HeadState at tag 2.4.1), so a 2.4 head's datum has eight
	// fields where 2.3's had seven. Which layout to expect follows from which
	// script produced the output — a script cannot mint the other version's shape.
	describe('the on-chain deposit period (hydra-node 2.4 Open datum)', () => {
		const verify = (
			datum: string,
			scriptHash = DEFAULT_HYDRA_HEAD_SCRIPT_HASH,
			extra: { depositPeriodSeconds?: bigint } = {},
		) =>
			verifyHydraHeadInitOnChain({
				observer: observer(datum, headAddressForScriptHash(scriptHash)),
				headId: HEAD_ID,
				expectedVerificationKeys: [LOCAL_KEY, REMOTE_KEY],
				expectedParticipantVkeys: [LOCAL_PARTICIPANT, REMOTE_PARTICIPANT],
				contestationPeriodSeconds: CONTESTATION_SECONDS,
				...extra,
			});

		it('accepts the eight-field layout on the current head script and reports the period', async () => {
			await expect(verify(openDatum())).resolves.toEqual({
				initTxHash: INIT_TX_HASH,
				depositPeriodMilliseconds: DEPOSIT_SECONDS * 1000n,
			});
		});

		it('rejects the seven-field 2.3 layout on the current head script', async () => {
			await expect(verify(openDatum({ legacy: true }))).rejects.toThrow('Open datum');
		});

		it('rejects the eight-field layout on a legacy 2.3 head script', async () => {
			const legacyHash = LEGACY_HYDRA_HEAD_SCRIPT_HASHES[0]!;
			await expect(verify(openDatum(), legacyHash)).rejects.toThrow('Open datum');
		});

		it('rejects an on-chain deposit period that differs from the one this head was configured with', async () => {
			await expect(verify(openDatum(), DEFAULT_HYDRA_HEAD_SCRIPT_HASH, { depositPeriodSeconds: 600n })).rejects.toThrow(
				'deposit period',
			);
			await expect(
				verify(openDatum(), DEFAULT_HYDRA_HEAD_SCRIPT_HASH, { depositPeriodSeconds: DEPOSIT_SECONDS }),
			).resolves.toMatchObject({ depositPeriodMilliseconds: DEPOSIT_SECONDS * 1000n });
		});

		it('rejects a non-positive on-chain deposit period', async () => {
			await expect(verify(openDatum({ depositPeriodMs: 0n }))).rejects.toThrow('deposit period');
		});
	});

	it('rejects a head script hash outside the known current+legacy set', async () => {
		const foreignHash = 'ff'.repeat(28);
		await expect(
			verifyHydraHeadInitOnChain({
				observer: observer(openDatum(), headAddressForScriptHash(foreignHash)),
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

describe('resolveHydraInitChainAnchor', () => {
	const INIT_BLOCK = 'aa'.repeat(32);
	const PARENT_BLOCK = 'bb'.repeat(32);

	function anchorObserver(overrides?: {
		block?: string | null;
		previousBlock?: string | null;
		parentSlot?: number | null;
	}) {
		return {
			txs: jest.fn(async (_hash: string) => ({ block: overrides?.block === undefined ? INIT_BLOCK : overrides.block })),
			blocks: jest.fn(async (hashOrNumber: string) =>
				hashOrNumber === INIT_BLOCK
					? {
							hash: INIT_BLOCK,
							slot: 500,
							previous_block: overrides?.previousBlock === undefined ? PARENT_BLOCK : overrides.previousBlock,
						}
					: {
							hash: PARENT_BLOCK,
							slot: overrides?.parentSlot === undefined ? 499 : overrides.parentSlot,
							previous_block: 'cc'.repeat(32),
						},
			),
		};
	}

	it('returns the parent block point of the InitTx block', async () => {
		const observer = anchorObserver();
		await expect(resolveHydraInitChainAnchor(observer, INIT_TX_HASH)).resolves.toEqual({
			slot: 499n,
			hash: PARENT_BLOCK,
		});
		expect(observer.txs).toHaveBeenCalledWith(INIT_TX_HASH);
		expect(observer.blocks).toHaveBeenNthCalledWith(1, INIT_BLOCK);
		expect(observer.blocks).toHaveBeenNthCalledWith(2, PARENT_BLOCK);
	});

	it('returns null when the InitTx has no block yet', async () => {
		await expect(resolveHydraInitChainAnchor(anchorObserver({ block: null }), INIT_TX_HASH)).resolves.toBeNull();
	});

	it('returns null when the InitTx block has no previous block', async () => {
		await expect(
			resolveHydraInitChainAnchor(anchorObserver({ previousBlock: null }), INIT_TX_HASH),
		).resolves.toBeNull();
	});

	it('returns null when the parent block has no slot', async () => {
		await expect(resolveHydraInitChainAnchor(anchorObserver({ parentSlot: null }), INIT_TX_HASH)).resolves.toBeNull();
	});

	it('rejects a non-canonical InitTx hash', async () => {
		await expect(resolveHydraInitChainAnchor(anchorObserver(), 'zz')).rejects.toThrow('not canonical hexadecimal');
	});

	it('returns null instead of throwing when the observer fails transiently', async () => {
		const observer = {
			txs: jest.fn(async (_hash: string): Promise<{ block: string | null }> => {
				throw new Error('Blockfrost 429');
			}),
			blocks: jest.fn(async (_hashOrNumber: string) => ({ hash: PARENT_BLOCK, slot: 499, previous_block: null })),
		};
		await expect(resolveHydraInitChainAnchor(observer, INIT_TX_HASH)).resolves.toBeNull();
	});

	it('returns null when the observer pass exceeds its timeout', async () => {
		const observer = {
			txs: jest.fn((_hash: string) => new Promise<{ block: string | null }>(() => undefined)),
			blocks: jest.fn(async (_hashOrNumber: string) => ({ hash: PARENT_BLOCK, slot: 499, previous_block: null })),
		};
		await expect(resolveHydraInitChainAnchor(observer, INIT_TX_HASH, 50)).resolves.toBeNull();
	});
});
