import { Transaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { resolveTxHash } from '@meshsdk/core';
import { knownHydraHeadScriptHashes } from './head-init-validation';
import {
	expectedHeadUnits,
	boundHeadInputs,
	hasExactTokenSet,
	headPolicyAmounts,
	HydraFanoutValidationError,
	mintPolicyAmounts,
	paymentScriptHash,
	serializeCardanoOutputAmounts,
	type HydraFanoutChainObserver,
} from './fanout-validation';

const ORIGIN_OBSERVER_TIMEOUT_MS = 15_000;

type FanoutOutputOrigin = {
	observer: HydraFanoutChainObserver;
	headId: string;
	participantVkeys: readonly string[];
	producerTxHash: string;
	outputIndex: number;
	contractAddress: string;
	indexedAmounts: ReadonlyArray<{ unit: string; quantity: string }>;
};

function sameAmounts(
	left: ReadonlyArray<{ unit: string; quantity: string }>,
	right: ReadonlyArray<{ unit: string; quantity: string }>,
): boolean {
	const normalize = (amounts: ReadonlyArray<{ unit: string; quantity: string }>) =>
		amounts.map(({ unit, quantity }) => `${unit.toLowerCase()}:${BigInt(quantity)}`).sort();
	const a = normalize(left);
	const b = normalize(right);
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * A confirmed spend may wait for handoff only when its input came from a step
 * that spent this head's official state token. An arbitrary matching datum is
 * not enough: it could otherwise block the whole payment-source queue.
 */
export async function isBoundFanoutOutputOrigin(options: FanoutOutputOrigin): Promise<boolean> {
	const { observer, headId, participantVkeys, producerTxHash, outputIndex, contractAddress, indexedAmounts } = options;
	if (
		!/^[0-9a-f]{56}$/i.test(headId) ||
		participantVkeys.length !== 2 ||
		participantVkeys.some((vkey) => !/^[0-9a-f]{56}$/i.test(vkey)) ||
		!/^[0-9a-f]{64}$/i.test(producerTxHash) ||
		!Number.isSafeInteger(outputIndex) ||
		outputIndex < 0
	) {
		throw new HydraFanoutValidationError('Hydra fanout origin received invalid head or output identity');
	}
	const normalizedHash = producerTxHash.toLowerCase();
	const normalizedHeadId = headId.toLowerCase();
	const expectedUnits = expectedHeadUnits(
		normalizedHeadId,
		participantVkeys.map((vkey) => vkey.toLowerCase()),
	);
	const scriptHashes = knownHydraHeadScriptHashes();
	const inspection = Promise.all([
		observer.txs(normalizedHash),
		observer.txsCbor(normalizedHash),
		observer.txsUtxos(normalizedHash),
	]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const [details, cborResponse, utxos] = await Promise.race([
		inspection,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() => reject(new HydraFanoutValidationError('Hydra fanout origin observer timed out')),
				ORIGIN_OBSERVER_TIMEOUT_MS,
			);
			timer.unref?.();
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
	if (
		details.hash.toLowerCase() !== normalizedHash ||
		utxos.hash.toLowerCase() !== normalizedHash ||
		details.valid_contract !== true
	) {
		throw new HydraFanoutValidationError('Hydra fanout origin transaction identity or validity was not confirmed');
	}
	let transaction: Transaction;
	try {
		transaction = Transaction.from_bytes(Buffer.from(cborResponse.cbor, 'hex'));
	} catch {
		throw new HydraFanoutValidationError('Hydra fanout origin CBOR was invalid');
	}
	if (!transaction.is_valid() || String(resolveTxHash(cborResponse.cbor)).toLowerCase() !== normalizedHash) {
		throw new HydraFanoutValidationError('Hydra fanout origin CBOR did not match its indexed transaction');
	}

	const headInputs = boundHeadInputs(utxos.inputs, normalizedHeadId, expectedUnits, scriptHashes);
	if (headInputs.length === 0) return false;
	if (headInputs.length !== 1) {
		throw new HydraFanoutValidationError('Hydra fanout origin reported multiple bound head inputs');
	}
	const headInput = headInputs[0];
	const body = transaction.body();
	const inputs = body.inputs();
	let hasHeadInput = false;
	for (let index = 0; index < inputs.len(); index += 1) {
		const input = inputs.get(index);
		if (
			input.transaction_id().to_hex().toLowerCase() === headInput.tx_hash.toLowerCase() &&
			input.index() === headInput.output_index
		) {
			hasHeadInput = true;
			break;
		}
	}
	if (!hasHeadInput) throw new HydraFanoutValidationError('Hydra fanout origin CBOR omitted the indexed head input');

	const mint = mintPolicyAmounts(transaction, normalizedHeadId);
	const isTerminal = hasExactTokenSet(mint, expectedUnits, -1n);
	if (!isTerminal && mint.size !== 0) return false;
	const outputs = body.outputs();
	const firstDistributedIndex = isTerminal ? 0 : 1;
	if (outputIndex < firstDistributedIndex || outputIndex >= outputs.len()) return false;
	if (!isTerminal) {
		const continuing = outputs.get(0);
		if (
			!scriptHashes.has(paymentScriptHash(continuing.address().to_bech32()) ?? '') ||
			!hasExactTokenSet(
				headPolicyAmounts(serializeCardanoOutputAmounts(continuing), normalizedHeadId),
				expectedUnits,
				1n,
			)
		)
			return false;
	}
	const output = outputs.get(outputIndex);
	return (
		output.address().to_bech32() === contractAddress &&
		sameAmounts(serializeCardanoOutputAmounts(output), indexedAmounts)
	);
}
