import {
	Address,
	BaseAddress,
	EnterpriseAddress,
	NetworkInfo,
	PlutusData,
	Transaction,
	type PlutusMap,
	type TransactionOutput,
	type Value,
} from '@emurgo/cardano-serialization-lib-nodejs';
import type { SlotConfig, UTxO } from '@meshsdk/core';
import { blake2b } from 'ethereum-cryptography/blake2b';
import { HydraTransactionType, type HydraTransaction } from './types';

/** Script hash from the Hydra script catalogue bundled with this deployment. */
export const DEFAULT_HYDRA_DEPOSIT_SCRIPT_HASH = 'c78e8c9205721eb3ef4410f3db9c6169fa6db497c24641d29c20529c';

const MAX_COMMIT_DRAFT_BYTES = 64 * 1024;
const DEFAULT_MAX_FEE_LOVELACE = 10_000_000n;
const DEFAULT_MAX_DEADLINE_FROM_NOW_MS = 24 * 60 * 60 * 1000;
const DEADLINE_CLOCK_SKEW_MS = 5 * 60 * 1000;

class HydraCommitDraftValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HydraCommitDraftValidationError';
	}
}

export type ValidateHydraCommitDraftOptions = {
	draft: HydraTransaction;
	commitUtxos: UTxO[];
	/** UTxOs deliberately left available for the node's L1 fee input. */
	fuelUtxos: UTxO[];
	/** Complete wallet view, used to reject any unapproved wallet input. */
	walletUtxos: UTxO[];
	expectedHeadId: string;
	depositScriptHash?: string;
	nowMs?: number;
	maxDeadlineFromNowMs?: number;
	maxFeeLovelace?: bigint;
	/** Slot timeline of the L1 chain on which the deposit transaction executes. */
	slotConfig: SlotConfig;
};

export type ValidatedHydraCommitDraft = {
	txId: string;
	deadlineMs: number;
	depositOutputIndex: number;
	invalidHereafterSlot: bigint;
};

/**
 * Validate every wallet-relevant part of an untrusted hydra-node `/commit`
 * response before asking the wallet to sign it.
 */
export function validateHydraCommitDraft({
	draft,
	commitUtxos,
	fuelUtxos,
	walletUtxos,
	expectedHeadId,
	depositScriptHash = DEFAULT_HYDRA_DEPOSIT_SCRIPT_HASH,
	nowMs = Date.now(),
	maxDeadlineFromNowMs = DEFAULT_MAX_DEADLINE_FROM_NOW_MS,
	maxFeeLovelace = DEFAULT_MAX_FEE_LOVELACE,
	slotConfig,
}: ValidateHydraCommitDraftOptions): ValidatedHydraCommitDraft {
	if (draft.type !== HydraTransactionType.TxConwayEra && draft.type !== HydraTransactionType.UnwitnessedTxConwayEra) {
		fail(`unexpected transaction type ${JSON.stringify(draft.type)}`);
	}
	if (!/^[0-9a-fA-F]{56}$/.test(expectedHeadId)) {
		fail('expected head identifier must be 28-byte hex');
	}
	if (!/^[0-9a-fA-F]{56}$/.test(depositScriptHash)) {
		fail('configured deposit script hash must be 28-byte hex');
	}
	if (commitUtxos.length === 0) {
		fail('at least one commit UTxO is required');
	}
	if (!Number.isFinite(nowMs) || !Number.isFinite(maxDeadlineFromNowMs) || maxDeadlineFromNowMs <= 0) {
		fail('invalid commit deadline validation bounds');
	}

	const cborHex = normalizeHex(draft.cborHex, 'commit transaction CBOR');
	if (cborHex.length / 2 > MAX_COMMIT_DRAFT_BYTES) {
		fail(`commit transaction exceeds ${MAX_COMMIT_DRAFT_BYTES} bytes`);
	}

	let transaction: Transaction;
	try {
		transaction = Transaction.from_hex(cborHex);
	} catch {
		fail('commit transaction CBOR is not a valid Cardano transaction');
	}
	if (!transaction.is_valid()) {
		fail('commit transaction is marked invalid');
	}

	const body = transaction.body();
	assertNoUnexpectedBodyFeatures(body);
	const txId = hashTransactionBody(transaction);
	if (draft.txId !== undefined && normalizeHash(draft.txId, 'advertised transaction id') !== txId) {
		fail('advertised transaction id does not match the transaction body');
	}

	const commitByReference = mapUtxosByReference(commitUtxos, 'commit');
	const fuelReferences = new Set(mapUtxosByReference(fuelUtxos, 'fuel').keys());
	const walletByReference = mapUtxosByReference(walletUtxos, 'wallet');
	const inputReferences = readInputReferences(body.inputs());

	for (const reference of commitByReference.keys()) {
		if (!inputReferences.includes(reference)) {
			fail(`transaction does not spend requested commit input ${reference}`);
		}
	}
	const extraInputs = inputReferences.filter((reference) => !commitByReference.has(reference));
	if (extraInputs.length !== 1) {
		fail(`transaction must contain exactly one L1 fee input; received ${extraInputs.length}`);
	}
	const extraInput = extraInputs[0];
	if (!fuelReferences.has(extraInput)) {
		fail(`transaction fee input ${extraInput} was not explicitly reserved`);
	}
	const fuelUtxo = walletByReference.get(extraInput);
	if (!fuelUtxo) {
		fail(`reserved fee input ${extraInput} is absent from the complete wallet view`);
	}

	const firstCommitAddress = parseAddress(commitUtxos[0].output.address, 'commit UTxO address');
	const networkId = firstCommitAddress.network_id();
	for (const utxo of commitUtxos) {
		const address = parseAddress(utxo.output.address, `commit UTxO ${utxoReference(utxo)} address`);
		if (address.network_id() !== networkId) {
			fail('commit UTxOs span multiple Cardano networks');
		}
		if (utxo.output.plutusData != null || utxo.output.dataHash != null || utxo.output.scriptRef != null) {
			fail(`commit UTxO ${utxoReference(utxo)} is not a plain output`);
		}
	}
	const bodyNetworkId = body.network_id();
	if (bodyNetworkId !== undefined && Number(bodyNetworkId.kind()) !== networkId) {
		fail('transaction network id does not match the committed outputs');
	}

	const outputs = body.outputs();
	if (outputs.len() !== 2) {
		fail(`transaction must contain exactly one deposit output and one fee change output; received ${outputs.len()}`);
	}
	const matchingDepositOutputs: number[] = [];
	for (let index = 0; index < outputs.len(); index += 1) {
		const output = outputs.get(index);
		const paymentCredential = output.address().payment_cred();
		if (paymentCredential?.to_scripthash()?.to_hex().toLowerCase() === depositScriptHash.toLowerCase()) {
			matchingDepositOutputs.push(index);
		}
	}
	if (matchingDepositOutputs.length !== 1) {
		fail(`transaction must contain exactly one output at the trusted Hydra deposit script`);
	}

	const depositOutputIndex = matchingDepositOutputs[0];
	const depositOutput = outputs.get(depositOutputIndex);
	if (!EnterpriseAddress.from_address(depositOutput.address())) {
		fail('deposit output must use the trusted enterprise script address shape');
	}
	if (depositOutput.address().network_id() !== networkId) {
		fail('deposit output is on the wrong Cardano network');
	}
	if (depositOutput.data_hash() !== undefined || depositOutput.script_ref() !== undefined) {
		fail('deposit output must use only an inline datum and no reference script');
	}
	const expectedDepositValue = normalizeMeshAmounts(commitUtxos.flatMap((utxo) => utxo.output.amount));
	assertValueMapEquals(normalizeCardanoValue(depositOutput.amount()), expectedDepositValue, 'deposit output value');
	const changeOutputIndex = depositOutputIndex === 0 ? 1 : 0;
	const changeOutput = outputs.get(changeOutputIndex);
	assertSafeFuelChangeOutput(changeOutput, fuelUtxo);

	const fee = BigInt(body.fee().to_str());
	if (fee > maxFeeLovelace) {
		fail(`commit transaction fee ${fee.toString()} exceeds the ${maxFeeLovelace.toString()} lovelace limit`);
	}
	const totalInputValue = normalizeMeshAmounts([...commitUtxos, fuelUtxo].flatMap((utxo) => utxo.output.amount));
	const totalOutputValue = sumValueMaps(
		Array.from({ length: outputs.len() }, (_, index) => normalizeCardanoValue(outputs.get(index).amount())),
	);
	totalOutputValue.set('lovelace', (totalOutputValue.get('lovelace') ?? 0n) + fee);
	assertValueMapEquals(totalOutputValue, totalInputValue, 'transaction input/output value balance');

	const inlineDatum = depositOutput.plutus_data();
	if (!inlineDatum) {
		fail('deposit output is missing its inline datum');
	}
	const deadlineMs = validateDepositDatum({
		datum: inlineDatum,
		expectedHeadId: expectedHeadId.toLowerCase(),
		commitByReference,
		networkId,
		nowMs,
		maxDeadlineFromNowMs,
	});

	const ttl = body.ttl_bignum();
	if (!ttl) {
		fail('commit transaction has no upper validity bound');
	}
	const invalidHereafterSlot = validateCommitValidityUpperBound(ttl.to_str(), deadlineMs, nowMs, slotConfig);
	return { txId, deadlineMs, depositOutputIndex, invalidHereafterSlot };
}

/** Ensure wallet signing only added witnesses and did not replace the body. */
export function assertHydraCommitSignedBody(signedCborHex: string, expectedTxId: string): void {
	const cborHex = normalizeHex(signedCborHex, 'signed commit transaction CBOR');
	let transaction: Transaction;
	try {
		transaction = Transaction.from_hex(cborHex);
	} catch {
		fail('signed commit transaction CBOR is not a valid Cardano transaction');
	}
	if (hashTransactionBody(transaction) !== normalizeHash(expectedTxId, 'expected transaction id')) {
		fail('wallet signing changed the validated commit transaction body');
	}
}

export function resolveHydraDepositScriptHash(configuredHash = process.env.HYDRA_DEPOSIT_SCRIPT_HASH): string {
	const scriptHash = configuredHash?.trim() || DEFAULT_HYDRA_DEPOSIT_SCRIPT_HASH;
	return normalizeHash(scriptHash, 'Hydra deposit script hash', 56);
}

function validateDepositDatum({
	datum,
	expectedHeadId,
	commitByReference,
	networkId,
	nowMs,
	maxDeadlineFromNowMs,
}: {
	datum: PlutusData;
	expectedHeadId: string;
	commitByReference: Map<string, UTxO>;
	networkId: number;
	nowMs: number;
	maxDeadlineFromNowMs: number;
}): number {
	const fields = expectConstructor(datum, 0n, 3, 'deposit datum');
	const headId = expectBytes(fields.get(0), 28, 'deposit datum head id').toString('hex');
	if (headId !== expectedHeadId) {
		fail('deposit datum head id does not match the connected head');
	}

	const deadline = expectInteger(fields.get(1), 'deposit datum deadline');
	if (deadline > BigInt(Number.MAX_SAFE_INTEGER)) {
		fail('deposit datum deadline exceeds the safe timestamp range');
	}
	const deadlineMs = Number(deadline);
	if (deadlineMs < nowMs - DEADLINE_CLOCK_SKEW_MS || deadlineMs > nowMs + maxDeadlineFromNowMs) {
		fail('deposit datum deadline is expired or unreasonably far in the future');
	}

	const commits = fields.get(2).as_list();
	if (!commits || commits.len() !== commitByReference.size) {
		fail('deposit datum does not contain exactly the requested commits');
	}
	const seen = new Set<string>();
	for (let index = 0; index < commits.len(); index += 1) {
		const commitFields = expectConstructor(commits.get(index), 0n, 2, `deposit commit ${index}`);
		const referenceFields = expectConstructor(commitFields.get(0), 0n, 2, `deposit commit ${index} reference`);
		const txHash = expectBytes(referenceFields.get(0), 32, `deposit commit ${index} transaction hash`).toString('hex');
		const outputIndex = expectInteger(referenceFields.get(1), `deposit commit ${index} output index`);
		if (outputIndex < 0n || outputIndex > 0xffff_ffffn) {
			fail(`deposit commit ${index} has an invalid output index`);
		}
		const reference = `${txHash}#${outputIndex.toString()}`;
		const expectedUtxo = commitByReference.get(reference);
		if (!expectedUtxo || seen.has(reference)) {
			fail(`deposit datum contains an unexpected or duplicate input ${reference}`);
		}
		seen.add(reference);

		const serializedOutput = expectBytes(commitFields.get(1), undefined, `deposit commit ${index} serialized output`);
		validateSerializedCommitOutput(serializedOutput, expectedUtxo, networkId, index);
	}
	return deadlineMs;
}

function validateSerializedCommitOutput(bytes: Buffer, expectedUtxo: UTxO, networkId: number, index: number): void {
	let outputData: PlutusData;
	try {
		outputData = PlutusData.from_bytes(bytes);
	} catch {
		fail(`deposit commit ${index} contains invalid serialized output data`);
	}
	const outputFields = expectConstructor(outputData, 0n, 4, `deposit commit ${index} serialized output`);

	let serializedAddress: Address;
	try {
		serializedAddress = outputFields.get(0).as_address(NetworkInfo.new(networkId, 0));
	} catch {
		fail(`deposit commit ${index} contains an invalid address`);
	}
	const expectedAddress = parseAddress(
		expectedUtxo.output.address,
		`commit UTxO ${utxoReference(expectedUtxo)} address`,
	);
	if (serializedAddress.to_hex() !== expectedAddress.to_hex()) {
		fail(`deposit commit ${index} changes the committed output address`);
	}

	const serializedValue = normalizePlutusValue(outputFields.get(1), `deposit commit ${index} value`);
	const expectedValue = normalizeMeshAmounts(expectedUtxo.output.amount);
	assertValueMapEquals(serializedValue, expectedValue, `deposit commit ${index} value`);
	expectConstructor(outputFields.get(2), 0n, 0, `deposit commit ${index} output datum`);
	expectConstructor(outputFields.get(3), 1n, 0, `deposit commit ${index} reference script`);
}

function assertNoUnexpectedBodyFeatures(body: ReturnType<Transaction['body']>): void {
	const unexpectedFeatures: Array<[string, unknown]> = [
		['certificates', body.certs()],
		['withdrawals', body.withdrawals()],
		['protocol update', body.update()],
		['validity start', body.validity_start_interval_bignum()],
		['mint', body.mint()],
		['reference inputs', body.reference_inputs()],
		['script data hash', body.script_data_hash()],
		['collateral', body.collateral()],
		['collateral return', body.collateral_return()],
		['total collateral', body.total_collateral()],
		['voting procedures', body.voting_procedures()],
		['voting proposals', body.voting_proposals()],
		['treasury donation', body.donation()],
		['current treasury value', body.current_treasury_value()],
	];
	const unexpected = unexpectedFeatures.find(([, value]) => value !== undefined);
	if (unexpected) {
		fail(`commit transaction contains unexpected ${unexpected[0]}`);
	}
}

function validateCommitValidityUpperBound(
	ttlValue: string,
	depositDeadlineMs: number,
	nowMs: number,
	slotConfig: SlotConfig,
): bigint {
	if (
		!Number.isSafeInteger(slotConfig.zeroTime) ||
		slotConfig.zeroTime < 0 ||
		!Number.isSafeInteger(slotConfig.zeroSlot) ||
		slotConfig.zeroSlot < 0 ||
		!Number.isSafeInteger(slotConfig.slotLength) ||
		slotConfig.slotLength <= 0
	) {
		fail('invalid L1 slot configuration for commit validation');
	}
	const ttl = BigInt(ttlValue);
	if (ttl < 0n || ttl > BigInt(Number.MAX_SAFE_INTEGER)) {
		fail('commit transaction upper validity slot is outside the safe range');
	}
	const ttlSlot = Number(ttl);
	const ttlStartMs = (ttlSlot - slotConfig.zeroSlot) * slotConfig.slotLength + slotConfig.zeroTime;
	const ttlEndMs = ttlStartMs + slotConfig.slotLength;
	if (!Number.isSafeInteger(ttlStartMs) || !Number.isSafeInteger(ttlEndMs)) {
		fail('commit transaction upper validity time is outside the safe range');
	}
	if (ttlEndMs < nowMs - DEADLINE_CLOCK_SKEW_MS || ttlStartMs > nowMs + DEADLINE_CLOCK_SKEW_MS) {
		fail('commit transaction upper validity bound is stale or unreasonably far in the future');
	}
	// Hydra records the deposit's creation time from this upper validity slot.
	// It must precede the recovery deadline embedded in the deposit datum.
	if (ttlStartMs >= depositDeadlineMs) {
		fail('commit transaction upper validity bound does not precede the deposit deadline');
	}
	return ttl;
}

function normalizeCardanoValue(value: Value): Map<string, bigint> {
	const result = new Map<string, bigint>([['lovelace', BigInt(value.coin().to_str())]]);
	const multiAsset = value.multiasset();
	if (!multiAsset) return result;
	const policies = multiAsset.keys();
	for (let policyIndex = 0; policyIndex < policies.len(); policyIndex += 1) {
		const policy = policies.get(policyIndex);
		const assets = multiAsset.get(policy);
		if (!assets) fail('transaction value contains a missing asset map');
		const names = assets.keys();
		for (let nameIndex = 0; nameIndex < names.len(); nameIndex += 1) {
			const name = names.get(nameIndex);
			const quantity = assets.get(name);
			if (!quantity) fail('transaction value contains a missing asset quantity');
			result.set(`${policy.to_hex()}${name.to_hex()}`.toLowerCase(), BigInt(quantity.to_str()));
		}
	}
	return result;
}

function assertSafeFuelChangeOutput(output: TransactionOutput, fuelUtxo: UTxO): void {
	if (output.data_hash() !== undefined || output.plutus_data() !== undefined || output.script_ref() !== undefined) {
		fail('fee change output must be a plain public-key output');
	}
	const fuelAddress = parseAddress(fuelUtxo.output.address, `fuel UTxO ${utxoReference(fuelUtxo)} address`);
	const fuelPaymentKey = fuelAddress.payment_cred()?.to_keyhash()?.to_hex();
	const changePaymentKey = output.address().payment_cred()?.to_keyhash()?.to_hex();
	const fuelBaseAddress = BaseAddress.from_address(fuelAddress);
	const fuelEnterpriseAddress = EnterpriseAddress.from_address(fuelAddress);
	const changeBaseAddress = BaseAddress.from_address(output.address());
	const changeEnterpriseAddress = EnterpriseAddress.from_address(output.address());
	if (
		!fuelPaymentKey ||
		changePaymentKey !== fuelPaymentKey ||
		output.address().network_id() !== fuelAddress.network_id() ||
		(!fuelBaseAddress && !fuelEnterpriseAddress) ||
		(!changeBaseAddress && !changeEnterpriseAddress) ||
		(changeBaseAddress != null &&
			(fuelBaseAddress == null || changeBaseAddress.stake_cred().to_hex() !== fuelBaseAddress.stake_cred().to_hex()))
	) {
		fail('fee change output does not return control to the reserved fuel wallet');
	}
}

function sumValueMaps(values: Array<Map<string, bigint>>): Map<string, bigint> {
	const result = new Map<string, bigint>();
	for (const value of values) {
		for (const [unit, quantity] of value) {
			result.set(unit, (result.get(unit) ?? 0n) + quantity);
		}
	}
	return result;
}

function normalizePlutusValue(data: PlutusData, label: string): Map<string, bigint> {
	const outerMap = data.as_map();
	if (!outerMap) fail(`${label} is not a Plutus value map`);
	const result = new Map<string, bigint>();
	forEachPlutusMapEntry(outerMap, label, (policyData, tokenMapData) => {
		const policy = expectBytes(policyData, undefined, `${label} policy id`).toString('hex');
		if (policy.length !== 0 && policy.length !== 56) fail(`${label} contains an invalid policy id`);
		const tokenMap = tokenMapData.as_map();
		if (!tokenMap) fail(`${label} policy entry is not a token map`);
		forEachPlutusMapEntry(tokenMap, label, (tokenData, quantityData) => {
			const tokenName = expectBytes(tokenData, undefined, `${label} token name`).toString('hex');
			if (tokenName.length > 64) fail(`${label} contains an oversized token name`);
			const quantity = expectInteger(quantityData, `${label} quantity`);
			if (quantity < 0n) fail(`${label} contains a negative quantity`);
			const unit = policy.length === 0 && tokenName.length === 0 ? 'lovelace' : `${policy}${tokenName}`;
			if (result.has(unit)) fail(`${label} contains duplicate asset ${unit}`);
			result.set(unit, quantity);
		});
	});
	return result;
}

function forEachPlutusMapEntry(
	map: PlutusMap,
	label: string,
	callback: (key: PlutusData, value: PlutusData) => void,
): void {
	const keys = map.keys();
	for (let index = 0; index < keys.len(); index += 1) {
		const key = keys.get(index);
		const values = map.get(key);
		if (!values || values.len() !== 1) fail(`${label} contains a duplicate or missing map value`);
		const value = values.get(0);
		if (!value) fail(`${label} contains a missing map value`);
		callback(key, value);
	}
}

function normalizeMeshAmounts(amounts: UTxO['output']['amount']): Map<string, bigint> {
	const result = new Map<string, bigint>();
	for (const amount of amounts) {
		const unit = amount.unit.toLowerCase();
		if (unit !== 'lovelace' && !/^[0-9a-f]{56,120}$/.test(unit)) {
			fail(`wallet UTxO contains invalid asset unit ${JSON.stringify(amount.unit)}`);
		}
		let quantity: bigint;
		try {
			quantity = BigInt(amount.quantity);
		} catch {
			fail(`wallet UTxO contains invalid quantity ${JSON.stringify(amount.quantity)}`);
		}
		if (quantity < 0n) fail('wallet UTxO contains a negative quantity');
		result.set(unit, (result.get(unit) ?? 0n) + quantity);
	}
	return result;
}

function assertValueMapEquals(actual: Map<string, bigint>, expected: Map<string, bigint>, label: string): void {
	const withoutZeroes = (value: Map<string, bigint>) =>
		new Map([...value.entries()].filter(([, quantity]) => quantity !== 0n));
	const normalizedActual = withoutZeroes(actual);
	const normalizedExpected = withoutZeroes(expected);
	if (
		normalizedActual.size !== normalizedExpected.size ||
		[...normalizedExpected].some(([unit, quantity]) => normalizedActual.get(unit) !== quantity)
	) {
		fail(`${label} does not exactly match the expected value`);
	}
}

function expectConstructor(data: PlutusData, alternative: bigint, fieldCount: number, label: string) {
	const constructor = data.as_constr_plutus_data();
	if (
		!constructor ||
		BigInt(constructor.alternative().to_str()) !== alternative ||
		constructor.data().len() !== fieldCount
	) {
		fail(`${label} has an invalid constructor shape`);
	}
	return constructor.data();
}

function expectBytes(data: PlutusData, byteLength: number | undefined, label: string): Buffer {
	const bytes = data.as_bytes();
	if (!bytes || (byteLength !== undefined && bytes.length !== byteLength)) {
		fail(`${label} is not ${byteLength === undefined ? 'bytes' : `${byteLength} bytes`}`);
	}
	return Buffer.from(bytes);
}

function expectInteger(data: PlutusData, label: string): bigint {
	const integer = data.as_integer();
	if (!integer) fail(`${label} is not an integer`);
	return BigInt(integer.to_str());
}

function readInputReferences(inputs: ReturnType<ReturnType<Transaction['body']>['inputs']>): string[] {
	const references: string[] = [];
	for (let index = 0; index < inputs.len(); index += 1) {
		const input = inputs.get(index);
		references.push(`${input.transaction_id().to_hex().toLowerCase()}#${input.index()}`);
	}
	return references;
}

function mapUtxosByReference(utxos: UTxO[], label: string): Map<string, UTxO> {
	const result = new Map<string, UTxO>();
	for (const utxo of utxos) {
		const reference = utxoReference(utxo);
		if (result.has(reference)) fail(`${label} UTxO list contains duplicate ${reference}`);
		result.set(reference, utxo);
	}
	return result;
}

function utxoReference(utxo: UTxO): string {
	return `${normalizeHash(utxo.input.txHash, 'wallet UTxO transaction hash')}#${utxo.input.outputIndex}`;
}

function parseAddress(address: string, label: string): Address {
	try {
		return Address.from_bech32(address);
	} catch {
		fail(`${label} is not a valid Cardano address`);
	}
}

function hashTransactionBody(transaction: Transaction): string {
	return Buffer.from(blake2b(transaction.body().to_bytes(), 32)).toString('hex');
}

function normalizeHex(value: string, label: string): string {
	if (typeof value !== 'string' || value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) {
		fail(`${label} must be non-empty, even-length hex`);
	}
	return value.toLowerCase();
}

function normalizeHash(value: string, label: string, length = 64): string {
	if (typeof value !== 'string' || !new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value)) {
		fail(`${label} must be ${length / 2}-byte hex`);
	}
	return value.toLowerCase();
}

function fail(message: string): never {
	throw new HydraCommitDraftValidationError(message);
}
