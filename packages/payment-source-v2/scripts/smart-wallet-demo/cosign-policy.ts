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
import { assetUnitOf, LOVELACE_ASSET_ID } from '../../src/smart-wallet/governed-asset';

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
	/** Every other asset the output holds, by unit (policy id + asset name hex). */
	assets: Map<string, bigint>;
	/** Null when the address is a script address or cannot be parsed. */
	paymentKeyHash: string | null;
	/** Null when the output carries no inline datum that decodes as a V2 escrow datum. */
	lock: DecodedEscrowLock | null;
};

export type DecodedTxBody = {
	inputs: TxRef[];
	outputs: DecodedOutput[];
	requiredSigners: string[];
	fee: bigint;
	/** Certificates, withdrawals, mint, votes, proposals or treasury fields: each adds a term to value balance. */
	hasBalanceFields: boolean;
	validityStart: number | null;
	ttl: number | null;
};

export type CosignPolicy = {
	memberVkhs: string[];
	threshold: number;
	/** The one asset the mandate counts, in Exchain form (`lovelace` or `<policy>.<nameHex>`). */
	governedAsset: string;
	/** Cumulative outflow admitted per transaction, in the governed asset. Stands in for a rolling-window rule. */
	maxOutflow: bigint;
	/** Largest single lock admitted, in the governed asset. Stands in for `per_tx_cap`. */
	maxPerIntent: bigint;
	/** Token wallet only: the min-UTxO lovelace each token lock output may carry beside the token. */
	maxRideAlongLovelace: bigint;
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

/** A readable name for a 6-decimal unit: tADA, or the asset name with any CIP-67 label bytes dropped. */
function assetLabel(unit: string): string {
	if (unit === 'lovelace') return 'tADA';
	const name = Buffer.from(unit.slice(56), 'hex')
		.toString('latin1')
		.replace(/[^\x20-\x7e]/g, '');
	return name === '' ? `${unit.slice(0, 8)}…` : name;
}

const amountOf = (quantity: bigint, unit: string) => `${(Number(quantity) / 1e6).toFixed(6)} ${assetLabel(unit)}`;

export type VerifyInput = {
	request: CosignRequest;
	body: DecodedTxBody;
	/**
	 * Value and address of the wallet input named by `walletUtxoRef`. An in-head
	 * input comes from a snapshot proof, whose refs are not signed, so it also
	 * names the wallet's state token for the continuing-output check.
	 */
	walletInput: { address: string; lovelace: bigint; assets: Map<string, bigint>; stateTokenUnit?: string };
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

	// The validator makes the continuing output carry the spent input's state
	// token, so this ties the input the body really spends to the wallet the
	// input value was read from. Wallets of one configuration share an address.
	const stateTokenUnit = input.walletInput.stateTokenUnit;
	if (stateTokenUnit != null && walletOutputs[0].assets.get(stateTokenUnit) !== 1n) {
		return batchDenied('body_mismatch', "The continuing wallet output does not carry this wallet's state token.");
	}

	// An in-head input comes from a snapshot proof, which may be stale: the
	// wallet may hold more now than the proof shows, hiding outflow from the
	// value check below. So the body must have the honest builder's exact shape:
	// the wallet is the only input, the fee is 0, nothing else enters the value
	// balance (deposits, refunds, withdrawals, mint, donation), and every output
	// is the continuing output or an intent output. Value conservation then
	// makes the wallet's real outflow equal the declared outflow, however old the proof.
	if (stateTokenUnit != null) {
		const intentIndexes = new Set(request.intents.map((intent) => intent.outputIndex));
		const continuingIndex = body.outputs.indexOf(walletOutputs[0]);
		const extraOutput = body.outputs.some((_, index) => index !== continuingIndex && !intentIndexes.has(index));
		if (body.inputs.length !== 1 || body.fee !== 0n || body.hasBalanceFields || extraOutput) {
			return batchDenied(
				'body_mismatch',
				'An in-head spend must spend only the wallet, pay no fee, carry no certificate, withdrawal, mint or treasury field, and create only the continuing and intent outputs.',
			);
		}
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

	const isLovelaceWallet = policy.governedAsset === LOVELACE_ASSET_ID;
	const governedUnit = isLovelaceWallet ? 'lovelace' : assetUnitOf(policy.governedAsset);
	let declaredOutflow = 0n;
	let rideAlongLovelace = 0n;
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
		if (intent.asset !== policy.governedAsset) {
			return batchDenied(
				'asset_not_listed',
				`This wallet governs ${policy.governedAsset}; purchase ${intent.purchaseId} names ${intent.asset}.`,
			);
		}
		if ([...output.assets.keys()].some((unit) => unit !== governedUnit)) {
			return batchDenied(
				'asset_not_listed',
				`Output ${intent.outputIndex} carries an asset the mandate does not list.`,
			);
		}
		const carried = isLovelaceWallet ? output.lovelace : (output.assets.get(governedUnit) ?? 0n);
		if (carried !== BigInt(intent.amount)) {
			return batchDenied(
				'body_mismatch',
				`Purchase ${intent.purchaseId} declares ${intent.amount} ${governedUnit}; output ${intent.outputIndex} carries ${carried}.`,
			);
		}
		// A token lock output also carries its min-UTxO lovelace. Bound it, so ADA cannot leave unseen.
		if (!isLovelaceWallet) {
			if (output.lovelace > policy.maxRideAlongLovelace) {
				return batchDenied(
					'body_mismatch',
					`Output ${intent.outputIndex} carries ${amountOf(output.lovelace, 'lovelace')} beside the token; the mandate allows ${amountOf(policy.maxRideAlongLovelace, 'lovelace')}.`,
				);
			}
			rideAlongLovelace += output.lovelace;
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

	// Outflow is what the WALLET loses, per asset, taken from the resolved input
	// value, not from a self-reported number: no wallet value may reach change.
	// A token wallet loses the declared token plus the ride-along lovelace; every
	// other asset must stay.
	const expectedOutflow = new Map([['lovelace', isLovelaceWallet ? declaredOutflow : rideAlongLovelace]]);
	if (!isLovelaceWallet) expectedOutflow.set(governedUnit, declaredOutflow);
	const inputValue = new Map([['lovelace', input.walletInput.lovelace], ...input.walletInput.assets]);
	const continuingValue = new Map([['lovelace', walletOutputs[0].lovelace], ...walletOutputs[0].assets]);
	for (const unit of new Set([...inputValue.keys(), ...continuingValue.keys()])) {
		const outflow = (inputValue.get(unit) ?? 0n) - (continuingValue.get(unit) ?? 0n);
		const expected = expectedOutflow.get(unit) ?? 0n;
		if (outflow !== expected) {
			return batchDenied(
				'body_mismatch',
				`The wallet loses ${amountOf(outflow, unit)} but the purchases declare ${amountOf(expected, unit)}.`,
			);
		}
	}

	const members: CosignMemberVerdict[] = [];
	const keep: string[] = [];
	let used = 0n;
	for (const intent of request.intents) {
		const attempted = BigInt(intent.amount);
		if (attempted > policy.maxPerIntent) {
			members.push({
				purchaseId: intent.purchaseId,
				outputIndex: intent.outputIndex,
				verdict: 'denied',
				denied: 'per_tx_cap',
				reasonEnglish: `This payment is ${amountOf(attempted, governedUnit)}. The mandate allows ${amountOf(policy.maxPerIntent, governedUnit)} in a single payment.`,
				bound: policy.maxPerIntent.toString(),
				used: used.toString(),
				attempted: attempted.toString(),
			});
			continue;
		}
		if (used + attempted > policy.maxOutflow) {
			const windowResetsAt = new Date(input.nowMs + 3_600_000).toISOString();
			members.push({
				purchaseId: intent.purchaseId,
				outputIndex: intent.outputIndex,
				verdict: 'denied',
				denied: 'hourly_outflow',
				reasonEnglish: `This would take the hour's spending to ${amountOf(used + attempted, governedUnit)}. The mandate allows ${amountOf(policy.maxOutflow, governedUnit)}.`,
				bound: policy.maxOutflow.toString(),
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
