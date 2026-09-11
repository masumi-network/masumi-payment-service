import { Address, PlutusData } from '@emurgo/cardano-serialization-lib-nodejs';

import { hydraVerificationKeyRawHex } from './keys';

/** Hydra 2.3 `HydraHeadV2` state-token asset name. */
export const HYDRA_HEAD_V2_ASSET_NAME_HEX = '4879647261486561645632';

/**
 * `vHead` hash from the Hydra script catalogue used by this deployment.
 *
 * Upstream's `hydra-chain-observer/script-hashes.json` at tag 2.4.1 lists the
 * two 2.4.x hashes the other way round (this one under `depositScriptHashes`).
 * The chain says otherwise: on preprod the InitTx of the recorded 2.4.1 head
 * (`29519fad…`, the first tx of its `HydraHeadV2` token) pays its head output to
 * this script, and the deposit tx `63fc758a…` pays its deposit output to
 * `DEFAULT_HYDRA_DEPOSIT_SCRIPT_HASH`. Do not swap these to match that file.
 */
export const DEFAULT_HYDRA_HEAD_SCRIPT_HASH = '1d511733200df551c8cd8cddb3160ed39087af815638be37a1b80ffd';

/**
 * Script hashes of head versions this deployment has EVER opened a real head
 * against. `resolveHydraHeadScriptHash` stays single-valued for paths that
 * CREATE things (Init, deposits, commits) because every new head is opened
 * against the current pin. But the same constant is also used to RE-OBSERVE
 * heads that already exist on chain (InitTx re-verification, fanout
 * re-verification) — those must keep accepting whatever hash was current when
 * the head they are checking was actually opened. See
 * `knownHydraHeadScriptHashes`.
 */
export const LEGACY_HYDRA_HEAD_SCRIPT_HASHES: readonly string[] = [
	'2b91a7e666575a2465b8c7f6a7f960d5870cf13694a67f3215e014c5', // hydra-node 2.3.0 vHead
];

/** Every head script hash an observation path must still accept: the current pin plus every legacy one. */
export function knownHydraHeadScriptHashes(configuredHash?: string): ReadonlySet<string> {
	return new Set([resolveHydraHeadScriptHash(configuredHash), ...LEGACY_HYDRA_HEAD_SCRIPT_HASHES]);
}

type HydraHeadChainOutput = {
	address: string;
	amount: Array<{ unit: string; quantity: string }>;
	inline_datum: string | null;
};

export type HydraHeadChainObserver = {
	assetsTransactions: (
		asset: string,
		options: { page: number; order: 'asc'; count: number },
	) => Promise<Array<{ tx_hash: string }>>;
	txsUtxos: (txHash: string) => Promise<{ hash: string; outputs: HydraHeadChainOutput[] }>;
};

class HydraHeadInitValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HydraHeadInitValidationError';
	}
}

/** Independent L1 evidence is temporarily unavailable or not indexed yet. */
export class HydraHeadInitObservationError extends Error {
	readonly cause?: unknown;

	constructor(message: string, options?: { cause?: unknown }) {
		super(message);
		this.cause = options?.cause;
		this.name = 'HydraHeadInitObservationError';
	}
}

const DEFAULT_HEAD_INIT_OBSERVER_TIMEOUT_MS = 15_000;

async function withObserverTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new HydraHeadInitObservationError('Hydra InitTx L1 observer timed out')),
					timeoutMs,
				);
				timeout.unref?.();
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

export function resolveHydraHeadScriptHash(configuredHash = process.env.HYDRA_HEAD_SCRIPT_HASH): string {
	return normalizeHex(configuredHash?.trim() || DEFAULT_HYDRA_HEAD_SCRIPT_HASH, 56, 'Hydra head script hash');
}

/**
 * Bind an endpoint-supplied head id to the independently indexed Hydra InitTx.
 *
 * The local node is allowed to supply transport metadata, but it cannot choose a
 * different signing party set or contestation period and still obtain a wallet
 * signature. The state token, official vHead address, Open datum, ordered Hydra
 * keys and on-chain contestation period must all agree first.
 */
export async function verifyHydraHeadInitOnChain(options: {
	observer: HydraHeadChainObserver;
	headId: string;
	expectedVerificationKeys: readonly string[];
	expectedParticipantVkeys: readonly string[];
	contestationPeriodSeconds: bigint;
	/**
	 * The deposit period this head was configured with. hydra-node 2.4 records
	 * it on chain in the Open datum; when a caller knows the value, the two must
	 * agree. Callers that do not (a head recorded before the service kept it)
	 * still get the on-chain figure back in the result.
	 */
	depositPeriodSeconds?: bigint;
	headScriptHash?: string;
	/** Bounds the complete independent observer pass; underlying requests may finish later. */
	observerTimeoutMs?: number;
}): Promise<{ initTxHash: string; depositPeriodMilliseconds: bigint | null }> {
	const headId = normalizeHex(options.headId, 56, 'Hydra head id');
	// Observation, not creation: this re-verifies a head that may have opened
	// under an earlier hydra-node script pin, so any known (current or legacy)
	// head script hash is accepted rather than only today's default.
	const acceptedHeadScriptHashes = knownHydraHeadScriptHashes(options.headScriptHash);
	if (options.expectedVerificationKeys.length !== 2) {
		fail('Hydra on-chain verification requires exactly two configured parties');
	}
	const expectedParties = options.expectedVerificationKeys.map((key) => hydraVerificationKeyRawHex(key));
	if (new Set(expectedParties).size !== expectedParties.length) {
		fail('Hydra configured parties must be distinct');
	}
	if (options.expectedParticipantVkeys.length !== 2) {
		fail('Hydra on-chain verification requires exactly two Cardano participants');
	}
	const expectedParticipantVkeys = options.expectedParticipantVkeys.map((key, index) =>
		normalizeHex(key, 56, `Hydra Cardano participant ${index}`),
	);
	if (new Set(expectedParticipantVkeys).size !== expectedParticipantVkeys.length) {
		fail('Hydra Cardano participants must be distinct');
	}
	if (options.contestationPeriodSeconds <= 0n) {
		fail('Hydra contestation period must be positive');
	}
	const observerTimeoutMs = options.observerTimeoutMs ?? DEFAULT_HEAD_INIT_OBSERVER_TIMEOUT_MS;
	if (!Number.isSafeInteger(observerTimeoutMs) || observerTimeoutMs <= 0 || observerTimeoutMs > 60_000) {
		fail('Hydra InitTx verification received an invalid observer timeout');
	}

	const stateToken = `${headId}${HYDRA_HEAD_V2_ASSET_NAME_HEX}`;
	const { initTxHash, transaction } = await withObserverTimeout(
		(async () => {
			let transactions: Array<{ tx_hash: string }>;
			try {
				transactions = await options.observer.assetsTransactions(stateToken, {
					page: 1,
					order: 'asc',
					count: 1,
				});
			} catch (error) {
				throw new HydraHeadInitObservationError('Hydra InitTx index lookup is temporarily unavailable', {
					cause: error,
				});
			}
			if (transactions.length === 0) {
				throw new HydraHeadInitObservationError('Hydra InitTx has not been indexed yet');
			}
			const initTxHash = normalizeHex(transactions[0]?.tx_hash ?? '', 64, 'Hydra InitTx hash');
			let transaction: { hash: string; outputs: HydraHeadChainOutput[] };
			try {
				transaction = await options.observer.txsUtxos(initTxHash);
			} catch (error) {
				throw new HydraHeadInitObservationError('Hydra InitTx output lookup is temporarily unavailable', {
					cause: error,
				});
			}
			return { initTxHash, transaction };
		})(),
		observerTimeoutMs,
	);
	if (normalizeHex(transaction.hash, 64, 'Hydra InitTx response hash') !== initTxHash) {
		fail('Hydra InitTx response hash did not match the indexed transaction');
	}

	const matchingOutputs = transaction.outputs.filter((output) => {
		const stateTokenQuantity = output.amount
			.filter(({ unit }) => unit.toLowerCase() === stateToken)
			.reduce((sum, { quantity }) => sum + parseQuantity(quantity), 0n);
		return stateTokenQuantity === 1n && acceptedHeadScriptHashes.has(paymentScriptHash(output.address) ?? '');
	});
	if (matchingOutputs.length !== 1) {
		fail('Hydra InitTx did not contain exactly one official head output with its state token');
	}

	const inlineDatum = matchingOutputs[0]?.inline_datum;
	if (!inlineDatum) fail('Hydra InitTx head output omitted its inline Open datum');
	validateHeadTokens(matchingOutputs[0], headId, expectedParticipantVkeys);
	let datum: PlutusData;
	try {
		datum = PlutusData.from_hex(inlineDatum);
	} catch {
		fail('Hydra InitTx head output contained invalid inline datum CBOR');
	}
	// A script can only mint its own version's datum shape, so the layout to
	// expect follows from which head script this output sits at.
	const matchedScriptHash = paymentScriptHash(matchingOutputs[0].address) ?? '';
	const depositPeriodMilliseconds = validateOpenDatum({
		datum,
		headId,
		expectedParties,
		contestationPeriodMilliseconds: options.contestationPeriodSeconds * 1000n,
		layout: LEGACY_HYDRA_HEAD_SCRIPT_HASHES.includes(matchedScriptHash) ? 'hydra-2.3' : 'hydra-2.4',
		expectedDepositPeriodMilliseconds:
			options.depositPeriodSeconds === undefined ? undefined : options.depositPeriodSeconds * 1000n,
	});
	return { initTxHash, depositPeriodMilliseconds };
}

/** Minimal L1 surface needed to resolve the chain-replay anchor of an InitTx. */
export type HydraInitAnchorObserver = {
	txs: (hash: string) => Promise<{ block: string | null }>;
	blocks: (hashOrNumber: string) => Promise<{ hash: string; slot: number | null; previous_block?: string | null }>;
};

/**
 * Resolve the `--start-chain-from` anchor for a verified InitTx: the chain
 * point of the block immediately BEFORE the block that carries the InitTx.
 * hydra-node begins observation strictly AFTER the given point, so the parent
 * block is the newest anchor that still re-observes the InitTx during a
 * persistence-loss chain replay.
 *
 * Best-effort by design: returns null when the parent point cannot be
 * expressed (no previous block, a slot-less block, a non-canonical response)
 * AND on any observer transport failure or timeout. The anchor must never
 * fail a verification that already proved the InitTx — the init backfill
 * retries null anchors on its next cycle. Only a malformed initTxHash throws,
 * because that is a caller bug, not an observation condition.
 */
export async function resolveHydraInitChainAnchor(
	observer: HydraInitAnchorObserver,
	initTxHash: string,
	observerTimeoutMs: number = DEFAULT_HEAD_INIT_OBSERVER_TIMEOUT_MS,
): Promise<{ slot: bigint; hash: string } | null> {
	const canonicalTxHash = normalizeHex(initTxHash, 64, 'Hydra InitTx hash');
	try {
		return await withObserverTimeout(
			(async () => {
				const transaction = await observer.txs(canonicalTxHash);
				if (!transaction.block) return null;
				const initBlock = await observer.blocks(transaction.block);
				const parentHash = initBlock.previous_block;
				if (!parentHash) return null;
				const parent = await observer.blocks(parentHash);
				if (
					parent.slot === null ||
					parent.slot === undefined ||
					!Number.isSafeInteger(parent.slot) ||
					parent.slot < 0
				) {
					return null;
				}
				return { slot: BigInt(parent.slot), hash: normalizeHex(parent.hash, 64, 'Hydra init anchor block hash') };
			})(),
			observerTimeoutMs,
		);
	} catch {
		return null;
	}
}

function validateHeadTokens(
	output: HydraHeadChainOutput,
	headId: string,
	expectedParticipantVkeys: readonly string[],
): void {
	const expectedUnits = new Set([
		`${headId}${HYDRA_HEAD_V2_ASSET_NAME_HEX}`,
		...expectedParticipantVkeys.map((participantVkey) => `${headId}${participantVkey}`),
	]);
	const quantities = new Map<string, bigint>();
	for (const amount of output.amount) {
		const unit = amount.unit.toLowerCase();
		if (!unit.startsWith(headId)) continue;
		quantities.set(unit, (quantities.get(unit) ?? 0n) + parseQuantity(amount.quantity));
	}
	if (
		quantities.size !== expectedUnits.size ||
		[...expectedUnits].some((unit) => quantities.get(unit) !== 1n) ||
		[...quantities].some(([unit]) => !expectedUnits.has(unit))
	) {
		fail('Hydra InitTx head output participant tokens did not match the configured Cardano wallets');
	}
}

/**
 * `Hydra.Contract.HeadState.OpenDatum`, read verbatim from the tagged source:
 *
 *   2.3.0  headSeed, headId, parties, contestationPeriod,                version, accumulatorHash, headAdaOverhead   (7)
 *   2.4.1  headSeed, headId, parties, contestationPeriod, depositPeriod, version, accumulatorHash, headAdaOverhead   (8)
 *
 * 2.4 made the deposit period an on-chain parameter fixed at Init, and it sits
 * between the contestation period and the version, shifting everything after
 * it by one. Both `ContestationPeriod` and `DepositPeriod` are newtypes over
 * milliseconds encoded as `Constr 0 [Integer]`.
 */
type HydraOpenDatumLayout = 'hydra-2.3' | 'hydra-2.4';

function validateOpenDatum(options: {
	datum: PlutusData;
	headId: string;
	expectedParties: string[];
	contestationPeriodMilliseconds: bigint;
	layout: HydraOpenDatumLayout;
	expectedDepositPeriodMilliseconds?: bigint;
}): bigint | null {
	const isHydra24 = options.layout === 'hydra-2.4';
	const stateFields = expectConstructor(options.datum, 0n, 1, 'Hydra head state');
	const openFields = expectConstructor(stateFields.get(0), 0n, isHydra24 ? 8 : 7, 'Hydra Open datum');
	// Field indices after the contestation period depend on the layout.
	const at = { version: isHydra24 ? 5 : 4, accumulatorHash: isHydra24 ? 6 : 5, adaOverhead: isHydra24 ? 7 : 6 };
	if (expectBytes(openFields.get(1), 28, 'Hydra Open head id').toString('hex') !== options.headId) {
		fail('Hydra Open datum head id did not match the indexed state token');
	}

	const parties = openFields.get(2).as_list();
	if (!parties || parties.len() !== options.expectedParties.length) {
		fail('Hydra Open datum party count did not match the configured head');
	}
	const actualParties = new Set<string>();
	for (let index = 0; index < parties.len(); index += 1) {
		actualParties.add(expectBytes(parties.get(index), 32, `Hydra Open party ${index}`).toString('hex'));
	}
	if (
		actualParties.size !== options.expectedParties.length ||
		options.expectedParties.some((party) => !actualParties.has(party))
	) {
		// Hydra uses its own canonical party ordering. Local/remote is a service
		// role distinction, not an order that can be imposed on the on-chain datum.
		fail('Hydra Open datum party set did not match the configured head');
	}

	const periodFields = expectConstructor(openFields.get(3), 0n, 1, 'Hydra contestation period');
	if (expectInteger(periodFields.get(0), 'Hydra contestation period') !== options.contestationPeriodMilliseconds) {
		fail('Hydra on-chain contestation period did not match the configured head');
	}
	let depositPeriodMilliseconds: bigint | null = null;
	if (isHydra24) {
		const depositFields = expectConstructor(openFields.get(4), 0n, 1, 'Hydra deposit period');
		depositPeriodMilliseconds = expectInteger(depositFields.get(0), 'Hydra deposit period');
		if (depositPeriodMilliseconds <= 0n) {
			fail('Hydra on-chain deposit period was not positive');
		}
		if (
			options.expectedDepositPeriodMilliseconds !== undefined &&
			depositPeriodMilliseconds !== options.expectedDepositPeriodMilliseconds
		) {
			fail('Hydra on-chain deposit period did not match the configured head');
		}
	}
	if (expectInteger(openFields.get(at.version), 'Hydra Open snapshot version') !== 0n) {
		fail('Hydra InitTx head output was not the initial Open state');
	}
	expectBytes(openFields.get(at.accumulatorHash), 32, 'Hydra Open accumulator hash');
	if (expectInteger(openFields.get(at.adaOverhead), 'Hydra Open ADA overhead') < 0n) {
		fail('Hydra Open ADA overhead was negative');
	}
	return depositPeriodMilliseconds;
}

function paymentScriptHash(addressText: string): string | null {
	try {
		return Address.from_bech32(addressText).payment_cred()?.to_scripthash()?.to_hex().toLowerCase() ?? null;
	} catch {
		return null;
	}
}

function expectConstructor(data: PlutusData, alternative: bigint, fields: number, label: string) {
	const constructor = data.as_constr_plutus_data();
	if (
		!constructor ||
		BigInt(constructor.alternative().to_str()) !== alternative ||
		constructor.data().len() !== fields
	) {
		fail(`${label} had an invalid constructor shape`);
	}
	return constructor.data();
}

function expectBytes(data: PlutusData, byteLength: number, label: string): Buffer {
	const bytes = data.as_bytes();
	if (!bytes || bytes.length !== byteLength) fail(`${label} was not ${byteLength} bytes`);
	return Buffer.from(bytes);
}

function expectInteger(data: PlutusData, label: string): bigint {
	const integer = data.as_integer();
	if (!integer) fail(`${label} was not an integer`);
	return BigInt(integer.to_str());
}

function parseQuantity(quantity: string): bigint {
	try {
		const parsed = BigInt(quantity);
		if (parsed < 0n) fail('Hydra InitTx output contained a negative state-token quantity');
		return parsed;
	} catch (error) {
		if (error instanceof HydraHeadInitValidationError) throw error;
		fail('Hydra InitTx output contained an invalid state-token quantity');
	}
}

function normalizeHex(value: string, length: number, label: string): string {
	if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value)) fail(`${label} was not canonical hexadecimal`);
	return value.toLowerCase();
}

function fail(message: string): never {
	throw new HydraHeadInitValidationError(message);
}
