import { Address, Transaction, Value } from '@emurgo/cardano-serialization-lib-nodejs';
import type { UTxO } from '@meshsdk/core';

type BalanceMap = Map<string, bigint>;

type MeshLikeUtxo = {
	output: Pick<UTxO['output'], 'amount'>;
};

type LucidLikeUtxo = {
	assets: Record<string, bigint>;
};

type ProjectableMeshLikeUtxo = {
	input: Pick<UTxO['input'], 'txHash' | 'outputIndex'>;
	output: Pick<UTxO['output'], 'amount'>;
};

type ProjectableLucidLikeUtxo = {
	txHash: string;
	outputIndex: number;
	assets: Record<string, bigint>;
};

type ProjectableWalletUtxo = ProjectableMeshLikeUtxo | ProjectableLucidLikeUtxo;

function addQuantity(balanceMap: BalanceMap, assetUnit: string, quantity: bigint) {
	balanceMap.set(assetUnit, (balanceMap.get(assetUnit) ?? 0n) + quantity);
}

function subtractQuantity(balanceMap: BalanceMap, assetUnit: string, quantity: bigint) {
	balanceMap.set(assetUnit, (balanceMap.get(assetUnit) ?? 0n) - quantity);
}

function toBalanceMapFromMeshUtxos(utxos: MeshLikeUtxo[]): BalanceMap {
	const balanceMap = new Map<string, bigint>();

	for (const utxo of utxos) {
		for (const amount of utxo.output.amount) {
			const assetUnit = amount.unit === '' ? 'lovelace' : amount.unit;
			addQuantity(balanceMap, assetUnit, BigInt(amount.quantity));
		}
	}

	return balanceMap;
}

function toBalanceMapFromLucidUtxos(utxos: LucidLikeUtxo[]): BalanceMap {
	const balanceMap = new Map<string, bigint>();

	for (const utxo of utxos) {
		for (const [assetUnit, quantity] of Object.entries(utxo.assets)) {
			addQuantity(balanceMap, assetUnit === '' ? 'lovelace' : assetUnit, quantity);
		}
	}

	return balanceMap;
}

function isLucidProjectableUtxo(utxo: ProjectableWalletUtxo): utxo is ProjectableLucidLikeUtxo {
	return 'assets' in utxo;
}

function createUtxoReferenceKey(txHash: string, outputIndex: number): string {
	return `${txHash}#${outputIndex}`;
}

function toBalanceMapFromProjectableUtxo(utxo: ProjectableWalletUtxo): BalanceMap {
	if (isLucidProjectableUtxo(utxo)) {
		return toBalanceMapFromLucidUtxos([utxo]);
	}

	return toBalanceMapFromMeshUtxos([utxo]);
}

function toBalanceMapFromProjectableUtxos(utxos: ProjectableWalletUtxo[]): BalanceMap {
	const balanceMap = new Map<string, bigint>();

	for (const utxo of utxos) {
		const utxoBalanceMap = toBalanceMapFromProjectableUtxo(utxo);

		for (const [assetUnit, quantity] of utxoBalanceMap) {
			addQuantity(balanceMap, assetUnit, quantity);
		}
	}

	return balanceMap;
}

function toBalanceMapFromCardanoValue(value: Value): BalanceMap {
	const balanceMap = new Map<string, bigint>();

	addQuantity(balanceMap, 'lovelace', BigInt(value.coin().to_str()));

	const multiAsset = value.multiasset();
	if (multiAsset == null) {
		return balanceMap;
	}

	const policyIds = multiAsset.keys();
	for (let policyIndex = 0; policyIndex < policyIds.len(); policyIndex++) {
		const policyId = policyIds.get(policyIndex);
		const assets = multiAsset.get(policyId);
		if (assets == null) {
			continue;
		}

		const assetNames = assets.keys();
		for (let assetIndex = 0; assetIndex < assetNames.len(); assetIndex++) {
			const assetName = assetNames.get(assetIndex);
			const quantity = assets.get(assetName);
			if (quantity == null) {
				continue;
			}

			addQuantity(balanceMap, `${policyId.to_hex()}${assetName.to_hex()}`, BigInt(quantity.to_str()));
		}
	}

	return balanceMap;
}

function projectBalanceMapFromUnsignedTx(
	walletAddress: string,
	walletUtxos: ProjectableWalletUtxo[],
	unsignedTx: string,
	currentBalanceMap?: BalanceMap,
): BalanceMap {
	const projectedBalanceMap =
		currentBalanceMap == null ? toBalanceMapFromProjectableUtxos(walletUtxos) : new Map(currentBalanceMap);
	const knownWalletInputs = new Map<string, BalanceMap>();

	for (const utxo of walletUtxos) {
		const referenceKey = isLucidProjectableUtxo(utxo)
			? createUtxoReferenceKey(utxo.txHash, utxo.outputIndex)
			: createUtxoReferenceKey(utxo.input.txHash, utxo.input.outputIndex);
		knownWalletInputs.set(referenceKey, toBalanceMapFromProjectableUtxo(utxo));
	}

	const walletAddressHex = Address.from_bech32(walletAddress).to_hex();
	const transaction = Transaction.from_bytes(Buffer.from(unsignedTx, 'hex'));
	const transactionBody = transaction.body();
	const inputs = transactionBody.inputs();

	for (let inputIndex = 0; inputIndex < inputs.len(); inputIndex++) {
		const input = inputs.get(inputIndex);
		const inputBalanceMap = knownWalletInputs.get(
			createUtxoReferenceKey(input.transaction_id().to_hex(), input.index()),
		);

		if (inputBalanceMap == null) {
			continue;
		}

		for (const [assetUnit, quantity] of inputBalanceMap) {
			subtractQuantity(projectedBalanceMap, assetUnit, quantity);
		}
	}

	const outputs = transactionBody.outputs();
	for (let outputIndex = 0; outputIndex < outputs.len(); outputIndex++) {
		const output = outputs.get(outputIndex);
		if (output.address().to_hex() !== walletAddressHex) {
			continue;
		}

		for (const [assetUnit, quantity] of toBalanceMapFromCardanoValue(output.amount())) {
			addQuantity(projectedBalanceMap, assetUnit, quantity);
		}
	}

	return projectedBalanceMap;
}

export { projectBalanceMapFromUnsignedTx, toBalanceMapFromLucidUtxos, toBalanceMapFromMeshUtxos };
export type {
	BalanceMap,
	LucidLikeUtxo,
	MeshLikeUtxo,
	ProjectableLucidLikeUtxo,
	ProjectableMeshLikeUtxo,
	ProjectableWalletUtxo,
};
