import { Address, PlutusData } from '@emurgo/cardano-serialization-lib-nodejs';

import { hydraVerificationKeyRawHex } from './keys';

/** Hydra 2.3 `HydraHeadV2` state-token asset name. */
export const HYDRA_HEAD_V2_ASSET_NAME_HEX = '4879647261486561645632';

/** `vHead` hash from the Hydra 2.3 script catalogue used by this deployment. */
export const DEFAULT_HYDRA_HEAD_SCRIPT_HASH = '2b91a7e666575a2465b8c7f6a7f960d5870cf13694a67f3215e014c5';

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
	headScriptHash?: string;
	/** Bounds the complete independent observer pass; underlying requests may finish later. */
	observerTimeoutMs?: number;
}): Promise<{ initTxHash: string }> {
	const headId = normalizeHex(options.headId, 56, 'Hydra head id');
	const headScriptHash = resolveHydraHeadScriptHash(options.headScriptHash);
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
		return stateTokenQuantity === 1n && paymentScriptHash(output.address) === headScriptHash;
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
	validateOpenDatum({
		datum,
		headId,
		expectedParties,
		contestationPeriodMilliseconds: options.contestationPeriodSeconds * 1000n,
	});
	return { initTxHash };
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

function validateOpenDatum(options: {
	datum: PlutusData;
	headId: string;
	expectedParties: string[];
	contestationPeriodMilliseconds: bigint;
}): void {
	const stateFields = expectConstructor(options.datum, 0n, 1, 'Hydra head state');
	const openFields = expectConstructor(stateFields.get(0), 0n, 7, 'Hydra Open datum');
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
	if (expectInteger(openFields.get(4), 'Hydra Open snapshot version') !== 0n) {
		fail('Hydra InitTx head output was not the initial Open state');
	}
	expectBytes(openFields.get(5), 32, 'Hydra Open accumulator hash');
	if (expectInteger(openFields.get(6), 'Hydra Open ADA overhead') < 0n) {
		fail('Hydra Open ADA overhead was negative');
	}
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
