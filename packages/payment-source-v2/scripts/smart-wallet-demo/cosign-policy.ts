// Demo stand-in for the quorum's "purchase-shaped transaction body verifier"
// (Exchain X-04). Pure: the mock server decodes the body, the escrow datums and
// the wallet input, then asks this function whether the frozen body is exactly
// what the intents say — and which members the mandate admits — before any key
// signs.
//
// Contract 1.1 carries no wallet address, change address or escrow address in
// the request: the verifier resolves the wallet from the body's continuing
// output and knows the agent keys and escrow addresses from registration. The
// `policy` argument below stands in for that registration.
import type {
	CosignBatchDenialCode,
	CosignIntent,
	CosignMemberVerdict,
	CosignRequest,
} from '../../src/smart-wallet/cosign-client';

export type TxRef = { txHash: string; outputIndex: number };

/** The payee-relevant fields of a V2 escrow datum, decoded from the body by the caller. */
export type DecodedEscrowLock = {
	blockchainIdentifier: string;
	buyerPaymentKeyHash: string | null;
	sellerPaymentKeyHash: string | null;
	fundsLocked: boolean;
};

export type DecodedOutput = {
	address: string;
	lovelace: bigint;
	/** True when the output carries any asset other than lovelace. */
	hasOtherAssets: boolean;
	/** Null when the address is a script address or cannot be parsed. */
	paymentKeyHash: string | null;
	/** Null when the output carries no inline datum that decodes as a V2 escrow datum. */
	lock: DecodedEscrowLock | null;
};

export type DecodedTxBody = {
	inputs: TxRef[];
	outputs: DecodedOutput[];
	requiredSigners: string[];
	validityStart: number | null;
	ttl: number | null;
};

export type CosignPolicy = {
	memberVkhs: string[];
	threshold: number;
	/** Cumulative outflow admitted per transaction. Stands in for a rolling-window rule. */
	maxOutflowLovelace: bigint;
	/** Largest single lock admitted. Stands in for `per_tx_cap`. */
	maxPerIntentLovelace: bigint;
	maxValiditySlots: number;
	/** From registration: the hot keys allowed to spend, and where their change may go. */
	agentVkhs: string[];
	escrowAddresses: string[];
};

export type PolicyOutcome =
	| { kind: 'allow'; members: CosignMemberVerdict[] }
	| { kind: 'batch-denied'; code: CosignBatchDenialCode; reasonEnglish: string; detail?: string }
	| { kind: 'member-denied'; members: CosignMemberVerdict[]; keep: string[] };

function batchDenied(code: CosignBatchDenialCode, reasonEnglish: string, detail?: string): PolicyOutcome {
	return { kind: 'batch-denied', code, reasonEnglish, detail };
}

function allowedMember(intent: CosignIntent): CosignMemberVerdict {
	return { purchaseId: intent.purchaseId, outputIndex: intent.outputIndex, verdict: 'allowed' };
}

const ada = (lovelace: bigint) => `${(Number(lovelace) / 1e6).toFixed(6)} tADA`;

export type VerifyInput = {
	request: CosignRequest;
	body: DecodedTxBody;
	/** Value and address of the wallet input named by `walletUtxoRef`, resolved on chain. */
	walletInput: { address: string; lovelace: bigint };
	policy: CosignPolicy;
	nowMs: number;
};

/**
 * Batch-level checks first (a batch denial leaves every member unevaluated),
 * then a greedy per-member pass in submission order: each member is judged
 * against the state that includes every member admitted before it.
 */
export function verifyIntentAgainstBody(input: VerifyInput): PolicyOutcome {
	const { request, body, policy } = input;
	const [walletTxHash, walletIndex] = request.walletUtxoRef.split('#');

	if (!body.inputs.some((ref) => ref.txHash === walletTxHash && ref.outputIndex === Number(walletIndex))) {
		return batchDenied('utxo_unknown', 'The body does not spend the named wallet input.', 'stale_ref');
	}

	const walletOutputs = body.outputs.filter((output) => output.address === input.walletInput.address);
	if (walletOutputs.length !== 1) {
		return batchDenied(
			'body_mismatch',
			`Expected exactly one continuing wallet output, found ${walletOutputs.length}.`,
		);
	}

	if (body.validityStart == null || body.ttl == null) {
		return batchDenied('clock_skew', 'A guarded spend must set both validity bounds.');
	}
	if (body.ttl - body.validityStart > policy.maxValiditySlots) {
		return batchDenied('clock_skew', `The validity range spans ${body.ttl - body.validityStart} slots.`);
	}

	// The quorum members that must sign are read out of the body, never from a
	// request hint. Enough of them must be declared, or the signatures we
	// produce could not satisfy the validator anyway.
	const declaredMembers = policy.memberVkhs.filter((vkh) => body.requiredSigners.includes(vkh));
	if (declaredMembers.length < policy.threshold) {
		return batchDenied(
			'body_mismatch',
			`The body declares ${declaredMembers.length} quorum signer(s); the threshold is ${policy.threshold}.`,
		);
	}

	const escrowAddresses = new Set(policy.escrowAddresses);
	const intentByOutputIndex = new Map(request.intents.map((intent) => [intent.outputIndex, intent]));

	for (const [index, output] of body.outputs.entries()) {
		if (output.address === input.walletInput.address || intentByOutputIndex.has(index)) continue;
		// Anything left must be change returning to a registered agent key.
		if (escrowAddresses.has(output.address) || output.paymentKeyHash == null) {
			return batchDenied('payee_unpinned', `Output ${index} pays ${output.address}, which no purchase names.`);
		}
		if (!policy.agentVkhs.includes(output.paymentKeyHash)) {
			return batchDenied('payee_unpinned', `Output ${index} pays a key the mandate does not pin.`);
		}
	}

	let declaredOutflow = 0n;
	for (const intent of request.intents) {
		const output = body.outputs[intent.outputIndex];
		if (output == null) {
			return batchDenied(
				'body_mismatch',
				`Purchase ${intent.purchaseId} names output ${intent.outputIndex}, which does not exist.`,
			);
		}
		if (!escrowAddresses.has(output.address)) {
			return batchDenied('payee_unpinned', `Purchase ${intent.purchaseId} does not pay a registered escrow address.`);
		}
		if (intent.asset !== 'lovelace') {
			// The mock governs lovelace only. The live service governs tUSDM.
			return batchDenied(
				'asset_not_listed',
				`This wallet governs lovelace; purchase ${intent.purchaseId} names ${intent.asset}.`,
			);
		}
		if (output.hasOtherAssets) {
			return batchDenied(
				'asset_not_listed',
				`Output ${intent.outputIndex} carries an asset the mandate does not list.`,
			);
		}
		if (output.lovelace !== BigInt(intent.amount)) {
			return batchDenied(
				'body_mismatch',
				`Purchase ${intent.purchaseId} declares ${intent.amount} lovelace; output ${intent.outputIndex} carries ${output.lovelace}.`,
			);
		}
		const lock = output.lock;
		if (lock == null || !lock.fundsLocked) {
			return batchDenied(
				'body_mismatch',
				`Output ${intent.outputIndex} carries no escrow datum in the FundsLocked state.`,
			);
		}
		if (lock.sellerPaymentKeyHash == null || `sellerVkeyHash:${lock.sellerPaymentKeyHash}` !== intent.counterparty) {
			return batchDenied(
				'payee_unpinned',
				`Output ${intent.outputIndex} names a seller other than the declared counterparty.`,
			);
		}
		if (lock.buyerPaymentKeyHash == null || !policy.agentVkhs.includes(lock.buyerPaymentKeyHash)) {
			return batchDenied(
				'body_mismatch',
				`Output ${intent.outputIndex} names a buyer that is not a registered agent key.`,
			);
		}
		declaredOutflow += BigInt(intent.amount);
	}

	// Outflow is what the WALLET loses, taken from the resolved input value, not
	// from a self-reported number: no wallet value may reach change.
	const outflow = input.walletInput.lovelace - walletOutputs[0].lovelace;
	if (outflow !== declaredOutflow) {
		return batchDenied(
			'body_mismatch',
			`The wallet loses ${ada(outflow)} but the purchases declare ${ada(declaredOutflow)}.`,
		);
	}

	const members: CosignMemberVerdict[] = [];
	const keep: string[] = [];
	let used = 0n;
	for (const intent of request.intents) {
		const attempted = BigInt(intent.amount);
		if (attempted > policy.maxPerIntentLovelace) {
			members.push({
				purchaseId: intent.purchaseId,
				outputIndex: intent.outputIndex,
				verdict: 'denied',
				denied: 'per_tx_cap',
				reasonEnglish: `This payment is ${ada(attempted)}. The mandate allows ${ada(policy.maxPerIntentLovelace)} in a single payment.`,
				bound: policy.maxPerIntentLovelace.toString(),
				used: used.toString(),
				attempted: attempted.toString(),
			});
			continue;
		}
		if (used + attempted > policy.maxOutflowLovelace) {
			const windowResetsAt = new Date(input.nowMs + 3_600_000).toISOString();
			members.push({
				purchaseId: intent.purchaseId,
				outputIndex: intent.outputIndex,
				verdict: 'denied',
				denied: 'hourly_outflow',
				reasonEnglish: `This would take the hour's spending to ${ada(used + attempted)}. The mandate allows ${ada(policy.maxOutflowLovelace)}.`,
				bound: policy.maxOutflowLovelace.toString(),
				used: used.toString(),
				attempted: attempted.toString(),
				retryAfterSec: 3_600,
				windowResetsAt,
			});
			continue;
		}
		used += attempted;
		members.push(allowedMember(intent));
		keep.push(intent.purchaseId);
	}

	if (members.some((member) => member.verdict === 'denied')) {
		return { kind: 'member-denied', members, keep };
	}
	return { kind: 'allow', members };
}
