import type { BatchRegistryMintItem } from '../../../builders/batch-registry';
import { buildSignedRegistryMintPrefix } from './signed-batch';

const L1_MAX_TX_SIZE = 16_384;
const SIGNATURE_BYTES = 106;

function makeItems(count: number): BatchRegistryMintItem[] {
	return Array.from({ length: count }, (_, index) => ({
		recipientWalletAddress: 'addr_test1',
		fundingLovelace: '5000000',
		assetName: `asset-${index}`,
		firstUtxo: {
			input: { txHash: 'a'.repeat(64), outputIndex: index },
			output: { address: 'addr_test1', amount: [{ unit: 'lovelace', quantity: '5000000' }] },
		},
		metadata: { name: `Agent ${index}` },
	}));
}

function hexBytes(count: number): string {
	return 'ab'.repeat(count);
}

function buildWithSizes(sizes: Record<number, number>) {
	const builtPrefixes: number[] = [];
	const result = {
		buildEvaluationTx: async (items: BatchRegistryMintItem[]) => {
			builtPrefixes.push(items.length);
			return hexBytes(sizes[items.length] - SIGNATURE_BYTES);
		},
		evaluateTx: async () => [{ tag: 'MINT', budget: { mem: 1, steps: 1 } }],
		buildFinalTx: async (items: BatchRegistryMintItem[]) => hexBytes(sizes[items.length] - SIGNATURE_BYTES),
		signTx: async (unsignedTx: string) => unsignedTx + hexBytes(SIGNATURE_BYTES),
		builtPrefixes,
	};
	return result;
}

describe('V2 registry mint signed-size prefix', () => {
	it('keeps a batch above the old 14 KB margin when the signed tx fits L1', async () => {
		const builder = buildWithSizes({ 3: 14_367 });
		const result = await buildSignedRegistryMintPrefix(
			makeItems(3),
			{ maxTxSize: L1_MAX_TX_SIZE },
			builder.buildEvaluationTx,
			builder.evaluateTx,
			builder.buildFinalTx,
			builder.signTx,
		);
		expect(result?.fitCount).toBe(3);
		expect(result?.signedTx.length).toBe(14_367 * 2);
		expect(builder.builtPrefixes).toEqual([3]);
	});

	it('peels the tail after final signing exceeds the live L1 limit', async () => {
		const builder = buildWithSizes({ 3: L1_MAX_TX_SIZE + 22, 2: 14_367 });
		const result = await buildSignedRegistryMintPrefix(
			makeItems(3),
			{ maxTxSize: L1_MAX_TX_SIZE },
			builder.buildEvaluationTx,
			builder.evaluateTx,
			builder.buildFinalTx,
			builder.signTx,
		);
		expect(result?.fitCount).toBe(2);
		expect(builder.builtPrefixes).toEqual([3, 2]);
	});

	it('returns no fit when one item exceeds the limit after signing', async () => {
		const builder = buildWithSizes({ 1: L1_MAX_TX_SIZE + 1 });
		const result = await buildSignedRegistryMintPrefix(
			makeItems(1),
			{ maxTxSize: L1_MAX_TX_SIZE },
			builder.buildEvaluationTx,
			builder.evaluateTx,
			builder.buildFinalTx,
			builder.signTx,
		);
		expect(result).toBeNull();
		expect(builder.builtPrefixes).toEqual([1]);
	});

	it('peels before evaluation when the evaluation tx already exceeds L1', async () => {
		const builder = buildWithSizes({ 2: L1_MAX_TX_SIZE + SIGNATURE_BYTES + 1, 1: 14_367 });
		let evaluations = 0;
		const evaluateTx = async () => {
			evaluations++;
			return builder.evaluateTx();
		};
		const result = await buildSignedRegistryMintPrefix(
			makeItems(2),
			{ maxTxSize: L1_MAX_TX_SIZE },
			builder.buildEvaluationTx,
			evaluateTx,
			builder.buildFinalTx,
			builder.signTx,
		);
		expect(result?.fitCount).toBe(1);
		expect(builder.builtPrefixes).toEqual([2, 1]);
		expect(evaluations).toBe(1);
	});
});
