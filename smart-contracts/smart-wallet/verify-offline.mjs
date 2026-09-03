import assert from 'node:assert/strict';
import { applyParamsToScript, resolveScriptHash, serializeData } from '@meshsdk/core';
import {
	Action,
	applyAgentSpend,
	assetValueData,
	assetValueEntries,
	assetValueGet,
	assetsMinus,
	assetsPlus,
	inlineWalletDatum,
	lovelaceOf,
	mapAssetValue,
	outflowOf,
	readText,
	readWalletDatum,
	stateTokenName,
	walletDatumData,
} from './example-helpers.mjs';

// Offline self-test of the off-chain layer: datum encoding round-trip, the
// AssetValue map shape, address derivation, and the budget arithmetic that has
// to agree with lib/smart_wallet/spend.ak. No network, no wallet files.

const DAY_MS = 86_400_000n;
const now = 1_700_000_000_000n;

const AGENT = '00000000000000000000000000000000000000000000000000000002';
const OWNER = '00000000000000000000000000000000000000000000000000000001';
const STAKE = '00000000000000000000000000000000000000000000000000000004';
const USDM = '000000000000000000000000000000000000000000000000000000cc';
const NFT = '000000000000000000000000000000000000000000000000000000dd';

function baseDatum() {
	return {
		agent: AGENT,
		limit: assetValueData([
			{ unit: 'lovelace', quantity: '10000000' },
			{ unit: `${USDM}55534424`, quantity: '1000' },
		]),
		periodLength: DAY_MS,
		periodStart: now,
		spentInPeriod: assetValueData([
			{ unit: 'lovelace', quantity: '0' },
			{ unit: `${USDM}55534424`, quantity: '0' },
		]),
		minBalanceLovelace: 5_000_000n,
	};
}

function validity(lowerMs, upperMs) {
	return { lowerMs, upperMs, invalidBefore: 0, invalidAfter: 0 };
}

function throws(label, run, expected) {
	assert.throws(run, (error) => {
		assert.match(error.message, expected, `${label}: unexpected message "${error.message}"`);
		return true;
	}, label);
	console.log(`ok   ${label}`);
}

// ## AssetValue is a PlutusData map, not a list

{
	const value = baseDatum().limit;
	assert.ok(value instanceof Map, 'AssetValue must be a Map — Pairs serialises to a Data map');
	assert.ok(value.get('') instanceof Map, 'inner AssetValue must be a Map too');
	assert.equal(assetValueGet(value, '', ''), 10_000_000n);
	assert.equal(assetValueGet(value, USDM, '55534424'), 1000n);
	console.log('ok   AssetValue nests PlutusData maps');
}

{
	// Sorting is not cosmetic: the validator requires limit and spent_in_period
	// to list the same assets in the same order.
	const a = assetValueData([
		{ unit: `${USDM}55534424`, quantity: '1' },
		{ unit: 'lovelace', quantity: '2' },
	]);
	const b = assetValueData([
		{ unit: 'lovelace', quantity: '2' },
		{ unit: `${USDM}55534424`, quantity: '1' },
	]);
	assert.deepEqual([...a.keys()], [...b.keys()], 'policy order must not depend on input order');
	assert.equal([...a.keys()][0], '', 'lovelace sorts first');
	console.log('ok   AssetValue ordering is deterministic');
}

// ## Datum round-trip

{
	const datum = baseDatum();
	const cbor = serializeData(walletDatumData(datum));
	const decoded = readWalletDatum({ output: { plutusData: cbor } });
	assert.equal(decoded.agent, datum.agent);
	assert.equal(decoded.periodLength, datum.periodLength);
	assert.equal(decoded.periodStart, datum.periodStart);
	assert.equal(decoded.minBalanceLovelace, datum.minBalanceLovelace);
	assert.deepEqual(assetValueEntries(decoded.limit), assetValueEntries(datum.limit));
	assert.deepEqual([...decoded.limit.keys()], [...datum.limit.keys()], 'order must survive the round-trip');
	console.log('ok   datum round-trips through CBOR with its order intact');
}

// ## Constructor indices match the blueprint

{
	const blueprint = JSON.parse(readText('./plutus.json'));
	const action = blueprint.definitions['smart_wallet/types/Action'];
	assert.deepEqual(
		action.anyOf.map((entry) => entry.title),
		['AgentSpend', 'Deposit', 'UpdatePolicy', 'OwnerSpend'],
	);
	assert.equal(action.anyOf[Action.AgentSpend].title, 'AgentSpend');
	assert.equal(action.anyOf[Action.Deposit].title, 'Deposit');
	assert.equal(action.anyOf[Action.UpdatePolicy].title, 'UpdatePolicy');
	assert.equal(action.anyOf[Action.OwnerSpend].title, 'OwnerSpend');

	const datum = blueprint.definitions['smart_wallet/types/Datum'];
	assert.deepEqual(
		datum.anyOf[0].fields.map((entry) => entry.title),
		['agent', 'limit', 'period_length', 'period_start', 'spent_in_period', 'min_balance_lovelace'],
	);
	console.log('ok   off-chain indices and field order match plutus.json');
}

// ## The script is its own minting policy

{
	const blueprint = JSON.parse(readText('./plutus.json'));
	const spend = blueprint.validators.find((v) => v.title === 'smart_wallet.smart_wallet.spend');
	const mint = blueprint.validators.find((v) => v.title === 'smart_wallet.smart_wallet.mint');
	assert.equal(spend.compiledCode, mint.compiledCode, 'mint and spend must be one script');
	assert.deepEqual(
		spend.parameters.map((p) => p.title),
		['owner', 'quorum_vks', 'quorum_threshold', 'stake'],
	);

	const apply = (quorumSize) =>
		applyParamsToScript(spend.compiledCode, [
			OWNER,
			Array.from({ length: quorumSize }, () => AGENT),
			2,
			{ alternative: 0, fields: [{ alternative: 0, fields: [STAKE] }] },
		]);
	const first = resolveScriptHash(apply(1), 'V3');
	assert.notEqual(first, resolveScriptHash(apply(2), 'V3'), 'the config must change the script hash');
	assert.equal(first, resolveScriptHash(apply(1), 'V3'), 'derivation must be deterministic');
	console.log(`ok   policy id is the script hash, config-sensitive (${first.slice(0, 16)}...)`);

	// The seed is a runtime input now: it moves the token NAME, not the address.
	// This vector pins the JS derivation to the on-chain one — mirrored by
	// `derived_names_are_index_sensitive` in mint_test.ak, same preimage layout
	// as Epora's, whose 4-byte fixed-width index avoids preimage collisions.
	const nameA = stateTokenName({ txHash: '0'.repeat(64), outputIndex: 0 });
	const nameB = stateTokenName({ txHash: '0'.repeat(64), outputIndex: 1 });
	assert.equal(nameA.length, 64, 'token names are 32 bytes');
	assert.notEqual(nameA, nameB, 'the seed index must change the token name');
	console.log(`ok   token name derives from the seed (${nameA.slice(0, 16)}...)`);
}

// ## Budget arithmetic

{
	const datum = baseDatum();
	const outflow = outflowOf(
		[{ unit: 'lovelace', quantity: '100000000' }],
		[{ unit: 'lovelace', quantity: '96000000' }],
	);
	const next = applyAgentSpend(datum, outflow, validity(now + 1000n, now + 300_000n));
	assert.equal(assetValueGet(next.spentInPeriod, '', ''), 4_000_000n);
	assert.equal(next.periodStart, now, 'window must not move inside the period');
	assert.deepEqual([...next.spentInPeriod.keys()], [...datum.spentInPeriod.keys()], 'order preserved');
	console.log('ok   spend inside the window accumulates and keeps its order');
}

{
	const datum = baseDatum();
	datum.spentInPeriod = mapAssetValue(datum.spentInPeriod, (p) => (p === '' ? 9_000_000n : 0n));
	const lower = now + DAY_MS;
	const outflow = outflowOf(
		[{ unit: 'lovelace', quantity: '100000000' }],
		[{ unit: 'lovelace', quantity: '93000000' }],
	);
	const next = applyAgentSpend(datum, outflow, validity(lower, lower + 300_000n));
	assert.equal(assetValueGet(next.spentInPeriod, '', ''), 7_000_000n, 'roll-over resets the counter');
	assert.equal(next.periodStart, lower);
	console.log('ok   elapsed window rolls over');
}

throws(
	'over-budget spend is rejected',
	() =>
		applyAgentSpend(
			baseDatum(),
			outflowOf(
				[{ unit: 'lovelace', quantity: '100000000' }],
				[{ unit: 'lovelace', quantity: '89000000' }],
			),
			validity(now + 1000n, now + 300_000n),
		),
	/Budget exceeded/,
);

throws(
	'moving an unlisted asset is rejected',
	() =>
		applyAgentSpend(
			baseDatum(),
			outflowOf(
				[
					{ unit: 'lovelace', quantity: '100000000' },
					{ unit: `${NFT}41474554`, quantity: '1' },
				],
				[{ unit: 'lovelace', quantity: '100000000' }],
			),
			validity(now + 1000n, now + 300_000n),
		),
	/frozen/,
);

throws(
	'roll-over with an over-long validity range is rejected',
	() => {
		const lower = now + DAY_MS;
		return applyAgentSpend(
			baseDatum(),
			outflowOf(
				[{ unit: 'lovelace', quantity: '100000000' }],
				[{ unit: 'lovelace', quantity: '99000000' }],
			),
			validity(lower, lower + 2n * DAY_MS),
		);
	},
	/longer than the period/,
);

// ## Value handling

{
	const wallet = [
		{ unit: 'lovelace', quantity: '100000000' },
		{ unit: `${'aa'.repeat(28)}${stateTokenName({ txHash: '0'.repeat(64), outputIndex: 0 })}`, quantity: '1' },
	];
	const remaining = assetsMinus(wallet, [{ unit: 'lovelace', quantity: '5000000' }]);
	assert.equal(lovelaceOf(remaining), 95_000_000n);
	assert.ok(
		remaining.some((asset) => asset.unit.startsWith('aa'.repeat(28))),
		'the state token must ride through — the validator freezes it in place',
	);
	console.log('ok   payout keeps the state token on the continuing output');
}

{
	const wallet = [{ unit: 'lovelace', quantity: '10000000' }];
	const topped = assetsPlus(wallet, [{ unit: 'lovelace', quantity: '50000000' }]);
	assert.equal(lovelaceOf(topped), 60_000_000n);
	console.log('ok   deposit increases the balance');
}

throws(
	'payout above the balance is rejected',
	() => assetsMinus([{ unit: 'lovelace', quantity: '1000000' }], [{ unit: 'lovelace', quantity: '5000000' }]),
	/exceeds wallet balance/,
);

// ## Inline datum wrapper

{
	const wrapped = inlineWalletDatum(baseDatum());
	assert.equal(wrapped.inline, true);
	assert.equal(wrapped.value.alternative, 0);
	assert.equal(wrapped.value.fields.length, 6);
	console.log('ok   inline datum wrapper has the shape mesh expects');
}

console.log('\nAll offline checks passed.');
