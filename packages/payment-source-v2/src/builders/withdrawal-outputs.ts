import {
	getOutputMinLovelace,
	mOutputReference,
	type Asset,
	type MeshTxBuilder,
	type Output,
	type UTxO,
} from '@meshsdk/core';

type Reference = { txHash: string; outputIndex: number };

/** Fund the serialized output, including its reference datum, before coin selection. */
export function addMinimumAdaOutput(builder: MeshTxBuilder, output: Output, coinsPerUtxoSize: number): void {
	if (!Number.isSafeInteger(coinsPerUtxoSize) || coinsPerUtxoSize < 0) {
		throw new Error('Invalid coinsPerUtxoSize for withdrawal output');
	}
	const amount = output.amount.map((asset) => ({ ...asset }));
	const minimum = getOutputMinLovelace({ ...output, amount }, coinsPerUtxoSize);
	const ada = amount.find((asset) => asset.unit === 'lovelace' || asset.unit === '');
	if (ada) {
		if (BigInt(ada.quantity) < minimum) ada.quantity = minimum.toString();
	} else {
		amount.push({ unit: 'lovelace', quantity: minimum.toString() });
	}
	builder.txOut(output.address, amount);
	if (output.datum) builder.txOutInlineDatumValue(output.datum.data.content, output.datum.data.type);
}

export function addWithdrawalOutputs(
	builder: MeshTxBuilder,
	protocolParameters: unknown,
	ownRef: Reference,
	collection: { collectAssets: Asset[]; collectionAddress: string },
	fee: ({ feeAssets: Asset[]; feeAddress: string } & Partial<Reference>) | null,
	collateralReturn: ({ lovelace: bigint; address: string } & Partial<Reference>) | null,
	tagCollection = true,
): void {
	if (
		typeof protocolParameters !== 'object' ||
		protocolParameters === null ||
		!('coinsPerUtxoSize' in protocolParameters) ||
		typeof protocolParameters.coinsPerUtxoSize !== 'number'
	) {
		throw new Error('Missing coinsPerUtxoSize for withdrawal output');
	}
	const { coinsPerUtxoSize } = protocolParameters;
	const datum = (ref: Partial<Reference> = ownRef): Output['datum'] => ({
		type: 'Inline',
		data: {
			type: 'Mesh',
			content: mOutputReference(ref.txHash ?? ownRef.txHash, ref.outputIndex ?? ownRef.outputIndex),
		},
	});
	addMinimumAdaOutput(
		builder,
		{
			address: collection.collectionAddress,
			amount: collection.collectAssets,
			datum: tagCollection ? datum() : undefined,
		},
		coinsPerUtxoSize,
	);
	if (fee)
		addMinimumAdaOutput(
			builder,
			{
				address: fee.feeAddress,
				amount: fee.feeAssets,
				datum: datum(fee),
			},
			coinsPerUtxoSize,
		);
	if (collateralReturn && collateralReturn.lovelace > 0n)
		addMinimumAdaOutput(
			builder,
			{
				address: collateralReturn.address,
				amount: [{ unit: 'lovelace', quantity: collateralReturn.lovelace.toString() }],
				datum: datum(collateralReturn),
			},
			coinsPerUtxoSize,
		);
}

/**
 * One withdraw leg of a V2 batch-withdraw transaction. Each item produces:
 *   - one Spend input + its `Withdraw` or `WithdrawRefund` redeemer,
 *   - one collection output to `collectionAddress` carrying `collectAssets`,
 *   - one optional fee output (V2 has none → always `null`),
 *   - one optional collateral-return output to the buyer.
 *
 * Every collection / fee / collateral-return output's inline datum is
 * `mOutputReference(item.smartContractUtxo.input.txHash, item.smartContractUtxo.input.outputIndex)`.
 * The V2 validator's `outputs_with_reference_tag(self.outputs, own_ref, default, return_addr)`
 * filters outputs by `output.datum == own_ref` AND `output.address == expected`,
 * which is what ties each tagged output back to its specific spending input
 * even when N inputs share the same script and the same return-address shape.
 *
 * Tagging is unconditional in V2 — emitting outputs without the tag would
 * leave them invisible to the validator's output filter and break per-input
 * value accounting. If a future flow needs untagged outputs it should use a
 * separate builder.
 */
export type BatchWithdrawItem = {
	type: 'CollectCompleted' | 'CollectRefund';
	smartContractUtxo: UTxO;
	collection: { collectAssets: Asset[]; collectionAddress: string };
	/** V2 has no protocol fee — pass `null`. The field stays general so future flows can attach one. */
	fee: { feeAssets: Asset[]; feeAddress: string } | null;
	collateralReturn: { lovelace: bigint; address: string } | null;
};
