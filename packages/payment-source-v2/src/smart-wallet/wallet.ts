// Mesh SDK pinning: this file lives in the V2 package and resolves the V2 mesh
// line (`@meshsdk/core-cst@1.9.1`). See docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
//
// Off-chain mirror of the agent treasury smart wallet in
// `smart-contracts/smart-wallet` (PR 729). Every rule here is also enforced by
// the validator; checking it first turns a phase-2 script failure into an error
// that names the broken rule before any transaction is built.
import type { Asset, Data } from '@meshsdk/core';
import { blake2b, HexBlob } from '@meshsdk/core-cst';
import { getOwnValue, isPlainObject, type RuntimePropertyValue } from '@masumi/payment-core/object-properties';

/** Redeemer constructor indices of `smart_wallet/types.Action`. */
export const SmartWalletAction = {
	AgentSpend: 0,
	Deposit: 1,
	UpdatePolicy: 2,
	OwnerSpend: 3,
} as const;

/** Mirrors `max_assets` in `lib/smart_wallet/asset_value.ak`. */
export const MAX_WALLET_ASSETS = 16;

const LOVELACE_POLICY = '';
const LOVELACE_NAME = '';
const HEX_PATTERN = /^(?:[0-9a-f]{2})*$/;
const INTEGER_PATTERN = /^-?\d+$/;

/**
 * The datum's `Pairs<policy, Pairs<name, quantity>>`. Pairs serialise to a
 * PlutusData map, and the validator compares the continuing datum for byte
 * equality, so Map insertion order IS the on-chain order and must be preserved.
 */
export type AssetValue = Map<string, Map<string, bigint>>;

export type WalletDatum = {
	agent: string;
	limit: AssetValue;
	periodLength: bigint;
	periodStart: bigint;
	spentInPeriod: AssetValue;
	minBalanceLovelace: bigint;
};

/** POSIX milliseconds the validator observes for the transaction's validity range. */
export type ValidityMs = { lowerMs: bigint; upperMs: bigint };

function assertHex(value: string, label: string, byteLength?: number): void {
	if (!HEX_PATTERN.test(value) || (byteLength != null && value.length !== byteLength * 2)) {
		throw new Error(
			`${label} must be lowercase hex${byteLength == null ? '' : ` of ${byteLength} bytes`}, got "${value.slice(0, 80)}"`,
		);
	}
}

function parseQuantity(quantity: string, label: string): bigint {
	if (!INTEGER_PATTERN.test(quantity)) {
		throw new Error(`${label} quantity must be an integer string, got "${quantity}"`);
	}
	return BigInt(quantity);
}

function splitUnit(unit: string): { policyId: string; assetName: string } {
	if (unit === 'lovelace' || unit === '') {
		return { policyId: LOVELACE_POLICY, assetName: LOVELACE_NAME };
	}
	if (unit.length < 56) {
		throw new Error(`Asset unit "${unit}" is shorter than a policy id`);
	}
	const policyId = unit.slice(0, 56);
	const assetName = unit.slice(56);
	assertHex(policyId, 'policy id', 28);
	assertHex(assetName, 'asset name');
	return { policyId, assetName };
}

function assetLabel(policyId: string, assetName: string): string {
	return policyId === LOVELACE_POLICY ? 'lovelace' : `${policyId}.${assetName}`;
}

function compareHex(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/**
 * State-token name for the wallet seeded by `seed`:
 * `blake2b_256(transaction_id ++ output_index as 4-byte big-endian)`.
 * Mirrors `state_token_name` in `lib/smart_wallet/mint.ak`.
 */
export function stateTokenName(seed: { txHash: string; outputIndex: number }): string {
	assertHex(seed.txHash, 'seed txHash', 32);
	if (!Number.isInteger(seed.outputIndex) || seed.outputIndex < 0 || seed.outputIndex > 0xffffffff) {
		throw new Error(`seed outputIndex must be a 32-bit unsigned integer, got ${seed.outputIndex}`);
	}
	const index = Buffer.alloc(4);
	index.writeUInt32BE(seed.outputIndex);
	return blake2b.hash(HexBlob(Buffer.concat([Buffer.from(seed.txHash, 'hex'), index]).toString('hex')), 32);
}

/** Build an AssetValue from mesh assets, summing duplicates and sorting bytewise for a deterministic order. */
export function assetValueData(assets: Asset[]): AssetValue {
	const policies = new Map<string, Map<string, bigint>>();
	for (const asset of assets) {
		const { policyId, assetName } = splitUnit(asset.unit);
		const names = policies.get(policyId) ?? new Map<string, bigint>();
		names.set(assetName, (names.get(assetName) ?? 0n) + parseQuantity(asset.quantity, asset.unit));
		policies.set(policyId, names);
	}
	return new Map(
		[...policies.entries()]
			.sort(([a], [b]) => compareHex(a, b))
			.map(([policyId, names]) => [policyId, new Map([...names.entries()].sort(([a], [b]) => compareHex(a, b)))]),
	);
}

/** Rebuild an AssetValue keeping the order it already has. Never re-sort a datum read from chain. */
export function mapAssetValue(
	value: AssetValue,
	transform: (policyId: string, assetName: string, quantity: bigint) => bigint,
): AssetValue {
	return new Map(
		[...value.entries()].map(([policyId, names]) => [
			policyId,
			new Map(
				[...names.entries()].map(([assetName, quantity]) => [assetName, transform(policyId, assetName, quantity)]),
			),
		]),
	);
}

export function assetValueGet(value: AssetValue, policyId: string, assetName: string): bigint | undefined {
	return value.get(policyId)?.get(assetName);
}

export function assetValueEntries(value: AssetValue): Array<{ policyId: string; assetName: string; quantity: bigint }> {
	return [...value.entries()].flatMap(([policyId, names]) =>
		[...names.entries()].map(([assetName, quantity]) => ({ policyId, assetName, quantity })),
	);
}

function assetValueKeys(value: AssetValue): string[] {
	return assetValueEntries(value).map(({ policyId, assetName }) => `${policyId}.${assetName}`);
}

function assetValuePlutusData(value: AssetValue): Map<Data, Data> {
	return new Map<Data, Data>(
		[...value.entries()].map(([policyId, names]) => [policyId, new Map<Data, Data>([...names.entries()])]),
	);
}

/** Inline datum in mesh `Data` form, field order matching `smart_wallet/types.Datum`. */
export function walletDatumData(datum: WalletDatum): Data {
	assertHex(datum.agent, 'agent key hash', 28);
	return {
		alternative: 0,
		fields: [
			datum.agent,
			assetValuePlutusData(datum.limit),
			datum.periodLength,
			datum.periodStart,
			assetValuePlutusData(datum.spentInPeriod),
			datum.minBalanceLovelace,
		],
	};
}

type DeserializedValue = RuntimePropertyValue;

function readBytes(value: DeserializedValue, label: string): string {
	const bytes = isPlainObject(value) ? getOwnValue(value, 'bytes') : undefined;
	if (typeof bytes !== 'string') {
		throw new Error(`Wallet datum ${label} must be bytes`);
	}
	return bytes.toLowerCase();
}

function readInt(value: DeserializedValue, label: string): bigint {
	const int = isPlainObject(value) ? getOwnValue(value, 'int') : undefined;
	if (typeof int === 'number' && Number.isSafeInteger(int)) return BigInt(int);
	if (typeof int === 'bigint') return int;
	if (typeof int === 'string' && INTEGER_PATTERN.test(int)) return BigInt(int);
	throw new Error(`Wallet datum ${label} must be an integer`);
}

function isValueList(value: DeserializedValue): value is DeserializedValue[] {
	return Array.isArray(value);
}

function readMapEntries(value: DeserializedValue, label: string): Array<[DeserializedValue, DeserializedValue]> {
	const entries = isPlainObject(value) ? getOwnValue(value, 'map') : undefined;
	if (!isValueList(entries)) {
		throw new Error(`Wallet datum ${label} must be a map`);
	}
	return entries.map((entry) => {
		if (!isPlainObject(entry)) throw new Error(`Wallet datum ${label} has a malformed map entry`);
		return [getOwnValue(entry, 'k'), getOwnValue(entry, 'v')];
	});
}

function readAssetValue(value: DeserializedValue, label: string): AssetValue {
	const policies: AssetValue = new Map();
	for (const [policyKey, namesValue] of readMapEntries(value, label)) {
		const policyId = readBytes(policyKey, `${label} policy id`);
		if (policies.has(policyId)) {
			// The validator fails closed on duplicates; a JS Map would silently collapse them.
			throw new Error(`Wallet datum ${label} lists policy "${policyId}" twice`);
		}
		const names = new Map<string, bigint>();
		for (const [nameKey, quantityValue] of readMapEntries(namesValue, `${label} names`)) {
			const assetName = readBytes(nameKey, `${label} asset name`);
			if (names.has(assetName)) {
				throw new Error(`Wallet datum ${label} lists asset "${assetLabel(policyId, assetName)}" twice`);
			}
			names.set(assetName, readInt(quantityValue, `${label} quantity`));
		}
		policies.set(policyId, names);
	}
	return policies;
}

/**
 * Parse the JSON shape `deserializeDatum` returns for the wallet datum. Throws
 * on anything that is not the 6-field `Datum` constructor, so a malformed or
 * foreign datum is never treated as a wallet.
 */
export function parseWalletDatum(deserialized: DeserializedValue): WalletDatum {
	if (!isPlainObject(deserialized)) throw new Error('Wallet datum must be a constructor');
	const constructorIndex = getOwnValue(deserialized, 'constructor');
	const fields = getOwnValue(deserialized, 'fields');
	if (Number(constructorIndex) !== 0 || !isValueList(fields) || fields.length !== 6) {
		throw new Error('Wallet datum must be constructor 0 with 6 fields');
	}
	const agent = readBytes(fields[0], 'agent');
	assertHex(agent, 'agent key hash', 28);
	return {
		agent,
		limit: readAssetValue(fields[1], 'limit'),
		periodLength: readInt(fields[2], 'period_length'),
		periodStart: readInt(fields[3], 'period_start'),
		spentInPeriod: readAssetValue(fields[4], 'spent_in_period'),
		minBalanceLovelace: readInt(fields[5], 'min_balance_lovelace'),
	};
}

export function lovelaceOf(assets: Asset[]): bigint {
	return assets
		.filter((asset) => asset.unit === 'lovelace' || asset.unit === '')
		.reduce((sum, asset) => sum + parseQuantity(asset.quantity, 'lovelace'), 0n);
}

/** `assets − payout` per unit, keeping every other asset (the state token included). Throws if any unit goes negative. */
export function assetsMinus(assets: Asset[], payout: Asset[]): Asset[] {
	const normalize = (unit: string) => (unit === '' ? 'lovelace' : unit);
	const remaining = new Map<string, bigint>();
	for (const asset of assets) {
		const unit = normalize(asset.unit);
		remaining.set(unit, (remaining.get(unit) ?? 0n) + parseQuantity(asset.quantity, unit));
	}
	for (const asset of payout) {
		const unit = normalize(asset.unit);
		const left = (remaining.get(unit) ?? 0n) - parseQuantity(asset.quantity, unit);
		if (left < 0n) {
			throw new Error(`Payout exceeds the wallet balance for ${unit}`);
		}
		remaining.set(unit, left);
	}
	return [...remaining.entries()]
		.filter(([, quantity]) => quantity > 0n)
		.map(([unit, quantity]) => ({ unit, quantity: quantity.toString() }));
}

/** Per-asset `before − after`, zero entries dropped. Positive means value left the wallet. */
export function outflowOf(before: Asset[], after: Asset[]): AssetValue {
	const negated = after.map((asset) => ({
		unit: asset.unit,
		quantity: (-parseQuantity(asset.quantity, asset.unit)).toString(),
	}));
	return mapAssetValueDropZero(assetValueData([...before, ...negated]));
}

function mapAssetValueDropZero(value: AssetValue): AssetValue {
	const result: AssetValue = new Map();
	for (const { policyId, assetName, quantity } of assetValueEntries(value)) {
		if (quantity === 0n) continue;
		const names = result.get(policyId) ?? new Map<string, bigint>();
		names.set(assetName, quantity);
		result.set(policyId, names);
	}
	return result;
}

/**
 * The continuing datum an `AgentSpend` must carry, mirroring
 * `agent_spend_is_valid` in `lib/smart_wallet/spend.ak`:
 *
 * - at most MAX_WALLET_ASSETS listed, `limit` and `spent_in_period` in the same order
 * - every asset that moved (either direction) has a limit entry — unlisted assets are frozen
 * - continuing lovelace ≥ `min_balance_lovelace`
 * - roll-over when `lower ≥ period_start + period_length`; the range must then fit one window
 * - only positive outflow is charged; every counter stays ≤ its limit
 */
export function applyAgentSpend(
	datum: WalletDatum,
	spend: { outflow: AssetValue; continuingLovelace: bigint; validity: ValidityMs },
): WalletDatum {
	const limitKeys = assetValueKeys(datum.limit);
	if (limitKeys.length > MAX_WALLET_ASSETS) {
		throw new Error(`limit lists ${limitKeys.length} assets; the validator allows at most ${MAX_WALLET_ASSETS}`);
	}
	if (limitKeys.join('|') !== assetValueKeys(datum.spentInPeriod).join('|')) {
		throw new Error('limit and spent_in_period must list the same assets in the same order');
	}
	for (const { policyId, assetName } of assetValueEntries(spend.outflow)) {
		if (assetValueGet(datum.limit, policyId, assetName) === undefined) {
			throw new Error(`Asset ${assetLabel(policyId, assetName)} moved but has no limit entry, so it is frozen`);
		}
	}
	if (spend.continuingLovelace < datum.minBalanceLovelace) {
		throw new Error(
			`Continuing wallet output keeps ${spend.continuingLovelace} lovelace, below min_balance_lovelace ${datum.minBalanceLovelace}`,
		);
	}

	const { lowerMs, upperMs } = spend.validity;
	const rolledOver = lowerMs >= datum.periodStart + datum.periodLength;
	if (rolledOver && upperMs > lowerMs + datum.periodLength) {
		throw new Error('Validity range is longer than period_length, which the validator rejects on roll-over');
	}

	const spentInPeriod = mapAssetValue(datum.spentInPeriod, (policyId, assetName, spent) => {
		const delta = assetValueGet(spend.outflow, policyId, assetName) ?? 0n;
		return (rolledOver ? 0n : spent) + (delta > 0n ? delta : 0n);
	});
	for (const { policyId, assetName, quantity } of assetValueEntries(spentInPeriod)) {
		const allowed = assetValueGet(datum.limit, policyId, assetName) ?? 0n;
		if (quantity > allowed) {
			throw new Error(`Budget exceeded for ${assetLabel(policyId, assetName)}: ${quantity} > ${allowed}`);
		}
	}

	return {
		...datum,
		periodStart: rolledOver ? lowerMs : datum.periodStart,
		spentInPeriod,
	};
}

/**
 * The checks the contract README hands to deploy tooling, because the
 * validator deliberately does not make them. Run before minting a wallet.
 */
export function assertDeployableWallet(params: {
	owner: string;
	quorumVkhs: string[];
	threshold: number;
	datum: WalletDatum;
	fundLovelace: bigint;
}): void {
	const { owner, quorumVkhs, threshold, datum, fundLovelace } = params;
	assertHex(owner, 'owner key hash', 28);
	quorumVkhs.forEach((vkh) => assertHex(vkh, 'quorum key hash', 28));
	if (!Number.isSafeInteger(threshold) || threshold <= 0) {
		// A threshold of zero or below disables the quorum permanently at this address.
		throw new Error(`quorum threshold must be a positive integer, got ${threshold}`);
	}
	const countedWeight = quorumVkhs.filter((vkh) => vkh !== owner && vkh !== datum.agent).length;
	if (countedWeight < threshold) {
		throw new Error(
			`quorum weight that can count (${countedWeight}) is below the threshold (${threshold}); the agent and owner keys never count`,
		);
	}
	if (quorumVkhs.includes(datum.agent) || datum.agent === owner) {
		throw new Error('the agent key must not be the owner or a quorum member');
	}
	if (assetValueGet(datum.limit, LOVELACE_POLICY, LOVELACE_NAME) === undefined) {
		throw new Error('limit must list lovelace, or the wallet can neither spend nor receive ADA');
	}
	if (assetValueKeys(datum.limit).length > MAX_WALLET_ASSETS) {
		throw new Error(`limit lists more than ${MAX_WALLET_ASSETS} assets`);
	}
	if (assetValueKeys(datum.limit).join('|') !== assetValueKeys(datum.spentInPeriod).join('|')) {
		throw new Error('limit and spent_in_period must list the same assets in the same order');
	}
	if (datum.periodLength <= 0n || datum.minBalanceLovelace < 0n) {
		throw new Error('period_length must be positive and min_balance_lovelace non-negative');
	}
	if (fundLovelace < datum.minBalanceLovelace) {
		throw new Error('the initial funding is below min_balance_lovelace, so the agent could never spend');
	}
}
