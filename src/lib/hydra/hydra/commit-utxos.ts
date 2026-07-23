import type { UTxO } from '@meshsdk/core';

export type CommitUtxoSelection = {
	commitUtxos: UTxO[];
	excludedUtxos: UTxO[];
};

/**
 * Hydra's commit codec cannot faithfully carry datum or reference-script
 * outputs from Mesh, so only plain pubkey outputs may enter a commit draft.
 */
export function isPlainCommitUtxo(utxo: UTxO): boolean {
	return utxo.output.plutusData == null && utxo.output.dataHash == null && utxo.output.scriptRef == null;
}

/**
 * Decoupled node-key model: the hydra-node funds L1 fees, collateral and change
 * from its OWN dedicated Cardano signing key — deliberately NOT this
 * participant's funding wallet. No wallet fuel input therefore needs to be
 * reserved, and every plain (datum- and reference-script-free) wallet UTxO may
 * be committed into the head.
 */
export function selectCommitUtxos(utxos: UTxO[]): CommitUtxoSelection {
	return {
		commitUtxos: utxos.filter(isPlainCommitUtxo),
		excludedUtxos: utxos.filter((utxo) => !isPlainCommitUtxo(utxo)),
	};
}
