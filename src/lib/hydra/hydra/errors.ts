/**
 * hydra-node reported that a NewTx command was invalid. Non-locking escrow
 * actions may release their reservation because every retry spends the same
 * unique prior script UTxO. Initial value locks must still fail closed: this
 * response is not proof that their wallet inputs remain unspent.
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
