import { describe, expect, it, jest } from '@jest/globals';
import {
	BigNum,
	ConstrPlutusData,
	Credential,
	EnterpriseAddress,
	PlutusData,
	PlutusList,
	Redeemer,
	RedeemerTag,
	Redeemers,
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
	ExUnits,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { resolveTxHash } from '@meshsdk/core';
import { createHash } from 'node:crypto';
import { DEFAULT_HYDRA_HEAD_SCRIPT_HASH, HYDRA_HEAD_V2_ASSET_NAME_HEX } from '@/lib/hydra/hydra/head-init-validation';

type AnyMock = jest.Mock<(...args: any[]) => any>;

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { findDecommitPayoutTx, decommitPayoutSearchBounds } = await import('./l1-payout');

const ADDRESS = 'addr_test1_local';
const TOKEN = 'a'.repeat(56) + '746f6b656e';
const HEAD_ID = 'ab'.repeat(28);
const STATE_TOKEN = `${HEAD_ID}${HYDRA_HEAD_V2_ASSET_NAME_HEX}`;
const HEAD_ADDRESS = EnterpriseAddress.new(
	0,
	Credential.from_scripthash(ScriptHash.from_hex(DEFAULT_HYDRA_HEAD_SCRIPT_HASH)),
)
	.to_address()
	.to_bech32();
const OTHER_SCRIPT_ADDRESS = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex('ef'.repeat(28))))
	.to_address()
	.to_bech32();
const OPEN_FIELDS = PlutusList.new();
OPEN_FIELDS.add(PlutusData.new_constr_plutus_data(ConstrPlutusData.new(BigNum.from_str('0'), PlutusList.new())));
const OPEN_DATUM = PlutusData.new_constr_plutus_data(ConstrPlutusData.new(BigNum.from_str('0'), OPEN_FIELDS)).to_hex();
const CLOSED_DATUM = PlutusData.new_constr_plutus_data(
	ConstrPlutusData.new(BigNum.from_str('1'), PlutusList.new()),
).to_hex();
const STATE_AMOUNT = [{ unit: STATE_TOKEN, quantity: '1' }];

function chainTransaction(label: string, alternative = 1, otherAlternative?: number) {
	const headInputHash = createHash('sha256').update(label).digest('hex');
	const otherInputHash = '00'.repeat(32);
	const inputs = TransactionInputs.new();
	inputs.add(TransactionInput.new(TransactionHash.from_hex(headInputHash), 0));
	if (otherAlternative !== undefined) inputs.add(TransactionInput.new(TransactionHash.from_hex(otherInputHash), 0));
	const outputs = TransactionOutputs.new();
	outputs.add(
		TransactionOutput.new(
			EnterpriseAddress.new(
				0,
				Credential.from_scripthash(ScriptHash.from_hex(DEFAULT_HYDRA_HEAD_SCRIPT_HASH)),
			).to_address(),
			Value.new(BigNum.from_str('2000000')),
		),
	);
	const body = TransactionBody.new_tx_body(inputs, outputs, BigNum.from_str('200000'));
	const redeemers = Redeemers.new();
	const bodyInputs = body.inputs();
	for (let index = 0; index < bodyInputs.len(); index++) {
		const hash = bodyInputs.get(index).transaction_id().to_hex().toLowerCase();
		const inputAlternative = hash === headInputHash ? alternative : otherAlternative;
		if (inputAlternative === undefined) throw new Error('missing test spend redeemer');
		redeemers.add(
			Redeemer.new(
				RedeemerTag.new_spend(),
				BigNum.from_str(String(index)),
				PlutusData.new_constr_plutus_data(
					ConstrPlutusData.new(BigNum.from_str(String(inputAlternative)), PlutusList.new()),
				),
				ExUnits.new(BigNum.from_str('1'), BigNum.from_str('1')),
			),
		);
	}
	const witnesses = TransactionWitnessSet.new();
	witnesses.set_redeemers(redeemers);
	const cbor = Transaction.new(body, witnesses).to_hex();
	return {
		hash: String(resolveTxHash(cbor)).toLowerCase(),
		cbor,
		headInputHash,
		otherInputHash: otherAlternative === undefined ? null : otherInputHash,
	};
}

const txHash = (label: string) => chainTransaction(label).hash;

const findPayout = (params: Omit<Parameters<typeof findDecommitPayoutTx>[0], 'headId'>) =>
	findDecommitPayoutTx({ ...params, headId: HEAD_ID });

function blockfrostWith(
	txs: Record<string, Array<{ address: string; amount: Array<{ unit: string; quantity: string }> }>>,
	blockTimes: Record<string, number> = {},
	hasHeadTransition = true,
	headDatum = OPEN_DATUM,
	redeemerAlternativeByLabel: Record<string, number> = {},
	otherRedeemerAlternativeByLabel: Record<string, number> = {},
) {
	const chainByLabel = Object.fromEntries(
		Object.keys(txs).map((label) => [
			label,
			chainTransaction(label, redeemerAlternativeByLabel[label], otherRedeemerAlternativeByLabel[label]),
		]),
	) as Record<string, ReturnType<typeof chainTransaction>>;
	const labelByHash = new Map(Object.entries(chainByLabel).map(([label, chain]) => [chain.hash, label]));
	const addressesTransactions = jest.fn() as AnyMock;
	addressesTransactions.mockImplementation((_address: string, options: { page: number }) =>
		Promise.resolve(
			options.page === 1
				? Object.keys(txs).map((label) => ({ tx_hash: chainByLabel[label].hash, block_time: blockTimes[label] ?? 0 }))
				: [],
		),
	);
	const txsUtxos = jest.fn() as AnyMock;
	txsUtxos.mockImplementation((hash: string) =>
		Promise.resolve({
			hash,
			inputs: hasHeadTransition
				? [
						{
							address: HEAD_ADDRESS,
							amount: STATE_AMOUNT,
							tx_hash: chainByLabel[labelByHash.get(hash)!].headInputHash,
							output_index: 0,
						},
						...(chainByLabel[labelByHash.get(hash)!].otherInputHash === null
							? []
							: [
									{
										address: OTHER_SCRIPT_ADDRESS,
										amount: [{ unit: 'lovelace', quantity: '2000000' }],
										tx_hash: chainByLabel[labelByHash.get(hash)!].otherInputHash,
										output_index: 0,
									},
								]),
					]
				: [],
			outputs: [
				...(txs[labelByHash.get(hash)!] ?? []),
				...(hasHeadTransition ? [{ address: HEAD_ADDRESS, amount: STATE_AMOUNT, inline_datum: headDatum }] : []),
			],
		}),
	);
	const txsCbor = jest.fn() as AnyMock;
	txsCbor.mockImplementation((hash: string) => Promise.resolve({ cbor: chainByLabel[labelByHash.get(hash)!].cbor }));
	return { addressesTransactions, txsUtxos, txsCbor } as never;
}

describe('findDecommitPayoutTx', () => {
	it('does not link an unrelated exact-value payment to a finalized decommit', async () => {
		const amount = [{ unit: 'lovelace', quantity: '3500000' }];
		const blockfrost = blockfrostWith({ unrelated: [{ address: ADDRESS, amount }] }, {}, false);

		const found = await findPayout({
			blockfrost,
			address: ADDRESS,
			expected: { lovelace: 3_500_000n, assets: {} },
		});

		expect(found).toBeNull();
	});

	it('does not link an exact-value transfer in a transaction that closed the head', async () => {
		const amount = [{ unit: 'lovelace', quantity: '3500000' }];
		const blockfrost = blockfrostWith({ close: [{ address: ADDRESS, amount }] }, {}, true, CLOSED_DATUM);

		const found = await findPayout({
			blockfrost,
			address: ADDRESS,
			expected: { lovelace: 3_500_000n, assets: {} },
		});

		expect(found).toBeNull();
	});

	it('does not link an exact-value transfer accompanying an Increment transition', async () => {
		const amount = [{ unit: 'lovelace', quantity: '3500000' }];
		const blockfrost = blockfrostWith({ increment: [{ address: ADDRESS, amount }] }, {}, true, OPEN_DATUM, {
			increment: 0,
		});

		const found = await findPayout({
			blockfrost,
			address: ADDRESS,
			expected: { lovelace: 3_500_000n, assets: {} },
		});

		expect(found).toBeNull();
	});

	it('binds Decrement to this head input when another script input also has a redeemer', async () => {
		const amount = [{ unit: 'lovelace', quantity: '3500000' }];
		const blockfrost = blockfrostWith(
			{ mixed: [{ address: ADDRESS, amount }] },
			{},
			true,
			OPEN_DATUM,
			{ mixed: 0 },
			{ mixed: 1 },
		);

		const found = await findPayout({
			blockfrost,
			address: ADDRESS,
			expected: { lovelace: 3_500_000n, assets: {} },
		});

		expect(found).toBeNull();
	});

	it('does not link a payout when the indexed head input differs from the CBOR input', async () => {
		const amount = [{ unit: 'lovelace', quantity: '3500000' }];
		const blockfrost = blockfrostWith({ payout: [{ address: ADDRESS, amount }] }) as unknown as {
			addressesTransactions: AnyMock;
			txsUtxos: AnyMock;
			txsCbor: AnyMock;
		};
		const indexed = await blockfrost.txsUtxos(txHash('payout'));
		blockfrost.txsUtxos.mockResolvedValue({
			...indexed,
			inputs: [{ ...indexed.inputs[0], tx_hash: 'ff'.repeat(32) }],
		});

		const found = await findPayout({
			blockfrost: blockfrost as never,
			address: ADDRESS,
			expected: { lovelace: 3_500_000n, assets: {} },
		});

		expect(found).toBeNull();
	});

	it('does not link a payout when the transaction CBOR has a different hash', async () => {
		const amount = [{ unit: 'lovelace', quantity: '3500000' }];
		const blockfrost = blockfrostWith({ payout: [{ address: ADDRESS, amount }] }) as unknown as {
			addressesTransactions: AnyMock;
			txsUtxos: AnyMock;
			txsCbor: AnyMock;
		};
		blockfrost.txsCbor.mockResolvedValue({ cbor: chainTransaction('other').cbor });

		const found = await findPayout({
			blockfrost: blockfrost as never,
			address: ADDRESS,
			expected: { lovelace: 3_500_000n, assets: {} },
		});

		expect(found).toBeNull();
	});

	it('does not link a payout from another head', async () => {
		const amount = [{ unit: 'lovelace', quantity: '3500000' }];
		const blockfrost = blockfrostWith({ otherHead: [{ address: ADDRESS, amount }] });

		const found = await findDecommitPayoutTx({
			blockfrost,
			headId: 'cd'.repeat(28),
			address: ADDRESS,
			expected: { lovelace: 3_500_000n, assets: {} },
		});

		expect(found).toBeNull();
	});

	it('finds the transaction whose output is exactly what left the head', async () => {
		const blockfrost = blockfrostWith({
			decoy: [{ address: ADDRESS, amount: [{ unit: 'lovelace', quantity: '9999999' }] }],
			payout: [
				{
					address: ADDRESS,
					amount: [
						{ unit: 'lovelace', quantity: '4829879' },
						{ unit: TOKEN, quantity: '1' },
					],
				},
			],
		});

		const found = await findPayout({
			blockfrost,
			address: ADDRESS,
			expected: { lovelace: 4_829_879n, assets: { [TOKEN]: '1' } },
		});

		expect(found).toBe(txHash('payout'));
	});

	// The units come from two different sources — the head's own report and
	// Blockfrost — and nothing guarantees they agree on hex casing.
	it('matches units that differ only in case', async () => {
		const blockfrost = blockfrostWith({
			payout: [
				{
					address: ADDRESS,
					amount: [
						{ unit: 'lovelace', quantity: '2000000' },
						{ unit: TOKEN.toUpperCase(), quantity: '5' },
					],
				},
			],
		});

		const found = await findPayout({
			blockfrost,
			address: ADDRESS,
			expected: { lovelace: 2_000_000n, assets: { [TOKEN]: '5' } },
		});

		expect(found).toBe(txHash('payout'));
	});

	// An output carrying the same token plus something else is a different
	// payment, not this withdrawal.
	it('refuses an output that carries more than what left the head', async () => {
		const blockfrost = blockfrostWith({
			other: [
				{
					address: ADDRESS,
					amount: [
						{ unit: 'lovelace', quantity: '4829879' },
						{ unit: TOKEN, quantity: '1' },
						{ unit: 'b'.repeat(56), quantity: '1' },
					],
				},
			],
		});

		const found = await findPayout({
			blockfrost,
			address: ADDRESS,
			expected: { lovelace: 4_829_879n, assets: { [TOKEN]: '1' } },
		});

		expect(found).toBeNull();
	});

	// A payout that has not been seen yet is not a failure: the withdrawal is
	// still settled, it just has no link on it.
	it('returns null rather than throwing when nothing matches', async () => {
		const found = await findPayout({
			blockfrost: blockfrostWith({}),
			address: ADDRESS,
			expected: { lovelace: 1n, assets: {} },
		});

		expect(found).toBeNull();
	});

	// Defect H: several identical-amount withdrawals minutes apart all match on
	// value, so the search must land on the one closest after this withdrawal's
	// own approval rather than whichever is newest on chain.
	it('prefers the oldest matching payout at or after notBefore', async () => {
		const t1 = 1_000;
		const t2 = 2_000;
		const t3 = 3_000;
		const amount = [{ unit: 'lovelace', quantity: '3500000' }];
		// History arrives newest-first, as Blockfrost returns it with `order: 'desc'`.
		const blockfrost = blockfrostWith(
			{
				p3: [{ address: ADDRESS, amount }],
				p2: [{ address: ADDRESS, amount }],
				p1: [{ address: ADDRESS, amount }],
			},
			{ p3: t3, p2: t2, p1: t1 },
		);

		const found = await findPayout({
			blockfrost,
			address: ADDRESS,
			expected: { lovelace: 3_500_000n, assets: {} },
			notBefore: new Date(((t1 + t2) / 2) * 1000),
		});

		expect(found).toBe(txHash('p2'));
	});

	it('skips a transaction already attributed to another withdrawal', async () => {
		const t1 = 1_000;
		const t2 = 2_000;
		const t3 = 3_000;
		const amount = [{ unit: 'lovelace', quantity: '3500000' }];
		const blockfrost = blockfrostWith(
			{
				p3: [{ address: ADDRESS, amount }],
				p2: [{ address: ADDRESS, amount }],
				p1: [{ address: ADDRESS, amount }],
			},
			{ p3: t3, p2: t2, p1: t1 },
		);

		const found = await findPayout({
			blockfrost,
			address: ADDRESS,
			expected: { lovelace: 3_500_000n, assets: {} },
			notBefore: new Date(((t1 + t2) / 2) * 1000),
			exclude: new Set([txHash('p2')]),
		});

		expect(found).toBe(txHash('p3'));
	});

	// A match already in hand from an earlier page must survive a later page's
	// read failure: the loop now walks on past the first match (to find the
	// OLDEST one), so a failure on page 2 must not throw away what page 1 found.
	it('keeps a match found on page 1 when page 2 fails to load', async () => {
		const amount = [{ unit: 'lovelace', quantity: '3500000' }];
		const chain = chainTransaction('payout');
		const addressesTransactions = jest.fn() as AnyMock;
		addressesTransactions.mockImplementation((_address: string, options: { page: number }) => {
			if (options.page === 1) return Promise.resolve([{ tx_hash: chain.hash, block_time: 1_000 }]);
			return Promise.reject(new Error('blockfrost unavailable'));
		});
		const txsUtxos = jest.fn() as AnyMock;
		txsUtxos.mockImplementation((hash: string) =>
			Promise.resolve({
				hash,
				inputs: [{ address: HEAD_ADDRESS, amount: STATE_AMOUNT, tx_hash: chain.headInputHash, output_index: 0 }],
				outputs:
					hash === chain.hash
						? [
								{ address: ADDRESS, amount },
								{ address: HEAD_ADDRESS, amount: STATE_AMOUNT, inline_datum: OPEN_DATUM },
							]
						: [],
			}),
		);
		const txsCbor = jest.fn() as AnyMock;
		txsCbor.mockResolvedValue({ cbor: chain.cbor });
		const blockfrost = { addressesTransactions, txsUtxos, txsCbor } as never;

		const found = await findPayout({
			blockfrost,
			address: ADDRESS,
			expected: { lovelace: 3_500_000n, assets: {} },
		});

		expect(found).toBe(chain.hash);
	});
});

describe('decommitPayoutSearchBounds', () => {
	// The RED case for the payout-lookup bug: settle.ts backfills `approvedAt`
	// to "now" when a decommit finalizes without ever having observed an
	// Approved event (a restart, a replay starting mid-history, a missed
	// frame). A bound taken from that backfilled timestamp lands AFTER the
	// payout's own block_time, so `findDecommitPayoutTx` would exclude the
	// genuine match on every call, including the retry pass, and `l1TxId`
	// would never be set. The bound must always come from `createdAt`, which
	// is written before the decommit is even built and so is always earlier
	// than the payout that follows it.
	it('bounds the search at createdAt even when approvedAt was backfilled later than the payout', () => {
		const createdAt = new Date('2026-01-01T00:00:00.000Z');
		const approvedAt = new Date('2026-01-01T00:10:00.000Z');

		const bounds = decommitPayoutSearchBounds({ createdAt, approvedAt }, []);

		expect(bounds.notBefore).toEqual(createdAt);
	});

	it('excludes sibling payout hashes and ignores null ones', () => {
		const createdAt = new Date('2026-01-01T00:00:00.000Z');

		const bounds = decommitPayoutSearchBounds({ createdAt, approvedAt: null }, [
			{ l1TxId: 'sibling-1' },
			{ l1TxId: null },
			{ l1TxId: 'sibling-2' },
		]);

		expect(bounds.exclude).toEqual(new Set(['sibling-1', 'sibling-2']));
	});
});
