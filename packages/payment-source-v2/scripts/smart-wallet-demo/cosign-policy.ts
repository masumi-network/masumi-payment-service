// Demo stand-in for the co-signer's "purchase-shaped transaction body verifier"
// (Exchain X-04, not started on their side). Pure: the mock server decodes the
// body, the escrow datums and the wallet input's value, then asks this function
// whether the frozen body is exactly what the intent says before any key signs.
import type { CosignDenialCode, CosignDenied, CosignRequest } from '../../src/smart-wallet/cosign-client';

export type TxRef = { txHash: string; outputIndex: number };

/** The payee-relevant fields of a V2 escrow datum, decoded from the body by the caller. */
export type DecodedEscrowLock = {
	blockchainIdentifier: string;
	buyerAddress: string;
	buyerReturnAddress: string | null;
	sellerAddress: string;
	sellerReturnAddress: string | null;
	fundsLocked: boolean;
};

export type DecodedTxBody = {
	inputs: TxRef[];
	/** `lock` is null when the output carries no inline datum that decodes as a V2 escrow datum. */
	outputs: Array<{ address: string; lovelace: bigint; lock: DecodedEscrowLock | null }>;
	requiredSigners: string[];
	validityStart: number | null;
	ttl: number | null;
};

export type CosignPolicy = {
	memberVkhs: string[];
	threshold: number;
	maxOutflowLovelace: bigint;
	maxValiditySlots: number;
};

export type PolicyVerdict = { ok: true } | { ok: false; denial: CosignDenied };

function deny(code: CosignDenialCode, message: string, locks: CosignDenied['locks'] = []): PolicyVerdict {
	return { ok: false, denial: { decision: 'denied', code, message, retryable: false, locks } };
}

/** One canonical key per escrow output, covering every field that decides where its funds can go. */
function lockKey(lock: {
	address: string;
	lovelace: string;
	blockchainIdentifier: string;
	sellerAddress: string;
	buyerReturnAddress: string | null;
	sellerReturnAddress: string | null;
}): string {
	return [
		lock.address,
		lock.lovelace,
		lock.blockchainIdentifier,
		lock.sellerAddress,
		lock.buyerReturnAddress ?? '-',
		lock.sellerReturnAddress ?? '-',
	].join('|');
}

export function verifyIntentAgainstBody(input: {
	request: CosignRequest;
	body: DecodedTxBody;
	recomputedTxHash: string;
	walletInputLovelace: bigint;
	policy: CosignPolicy;
}): PolicyVerdict {
	const { request, body, policy } = input;
	const { intent, wallet } = request;

	if (input.recomputedTxHash !== request.txHash) {
		return deny('INTENT_MISMATCH', 'txHash does not match txCbor');
	}
	if (!body.inputs.some((ref) => ref.txHash === wallet.input.txHash && ref.outputIndex === wallet.input.outputIndex)) {
		return deny('WALLET_INPUT_UNKNOWN', 'the body does not spend the named wallet input');
	}
	if (body.validityStart == null || body.ttl == null) {
		return deny('VALIDITY_TOO_WIDE', 'both validity bounds must be set');
	}
	if (body.ttl - body.validityStart > policy.maxValiditySlots) {
		return deny('VALIDITY_TOO_WIDE', `validity range spans ${body.ttl - body.validityStart} slots`);
	}
	if (body.validityStart !== intent.validity.invalidBefore || body.ttl !== intent.validity.invalidAfter) {
		return deny('INTENT_MISMATCH', 'the body validity range differs from the intent');
	}
	if (request.requiredSigners.length < policy.threshold) {
		return deny(
			'INTENT_MISMATCH',
			`${request.requiredSigners.length} signer(s) requested, the quorum needs ${policy.threshold}`,
		);
	}
	for (const vkh of request.requiredSigners) {
		if (!policy.memberVkhs.includes(vkh)) {
			return deny('SIGNER_NOT_MEMBER', `${vkh} is not a quorum member`);
		}
		if (!body.requiredSigners.includes(vkh)) {
			return deny('INTENT_MISMATCH', `${vkh} is not a required signer of the body`);
		}
	}

	const walletOutputs = body.outputs.filter((output) => output.address === wallet.address);
	if (walletOutputs.length !== 1) {
		return deny('INTENT_MISMATCH', `expected exactly one continuing wallet output, found ${walletOutputs.length}`);
	}
	const lockAddresses = new Set(intent.locks.map((lock) => lock.address));
	for (const output of body.outputs) {
		const allowed =
			output.address === wallet.address || lockAddresses.has(output.address) || output.address === intent.changeAddress;
		if (!allowed) {
			return deny('RECIPIENT_NOT_ALLOWED', `the body pays ${output.address}, which the intent does not name`);
		}
	}

	// Bind every escrow output to one intent lock through its decoded datum: the
	// purchase identifier and every address the escrow can later pay. Totals
	// alone would approve a body that locks the right amount for the wrong seller.
	const bodyLockKeys: string[] = [];
	for (const output of body.outputs.filter((candidate) => lockAddresses.has(candidate.address))) {
		const lock = output.lock;
		if (lock == null) {
			return deny('INTENT_MISMATCH', `an escrow output at ${output.address} carries no decodable escrow datum`);
		}
		if (!lock.fundsLocked) {
			return deny('INTENT_MISMATCH', 'an escrow datum is not in the FundsLocked state');
		}
		if (lock.buyerAddress !== intent.buyerAddress) {
			return deny('INTENT_MISMATCH', 'an escrow datum names a buyer other than the intent buyer');
		}
		bodyLockKeys.push(lockKey({ ...lock, address: output.address, lovelace: output.lovelace.toString() }));
	}
	const intentLockKeys = intent.locks.map(lockKey);
	if ([...bodyLockKeys].sort().join(',') !== [...intentLockKeys].sort().join(',')) {
		return deny('INTENT_MISMATCH', 'the escrow outputs differ from the intent locks in amount, purchase or payee');
	}

	// Outflow is what the WALLET loses, from the resolved input value, not a
	// self-reported number. Equal to the locks, so no wallet value can reach change.
	const outflow = input.walletInputLovelace - walletOutputs[0].lovelace;
	const lockTotal = intent.locks.reduce((sum, lock) => sum + BigInt(lock.lovelace), 0n);
	if (outflow !== lockTotal || BigInt(intent.outflowLovelace) !== outflow) {
		return deny('INTENT_MISMATCH', `wallet outflow ${outflow} differs from the locked total ${lockTotal}`);
	}

	if (outflow > policy.maxOutflowLovelace) {
		let cumulative = 0n;
		const locks = intent.locks.map((lock, index) => {
			cumulative += BigInt(lock.lovelace);
			return cumulative > policy.maxOutflowLovelace
				? { index, verdict: 'denied' as const, code: 'POLICY_LIMIT_EXCEEDED' as const }
				: { index, verdict: 'allowed' as const };
		});
		return deny(
			'POLICY_LIMIT_EXCEEDED',
			`outflow ${outflow} lovelace exceeds the policy cap of ${policy.maxOutflowLovelace}`,
			locks,
		);
	}
	return { ok: true };
}
