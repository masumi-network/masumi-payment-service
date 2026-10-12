import { Address } from '@emurgo/cardano-serialization-lib-nodejs';
import type { UTxO } from '@meshsdk/core';

/**
 * Resolve a spent input reference to its on-chain output, or null when the
 * output cannot be found. Injected so the decision logic stays pure and
 * unit-testable without an L1 provider.
 */
export type ResolveInputOutput = (txHash: string, index: number) => Promise<UTxO['output'] | null>;

/** Raised when a commit draft fails the key-scoped wallet-input safety check. */
export class HydraCommitInputSafetyError extends Error {
	constructor(
		message: string,
		/** `wallet-owned` = definitive unsafe draft; `unresolved` = fail-closed. */
		readonly reason: 'wallet-owned' | 'unresolved',
	) {
		super(message);
		this.name = 'HydraCommitInputSafetyError';
	}
}

function inputReference(txHash: string, index: number): string {
	return `${txHash.toLowerCase()}#${index}`;
}

/**
 * Authoritative, key-scoped guarantee that a commit draft spends NO wallet-owned
 * input beyond the requested commit UTxOs.
 *
 * A Cardano vkey witness signs EVERY input under the wallet's payment key hash —
 * not only the UTxOs in a fetched snapshot — so membership in a local wallet
 * view is not sufficient. Each non-committed input (regular and collateral) is
 * resolved on-chain and rejected if it is spendable by this wallet key.
 * Otherwise an untrusted hydra-node could reference an off-snapshot wallet UTxO
 * (an enterprise-address variant, or one that arrived after the snapshot) and
 * siphon it into its own change output. Unresolvable inputs fail closed.
 */
export async function assertCommitDraftInputsAreNodeFunded(params: {
	inputReferences: string[];
	collateralReferences: string[];
	commitReferences: Iterable<string>;
	walletPaymentKeyHash: string;
	resolveOutput: ResolveInputOutput;
	paymentKeyHashOf: (address: string) => string;
	/**
	 * Refuse non-committed inputs at any script. Set for a script commit: the
	 * draft then runs scripts, and a script that trusts the signer's key (a
	 * second smart wallet of the same owner) would spend under its witness.
	 */
	refuseScriptInputs?: boolean;
}): Promise<void> {
	const {
		inputReferences,
		collateralReferences,
		commitReferences,
		walletPaymentKeyHash,
		resolveOutput,
		paymentKeyHashOf,
	} = params;
	const commitSet = new Set([...commitReferences].map((reference) => reference.toLowerCase()));
	const walletKeyHash = walletPaymentKeyHash.toLowerCase();
	const nonCommitReferences = [
		...new Set([...inputReferences, ...collateralReferences].map((r) => r.toLowerCase())),
	].filter((reference) => !commitSet.has(reference));

	for (const reference of nonCommitReferences) {
		const [txHash, indexRaw] = reference.split('#');
		const index = Number(indexRaw);
		let output: UTxO['output'] | null;
		try {
			output = await resolveOutput(txHash, index);
		} catch (error) {
			throw new HydraCommitInputSafetyError(
				`funding input ${reference} could not be resolved on L1: ${error instanceof Error ? error.message : String(error)}`,
				'unresolved',
			);
		}
		if (!output) {
			throw new HydraCommitInputSafetyError(`funding input ${reference} could not be resolved on L1`, 'unresolved');
		}
		if (params.refuseScriptInputs === true && isScriptAddress(output.address)) {
			throw new HydraCommitInputSafetyError(
				`non-committed input ${reference} sits at a script; a script commit spends only its committed UTxO`,
				'wallet-owned',
			);
		}
		if (paymentKeyHashOf(output.address).toLowerCase() === walletKeyHash) {
			throw new HydraCommitInputSafetyError(
				`non-committed input ${reference} is owned by this wallet; the wallet must sign only its committed UTxOs`,
				'wallet-owned',
			);
		}
	}
}

function isScriptAddress(bech32: string): boolean {
	return Address.from_bech32(bech32).payment_cred()?.to_scripthash() != null;
}

export { inputReference };
