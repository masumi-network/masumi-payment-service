/**
 * Steady-state cost cutters for the L2 live-snapshot pass.
 *
 * Every pass sees the same live escrow outputs again. An output reference is
 * immutable, so its decoded datum and its transaction's parsed CBOR never
 * change: memoize both per head instead of re-running deserializeDatum and the
 * CSL transaction parser each pass. Entries for outputs that left the live set
 * are pruned at the end of each pass.
 *
 * Separately, `findIdentifiersWithNothingToApply` reads (in one batched query)
 * which identifiers either have no local row at all, or have every local row
 * already pointing at the exact live output with a confirmed transaction and
 * the same state. For those, applyDatumStateToLocalRequests returns
 * 'irrelevant' or takes its `alreadyApplied` branch and writes nothing, so the
 * pass can skip its serializable transaction.
 */
import { prisma } from '@masumi/payment-core/db';
import { OnChainState, Prisma, TransactionStatus } from '@/generated/prisma/client';
import type { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import {
	parseHydraTransactionEvidence,
	type HydraTransactionEvidence,
} from '@/services/hydra-connection-manager/hydra-transaction-evidence';

export type LiveEscrowDecode = { decoded: DecodedV1ContractDatum; newState: OnChainState } | null;

type OutputReference = { txHash: string; outputIndex: number };

type HeadMemo = {
	decodes: Map<string, LiveEscrowDecode>;
	evidence: Map<string, { cborHex: string; evidence: HydraTransactionEvidence | null }>;
};

const memoByHead = new Map<string, HeadMemo>();

function headMemo(hydraHeadId: string): HeadMemo {
	let memo = memoByHead.get(hydraHeadId);
	if (!memo) {
		memo = { decodes: new Map(), evidence: new Map() };
		memoByHead.set(hydraHeadId, memo);
	}
	return memo;
}

function outputReferenceKey(input: OutputReference): string {
	return `${input.txHash}#${input.outputIndex}`;
}

export function memoizedLiveEscrowDecode(
	hydraHeadId: string,
	input: OutputReference,
	decode: () => LiveEscrowDecode,
): LiveEscrowDecode {
	const decodes = headMemo(hydraHeadId).decodes;
	const key = outputReferenceKey(input);
	if (decodes.has(key)) return decodes.get(key) ?? null;
	const result = decode();
	decodes.set(key, result);
	return result;
}

export function memoizedTransactionEvidence(
	hydraHeadId: string,
	txHash: string,
	cborHex: string,
): HydraTransactionEvidence | null {
	const evidence = headMemo(hydraHeadId).evidence;
	const cached = evidence.get(txHash);
	if (cached && cached.cborHex === cborHex) return cached.evidence;
	const parsed = parseHydraTransactionEvidence(cborHex);
	evidence.set(txHash, { cborHex, evidence: parsed });
	return parsed;
}

/** Drop memo entries for outputs (and their transactions) no longer in the live set. */
export function pruneLiveEscrowMemo(hydraHeadId: string, liveInputs: OutputReference[]): void {
	const memo = memoByHead.get(hydraHeadId);
	if (!memo) return;
	const liveKeys = new Set(liveInputs.map(outputReferenceKey));
	const liveTxHashes = new Set(liveInputs.map((input) => input.txHash));
	for (const key of memo.decodes.keys()) if (!liveKeys.has(key)) memo.decodes.delete(key);
	for (const txHash of memo.evidence.keys()) if (!liveTxHashes.has(txHash)) memo.evidence.delete(txHash);
}

/** Drop whole-head memos for heads that are no longer reconciled. */
export function retainLiveEscrowMemoHeads(hydraHeadIds: Iterable<string>): void {
	const keep = new Set(hydraHeadIds);
	for (const hydraHeadId of memoByHead.keys()) if (!keep.has(hydraHeadId)) memoByHead.delete(hydraHeadId);
}

type LiveEscrowCandidate = {
	blockchainIdentifier: string;
	newState: OnChainState;
	outputReference: OutputReference;
};

type LocalEscrowRow = {
	blockchainIdentifier: string;
	onChainState: OnChainState | null;
	currentHydraUtxoTxHash: string | null;
	currentHydraUtxoOutputIndex: number | null;
	currentHydraUtxoValue: Prisma.JsonValue | null;
	CurrentTransaction: { txHash: string | null; status: TransactionStatus } | null;
};

export function isRowSettledOnOutput(row: LocalEscrowRow, candidate: LiveEscrowCandidate): boolean {
	return (
		row.onChainState === candidate.newState &&
		row.currentHydraUtxoTxHash === candidate.outputReference.txHash &&
		row.currentHydraUtxoOutputIndex === candidate.outputReference.outputIndex &&
		row.currentHydraUtxoValue != null &&
		row.CurrentTransaction?.txHash === candidate.outputReference.txHash &&
		row.CurrentTransaction.status === TransactionStatus.Confirmed
	);
}

const localEscrowRowSelect = {
	blockchainIdentifier: true,
	onChainState: true,
	currentHydraUtxoTxHash: true,
	currentHydraUtxoOutputIndex: true,
	currentHydraUtxoValue: true,
	CurrentTransaction: { select: { txHash: true, status: true } },
} as const;

/**
 * Identifiers the full apply path would leave untouched: no local row, or every
 * local payment/purchase row already settled on the observed live output.
 */
export async function findIdentifiersWithNothingToApply(
	paymentSourceId: string,
	candidates: LiveEscrowCandidate[],
): Promise<Set<string>> {
	if (candidates.length === 0) return new Set();
	const byIdentifier = new Map(candidates.map((candidate) => [candidate.blockchainIdentifier, candidate]));
	const where = { paymentSourceId, blockchainIdentifier: { in: [...byIdentifier.keys()] } };
	const [payments, purchases] = await Promise.all([
		prisma.paymentRequest.findMany({ where, select: localEscrowRowSelect }),
		prisma.purchaseRequest.findMany({ where, select: localEscrowRowSelect }),
	]);
	const nothingToApply = new Set(byIdentifier.keys());
	for (const row of [...payments, ...purchases]) {
		const candidate = byIdentifier.get(row.blockchainIdentifier);
		if (!candidate || !isRowSettledOnOutput(row, candidate)) nothingToApply.delete(row.blockchainIdentifier);
	}
	return nothingToApply;
}
