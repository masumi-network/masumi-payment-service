/**
 * hydra-node reported that a NewTx command was invalid. This does not exclude
 * earlier acceptance of the same body or a withheld signed snapshot. Initial
 * locks and non-locking escrow actions must preserve their reserved lineage.
 * Rejection alone never authorizes rollback; reconcile the intended hash.
 */
export class HydraTransactionRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HydraTransactionRejectedError';
	}
}

/**
 * hydra-node rejected a non-transaction lifecycle command after identifying
 * the exact echoed client input. Whether that proves the wider lifecycle state
 * unchanged is command-specific; Close can race another party and is ambiguous.
 */
export class HydraCommandRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HydraCommandRejectedError';
	}
}

/**
 * hydra-node could not post the L1 transaction a waiting command asked for
 * (PostTxOnChainFailed). Unlike a CommandFailed, which the node also sends for
 * a command the head has already moved past, this one means the transaction
 * never reached the chain.
 */
export class HydraPostTxRejectedError extends HydraCommandRejectedError {
	constructor(message: string) {
		super(message);
		this.name = 'HydraPostTxRejectedError';
	}
}

/**
 * hydra-node refused the command with `RejectedInputBecauseUnsynced`: its chain
 * follower is behind, and it dropped the input without acting on it. Nothing
 * was posted, so the command is safe to send again once the node has synced.
 */
export class HydraCommandRefusedUnsyncedError extends HydraCommandRejectedError {
	constructor(message: string) {
		super(message);
		this.name = 'HydraCommandRefusedUnsyncedError';
	}
}

/**
 * A transport failure which happened before a command could be queued on the
 * websocket. Retrying is safe because no bytes were handed to the transport.
 */
export class HydraTransportError extends Error {
	readonly cause?: unknown;

	constructor(message: string, options?: { cause?: unknown }) {
		super(message);
		this.cause = options?.cause;
		this.name = 'HydraTransportError';
	}
}

/**
 * The websocket accepted the command bytes, but no authoritative response was
 * observed. The command may have succeeded, so callers must reconcile its
 * intended transaction hash instead of rolling local state back.
 */
export class HydraTransportAmbiguousError extends Error {
	readonly cause?: unknown;

	constructor(message: string, options?: { cause?: unknown }) {
		super(message);
		this.cause = options?.cause;
		this.name = 'HydraTransportAmbiguousError';
	}
}

/** A hydra-node frame violated the bounded protocol contract. */
export class HydraProtocolError extends Error {
	readonly cause?: unknown;

	constructor(message: string, options?: { cause?: unknown }) {
		super(message);
		this.cause = options?.cause;
		this.name = 'HydraProtocolError';
	}
}
