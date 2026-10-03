import type { SlotConfig, UTxO } from '@meshsdk/core';
import type { HydraTransaction } from './types';
import {
	assertHydraCommitSignedBody,
	readHydraCommitDraftInputReferences,
	resolveHydraDepositScriptHash,
	validateHydraCommitDraft,
} from './commit-draft-validation';
import { assertCommitDraftInputsAreNodeFunded, HydraCommitInputSafetyError } from './commit-input-safety';

/**
 * Raised for any failure while building or validating an untrusted hydra-node
 * commit draft. Route handlers map this to a 502 (the draft came from the node,
 * not the client). Keeps http-errors out of the shared library.
 */
export class HydraCommitFlowError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HydraCommitFlowError';
	}
}

export type HydraCommitFlowDeps = {
	/** Ask the hydra-node to draft an unsigned commit spending these UTxOs. */
	requestCommitDraft: (commitUtxos: UTxO[]) => Promise<HydraTransaction | undefined>;
	/** Partially sign the draft (witness-only). */
	signTx: (cborHex: string, partialSign: boolean) => Promise<string>;
	/** Resolve a spent input reference to its on-chain output (null if unknown). */
	resolveInputOutput: (txHash: string, index: number) => Promise<UTxO['output'] | null>;
	/** Payment key hash of a bech32/hex address (mesh resolvePaymentKeyHash). */
	paymentKeyHashOf: (address: string) => string;
};

export type ValidatedHydraCommit = {
	signedCommitTx: string;
	txId: string;
	invalidHereafterSlot: bigint;
	deadlineMs: number;
	depositOutputIndex: number;
	committedValue: Map<string, bigint>;
};

function utxoReference(utxo: UTxO): string {
	return `${utxo.input.txHash}#${utxo.input.outputIndex}`;
}

function sumCommittedValue(commitUtxos: UTxO[]): Map<string, bigint> {
	const totals = new Map<string, bigint>();
	for (const utxo of commitUtxos) {
		for (const asset of utxo.output.amount) {
			totals.set(asset.unit, (totals.get(asset.unit) ?? 0n) + BigInt(asset.quantity));
		}
	}
	return totals;
}

/**
 * Shared, safety-critical path for both the initial commit and repeatable
 * top-ups: draft the commit with the hydra-node, enforce key-scoped wallet-input
 * safety against an untrusted draft, validate every wallet-relevant field, then
 * partially sign and confirm signing only added witnesses. Returns the signed
 * transaction plus its verified identity; the caller owns L1 submission and
 * reconciliation. Throws HydraCommitFlowError on any rejection.
 */
export async function buildValidatedHydraCommit(params: {
	commitUtxos: UTxO[];
	walletUtxos: UTxO[];
	walletPaymentKeyHash: string;
	expectedHeadId: string;
	slotConfig: SlotConfig;
	deps: HydraCommitFlowDeps;
}): Promise<ValidatedHydraCommit> {
	const { commitUtxos, walletUtxos, walletPaymentKeyHash, expectedHeadId, slotConfig, deps } = params;

	const draft = await deps.requestCommitDraft(commitUtxos);
	if (!draft?.cborHex) {
		throw new HydraCommitFlowError('Hydra node did not return a valid commit transaction draft');
	}

	// Authoritative, key-scoped wallet-input safety against the untrusted draft.
	try {
		const { inputs, collateral } = readHydraCommitDraftInputReferences(draft.cborHex);
		await assertCommitDraftInputsAreNodeFunded({
			inputReferences: inputs,
			collateralReferences: collateral,
			commitReferences: commitUtxos.map(utxoReference),
			walletPaymentKeyHash,
			resolveOutput: deps.resolveInputOutput,
			paymentKeyHashOf: deps.paymentKeyHashOf,
		});
	} catch (error) {
		if (error instanceof HydraCommitInputSafetyError) {
			throw new HydraCommitFlowError(`unsafe commit draft: ${error.message}`);
		}
		throw new HydraCommitFlowError(
			`could not verify funding-input ownership: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	let validated: ReturnType<typeof validateHydraCommitDraft>;
	try {
		validated = validateHydraCommitDraft({
			draft,
			commitUtxos,
			walletUtxos,
			expectedHeadId,
			depositScriptHash: resolveHydraDepositScriptHash(),
			slotConfig,
		});
	} catch (error) {
		throw new HydraCommitFlowError(`unsafe commit draft: ${error instanceof Error ? error.message : String(error)}`);
	}

	// Partial sign (the draft may already carry node witnesses) and confirm the
	// wallet added only witnesses without altering the validated body.
	const signedCommitTx = await deps.signTx(draft.cborHex, true);
	assertHydraCommitSignedBody(signedCommitTx, validated.txId);

	return {
		signedCommitTx,
		txId: validated.txId,
		invalidHereafterSlot: validated.invalidHereafterSlot,
		deadlineMs: validated.deadlineMs,
		depositOutputIndex: validated.depositOutputIndex,
		committedValue: sumCommittedValue(commitUtxos),
	};
}
