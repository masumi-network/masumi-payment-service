import fs from 'node:fs';
import { blake2b } from '@meshsdk/core-cst';
import {
	applyParamsToScript,
	DEFAULT_V1_COST_MODEL_LIST,
	DEFAULT_V2_COST_MODEL_LIST,
	DEFAULT_V3_COST_MODEL_LIST,
	deserializeDatum,
	KoiosProvider,
	MeshWallet,
	resolvePaymentKeyHash,
	resolveScriptHash,
	resolveStakeKeyHash,
	serializePlutusScript,
	SLOT_CONFIG_NETWORK,
	unixTimeToEnclosingSlot,
} from '@meshsdk/core';

export const network = process.env.NETWORK ?? 'preprod';
export const networkId = network === 'mainnet' ? 1 : 0;
export const blockchainProvider = new KoiosProvider(network);

export const OWNER_WALLET_INDEX = 1;
export const AGENT_WALLET_INDEX = 2;
export const RECIPIENT_WALLET_INDEX = 3;
/// Co-signers. Each is a separate service in production; here they are wallets.
export const COSIGNER_WALLET_INDEXES = [4, 5, 6];

/// Redeemer constructor indices, mirroring `smart_wallet/types.Action`.
export const Action = {
	AgentSpend: 0,
	Deposit: 1,
	UpdatePolicy: 2,
	OwnerSpend: 3,
};

/// Constructor indices of `cardano/address.Credential`.
export const CredentialKind = { VerificationKey: 0, Script: 1 };

/// State-token name for a wallet: blake2b_256(seed_tx_id ++ seed_index_be4).
/// Mirrors `state_token_name` in lib/smart_wallet/mint.ak — the shared test
/// vector lives in verify-offline.mjs, pinning both sides of the boundary.
export function stateTokenName(seed) {
	const index = Buffer.alloc(4);
	index.writeUInt32BE(seed.outputIndex);
	return blake2b(32)
		.update(Buffer.concat([Buffer.from(seed.txHash, 'hex'), index]))
		.digest('hex');
}

const VALIDATOR_TITLE = 'smart_wallet.smart_wallet.spend';
const SEED_FILE = 'wallet-seed.json';

// Sync mesh-sdk's bundled Plutus cost-model arrays with the chain-current
// values before any tx build. Mesh hardcodes the imported cost-model lists when
// computing script_data_hash; if they drift from on-chain values the ledger
// rejects submissions with `PPViewHashesDontMatch`. Same approach as
// smart-contracts/payment-v2/example-helpers.mjs.
let costModelsSynced = false;
export async function syncCostModelsFromChain() {
	if (costModelsSynced) return;
	const url = `https://${network === 'mainnet' ? 'api' : network}.koios.rest/api/v1/cli_protocol_params`;
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Koios cli_protocol_params HTTP ${res.status}: ${await res.text()}`);
	}
	const params = await res.json();
	const apply = (target, source, label) => {
		if (!Array.isArray(source)) throw new Error(`Koios returned non-array cost model for ${label}`);
		const numeric = source.map((value) => (typeof value === 'number' ? value : Number(value)));
		if (numeric.some((value) => !Number.isFinite(value))) {
			throw new Error(`Koios cost model for ${label} contains non-numeric values`);
		}
		target.length = 0;
		for (const value of numeric) target.push(value);
	};
	apply(DEFAULT_V1_COST_MODEL_LIST, params.costModels?.PlutusV1, 'PlutusV1');
	apply(DEFAULT_V2_COST_MODEL_LIST, params.costModels?.PlutusV2, 'PlutusV2');
	apply(DEFAULT_V3_COST_MODEL_LIST, params.costModels?.PlutusV3, 'PlutusV3');
	costModelsSynced = true;
}

// ## Files and wallets

export function readText(path) {
	return fs.readFileSync(path, 'utf8').trim();
}

export function readAddress(walletIndex) {
	const path = `wallet_${walletIndex}.addr`;
	if (!fs.existsSync(path)) {
		throw new Error(`${path} not found. Run pnpm run generate-wallet first.`);
	}
	return readText(path);
}

export function loadWallet(walletIndex) {
	const path = `wallet_${walletIndex}.sk`;
	if (!fs.existsSync(path)) {
		throw new Error(`${path} not found. Run pnpm run generate-wallet first.`);
	}
	return new MeshWallet({
		networkId,
		fetcher: blockchainProvider,
		submitter: blockchainProvider,
		key: { type: 'mnemonic', words: readText(path).split(/\s+/) },
	});
}

export async function firstWalletAddress(wallet) {
	const unused = await wallet.getUnusedAddresses();
	if (unused.length > 0) return unused[0];
	const used = await wallet.getUsedAddresses();
	if (used.length > 0) return used[0];
	throw new Error('Wallet has no available address');
}

export function assertHex(value, label) {
	if (typeof value !== 'string' || !/^[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
		throw new Error(`${label} must be an even-length hex string, got ${value}`);
	}
	return value.toLowerCase();
}

// ## The seed
//
// The seed is the UTxO consumed when this wallet's token was minted. It is NOT
// a script parameter — the address is shared by every wallet under this
// configuration — but its hash IS the token name, and the token name is this
// wallet's identity. Lose this file and you can no longer tell which shard at
// the address is yours except by elimination.

export function readSeed() {
	if (!fs.existsSync(SEED_FILE)) {
		throw new Error(`${SEED_FILE} not found. Run pnpm run init to create the wallet.`);
	}
	const seed = JSON.parse(readText(SEED_FILE));
	assertHex(seed.txHash, 'seed txHash');
	if (!Number.isInteger(seed.outputIndex)) throw new Error('seed outputIndex must be an integer');
	return seed;
}

export function writeSeed(seed) {
	fs.writeFileSync(SEED_FILE, `${JSON.stringify(seed, null, 2)}\n`);
}

export function hasSeed() {
	return fs.existsSync(SEED_FILE);
}

// ## Script and address

export function quorumKeyHashes() {
	const fromEnv = (process.env.QUORUM_KEY_HASHES ?? '').split(',').filter(Boolean);
	if (fromEnv.length > 0) return fromEnv.map((hash) => assertHex(hash.trim(), 'quorum key hash'));
	return COSIGNER_WALLET_INDEXES.map((index) => resolvePaymentKeyHash(readAddress(index)));
}

export function quorumThreshold() {
	return Number(process.env.QUORUM_THRESHOLD ?? 2);
}

function someCredential(keyHash) {
	return {
		alternative: 0,
		fields: [{ alternative: CredentialKind.VerificationKey, fields: [keyHash] }],
	};
}

/// Everything about the wallet that is fixed at deployment.
///
/// The address carries the owner's stake credential, and the validator pins it:
/// the mint refuses to create the token anywhere else, and every spend must
/// return to the very same full address. So the address below is the only one
/// this configuration can ever produce.
export function loadSmartWalletScript(seedOverride) {
	const blueprint = JSON.parse(readText('./plutus.json'));
	const validator = blueprint.validators.find((entry) => entry.title === VALIDATOR_TITLE);
	if (!validator) {
		throw new Error(`${VALIDATOR_TITLE} not found in plutus.json. Run aiken build first.`);
	}

	const ownerAddress = readAddress(OWNER_WALLET_INDEX);
	const owner = resolvePaymentKeyHash(ownerAddress);
	const stakeKeyHash = resolveStakeKeyHash(ownerAddress);
	const quorum = quorumKeyHashes();
	const threshold = quorumThreshold();
	const seed = seedOverride ?? readSeed();

	// The seed is NOT a parameter: one script and one address serve every wallet
	// under this configuration. The seed only determines the token NAME, which
	// is what identifies this wallet among its siblings at the same address.
	const code = applyParamsToScript(validator.compiledCode, [
		owner,
		quorum,
		threshold,
		someCredential(stakeKeyHash),
	]);
	const script = { code, version: 'V3' };
	const policyId = resolveScriptHash(code, 'V3');
	const { address } = serializePlutusScript(script, stakeKeyHash, networkId);

	return {
		script,
		address,
		policyId,
		stateTokenUnit: `${policyId}${stateTokenName(seed)}`,
		owner,
		ownerAddress,
		stakeKeyHash,
		quorum,
		threshold,
		seed,
	};
}

// ## AssetValue — the datum's `Pairs<policy, Pairs<name, quantity>>`
//
// `Pairs` serialises to a PlutusData **Map**, not a list, so these are JS Maps.

function splitUnit(unit) {
	if (unit === 'lovelace' || unit === '') return { policyId: '', assetName: '' };
	return { policyId: unit.slice(0, 56), assetName: unit.slice(56) };
}

function compareHex(a, b) {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/// Build an AssetValue from `[{ unit, quantity }]`, sorted bytewise.
///
/// Sorting matters: the validator requires `limit` and `spent_in_period` to
/// list the same assets **in the same order**, and rebuilds the counter by
/// mapping in place. A deterministic order here is what keeps the two agreeing.
export function assetValueData(assets) {
	const policies = new Map();
	for (const asset of assets) {
		const { policyId, assetName } = splitUnit(asset.unit);
		const byName = policies.get(policyId) ?? new Map();
		byName.set(assetName, (byName.get(assetName) ?? 0n) + BigInt(asset.quantity));
		policies.set(policyId, byName);
	}
	return new Map(
		[...policies.entries()]
			.map(([policyId, byName]) => [
				policyId,
				new Map([...byName.entries()].sort(([a], [b]) => compareHex(a, b))),
			])
			.sort(([a], [b]) => compareHex(a, b)),
	);
}

/// Rebuild an AssetValue **preserving the order it already has on-chain**.
///
/// Never re-sort a datum read back from the chain: the validator compares the
/// continuing datum for equality, and a different order is a different datum.
export function mapAssetValue(value, transform) {
	return new Map(
		[...value.entries()].map(([policyId, byName]) => [
			policyId,
			new Map([...byName.entries()].map(([assetName, quantity]) => [
				assetName,
				transform(policyId, assetName, quantity),
			])),
		]),
	);
}

export function assetValueGet(value, policyId, assetName) {
	return value.get(policyId)?.get(assetName);
}

export function assetValueEntries(value) {
	const entries = [];
	for (const [policyId, byName] of value) {
		for (const [assetName, quantity] of byName) {
			entries.push({ policyId, assetName, quantity });
		}
	}
	return entries;
}

// ## Datum

export function walletDatumData(datum) {
	return {
		alternative: 0,
		fields: [
			assertHex(datum.agent, 'agent key hash'),
			datum.limit,
			BigInt(datum.periodLength),
			BigInt(datum.periodStart),
			datum.spentInPeriod,
			BigInt(datum.minBalanceLovelace),
		],
	};
}

export function inlineWalletDatum(datum) {
	return { value: walletDatumData(datum), inline: true };
}

export function actionData(action, fields = []) {
	return { data: { alternative: action, fields } };
}

function fromDeserializerData(value) {
	if (Array.isArray(value)) return value.map(fromDeserializerData);
	if (value != null && typeof value === 'object') {
		if ('constructor' in value && 'fields' in value) {
			return {
				alternative: Number(value.constructor),
				fields: value.fields.map(fromDeserializerData),
			};
		}
		if ('bytes' in value) return value.bytes;
		if ('int' in value) return BigInt(value.int);
		if ('list' in value) return value.list.map(fromDeserializerData);
		if ('map' in value) {
			return new Map(
				value.map.map((entry) => [fromDeserializerData(entry.k), fromDeserializerData(entry.v)]),
			);
		}
	}
	throw new Error(`Unsupported datum value: ${JSON.stringify(value)}`);
}

export function readWalletDatum(utxo) {
	if (!utxo.output.plutusData) throw new Error('Wallet UTxO has no inline datum');
	const value = fromDeserializerData(deserializeDatum(utxo.output.plutusData));
	if (value.alternative !== 0 || value.fields.length !== 6) {
		throw new Error(`Expected wallet datum with 6 fields, got ${value.fields?.length}`);
	}
	const [agent, limit, periodLength, periodStart, spentInPeriod, minBalance] = value.fields;
	if (!(limit instanceof Map) || !(spentInPeriod instanceof Map)) {
		throw new Error('limit and spent_in_period must be PlutusData maps');
	}
	return {
		agent,
		limit,
		periodLength: BigInt(periodLength),
		periodStart: BigInt(periodStart),
		spentInPeriod,
		minBalanceLovelace: BigInt(minBalance),
	};
}

// ## UTxO selection
//
// The wallet is found by its state token, not by scanning the address. The
// token's policy id is the script hash, which we already computed to derive the
// address, so the asset id costs nothing extra — and junk UTxOs parked at the
// address are invisible to this lookup.

export async function fetchWalletUtxo(provider, wallet) {
	const utxos = await provider.fetchAddressUTxOs(wallet.address);
	const held = utxos.filter((utxo) =>
		utxo.output.amount.some((asset) => asset.unit === wallet.stateTokenUnit && BigInt(asset.quantity) === 1n),
	);
	if (held.length === 0) {
		throw new Error(
			`No UTxO carrying the state token ${wallet.stateTokenUnit} at ${wallet.address}. ` +
				'Run pnpm run init, or check that the seed in wallet-seed.json matches this wallet.',
		);
	}
	if (held.length > 1) {
		// The one-shot policy makes this impossible on a correctly deployed
		// wallet; if it happens, something is very wrong.
		throw new Error(`${held.length} UTxOs carry the state token. The one-shot mint should make this impossible.`);
	}
	return held[0];
}

// ## Assets

export function lovelaceOf(assets) {
	const entry = assets.find((asset) => asset.unit === 'lovelace' || asset.unit === '');
	return entry ? BigInt(entry.quantity) : 0n;
}

export function lovelaceAsset(quantity) {
	return [{ unit: 'lovelace', quantity: BigInt(quantity).toString() }];
}

/// Wallet value minus a payout, keeping every other asset — including the state
/// token, which the validator freezes in place.
export function assetsMinus(assets, payout) {
	const remaining = new Map();
	for (const asset of assets) remaining.set(asset.unit, BigInt(asset.quantity));
	for (const asset of payout) {
		const left = (remaining.get(asset.unit) ?? 0n) - BigInt(asset.quantity);
		if (left < 0n) throw new Error(`Payout exceeds wallet balance for ${asset.unit}`);
		remaining.set(asset.unit, left);
	}
	return [...remaining.entries()]
		.filter(([, quantity]) => quantity > 0n)
		.map(([unit, quantity]) => ({ unit, quantity: quantity.toString() }));
}

export function assetsPlus(assets, deposit) {
	return assetsMinus(assets, deposit.map((asset) => ({ ...asset, quantity: (-BigInt(asset.quantity)).toString() })));
}

// ## Validity range

function slotConfig() {
	return SLOT_CONFIG_NETWORK[network] ?? SLOT_CONFIG_NETWORK.preprod;
}

function slotToMs(slot, config) {
	return config.zeroTime + (slot - config.zeroSlot) * config.slotLength;
}

/// Slots for the transaction, plus the POSIX bounds the script will observe.
///
/// The datum arithmetic has to use the *script's* view of the range: the ledger
/// derives the bounds from these slots, and being a millisecond out can flip the
/// roll-over branch and make the on-chain datum comparison fail.
export function resolveValidity() {
	const config = slotConfig();
	const now = Date.now();
	// 5-minute back-buffer: a local clock only ~1 minute ahead of the chain
	// already produced OutsideValidityIntervalUTxO with a 60s buffer.
	const beforeMs = Number(process.env.INVALID_BEFORE_MS ?? now - 300_000);
	const afterMs = Number(process.env.INVALID_AFTER_MS ?? now + 5 * 60_000);
	const invalidBefore = unixTimeToEnclosingSlot(beforeMs, config) - 1;
	const invalidAfter = unixTimeToEnclosingSlot(afterMs, config) + 1;
	return {
		invalidBefore,
		invalidAfter,
		lowerMs: BigInt(slotToMs(invalidBefore, config)),
		upperMs: BigInt(slotToMs(invalidAfter, config)),
	};
}

export function applyValidity(tx, validity) {
	tx.txBuilder.invalidBefore(validity.invalidBefore);
	tx.txBuilder.invalidHereafter(validity.invalidAfter);
	tx.setNetwork(network);
	return tx;
}

// ## Budget arithmetic — mirrors lib/smart_wallet/spend.ak
//
// Every rule reproduced here is enforced on-chain too. Failing early just turns
// a phase-2 script error into a message that says which rule broke.

/// Mirrors `max_assets` in lib/smart_wallet/asset_value.ak.
export const MAX_ASSETS = 16;

export function applyAgentSpend(datum, outflow, validity) {
	if (assetValueEntries(datum.limit).length > MAX_ASSETS) {
		throw new Error(`limit lists more than ${MAX_ASSETS} assets; the validator rejects the spend`);
	}
	const moved = assetValueEntries(outflow);
	for (const { policyId, assetName, quantity } of moved) {
		if (assetValueGet(datum.limit, policyId, assetName) === undefined) {
			throw new Error(
				`Asset ${policyId || 'lovelace'}.${assetName} moved but has no limit entry, so it is frozen`,
			);
		}
		if (quantity < 0n) {
			throw new Error('Use the Deposit action to add value; an agent spend may not take a negative outflow');
		}
	}

	const rolledOver = validity.lowerMs >= datum.periodStart + datum.periodLength;
	if (rolledOver && validity.upperMs > validity.lowerMs + datum.periodLength) {
		throw new Error(
			'Validity range is longer than the period, which the validator rejects on roll-over. ' +
				'Shorten it with INVALID_AFTER_MS.',
		);
	}

	const periodStart = rolledOver ? validity.lowerMs : datum.periodStart;
	const spentInPeriod = mapAssetValue(datum.spentInPeriod, (policyId, assetName, quantity) => {
		const base = rolledOver ? 0n : quantity;
		const delta = assetValueGet(outflow, policyId, assetName) ?? 0n;
		return base + (delta > 0n ? delta : 0n);
	});

	for (const { policyId, assetName, quantity } of assetValueEntries(spentInPeriod)) {
		const allowed = assetValueGet(datum.limit, policyId, assetName);
		if (allowed === undefined || quantity > allowed) {
			throw new Error(
				`Budget exceeded for ${policyId || 'lovelace'}.${assetName}: ${quantity} > ${allowed ?? 0n}`,
			);
		}
	}

	return { ...datum, periodStart, spentInPeriod };
}

/// The outflow an agent spend produces, as an AssetValue keyed like the datum.
export function outflowOf(before, after) {
	const deltas = new Map();
	for (const asset of before) deltas.set(asset.unit, BigInt(asset.quantity));
	for (const asset of after) deltas.set(asset.unit, (deltas.get(asset.unit) ?? 0n) - BigInt(asset.quantity));
	return assetValueData(
		[...deltas.entries()]
			.filter(([, quantity]) => quantity !== 0n)
			.map(([unit, quantity]) => ({ unit, quantity: quantity.toString() })),
	);
}

// ## Signing
//
// An agent spend needs the agent *and* a quorum of co-signers, so the body is
// built once and passed from wallet to wallet. Every signature covers the same
// body hash — which is why the body has to be final before collection starts,
// and why any rebuild afterwards invalidates all of them.

export async function signWith(wallets, unsignedTx) {
	let tx = unsignedTx;
	for (const wallet of wallets) {
		tx = await wallet.signTx(tx, true);
	}
	return tx;
}

/// A key-locked UTxO to offer as collateral.
///
/// Collateral must be key-locked and disjoint from the script inputs — the
/// ledger rejects a script-locked one outright with `CollateralLockedByScript`.
/// It is not consumed on success, so this is a reserve the agent lends rather
/// than spends.
/// Mixed-asset UTxOs are perfectly legal collateral — that restriction went
/// away with Babbage / CIP-40, and it matters here because the preprod faucet
/// hands out ADA bundled with tUSDM, so a freshly funded wallet may own no
/// pure-ADA UTxO at all. Pure ADA is only *preferred*, to avoid the
/// collateral-return overhead.
export function pickCollateral(utxos) {
	const candidates = utxos
		.filter((utxo) => lovelaceOf(utxo.output.amount) >= 5_000_000n)
		.sort((a, b) => {
			const pure = (utxo) => (utxo.output.amount.length === 1 ? 0 : 1);
			if (pure(a) !== pure(b)) return pure(a) - pure(b);
			return Number(lovelaceOf(a.output.amount) - lovelaceOf(b.output.amount));
		});
	if (candidates.length === 0) {
		throw new Error('No UTxO of at least 5 ADA to use as collateral. Fund this wallet.');
	}
	return candidates[0];
}

export function explorerUrl(txHash) {
	return `https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${txHash}`;
}
