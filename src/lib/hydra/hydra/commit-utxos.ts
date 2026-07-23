import type { UTxO } from '@meshsdk/core';

export type CommitUtxoSelection = {
	commitUtxos: UTxO[];
	fuelUtxos: UTxO[];
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
 * The bundled hydra-node uses the participant key as its L1 fee wallet and
 * selects that wallet's largest UTxO as fuel. Never include an equally large
 * input in the commit: ties make the node's choice ambiguous and can produce
 * NotEnoughFuel when it selects an input the deposit already spends.
 */
export function selectCommitUtxosWithFuelReserve(utxos: UTxO[]): CommitUtxoSelection {
	const plainUtxos = utxos.filter(isPlainCommitUtxo);
	const excludedUtxos = utxos.filter((utxo) => !isPlainCommitUtxo(utxo));

	if (plainUtxos.length === 0) {
		return { commitUtxos: [], fuelUtxos: [], excludedUtxos };
	}

	const largestLovelace = plainUtxos.reduce((largest, utxo) => {
		const lovelace = getLovelace(utxo);
		return lovelace > largest ? lovelace : largest;
	}, 0n);

	return {
		commitUtxos: plainUtxos.filter((utxo) => getLovelace(utxo) < largestLovelace),
		fuelUtxos: plainUtxos.filter((utxo) => getLovelace(utxo) === largestLovelace),
		excludedUtxos,
	};
}

function getLovelace(utxo: UTxO): bigint {
	const quantity = utxo.output.amount.find((asset) => asset.unit === 'lovelace')?.quantity ?? '0';
	try {
		return BigInt(quantity);
	} catch {
		throw new Error(
			`Invalid lovelace quantity ${JSON.stringify(quantity)} on ${utxo.input.txHash}#${utxo.input.outputIndex}`,
		);
	}
}
