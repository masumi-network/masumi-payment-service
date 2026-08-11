/**
 * One Hydra command over the live websocket, resolved against the frames the
 * node answers with.
 *
 * The hard part this owns is ambiguity: once the command's bytes were queued
 * on the socket, a malformed response, a rejection of a Close already
 * dispatched, transport closure, or a timeout no longer means "not done" —
 * the head may have acted. Every such case surfaces as
 * `HydraTransportAmbiguousError` so callers reconcile instead of retrying.
 */

import { resolveTxHash } from '@meshsdk/core';
import { Connection } from './connection';
import { HydraProtocolError, HydraTransportAmbiguousError, HydraTransportError } from './errors';
import { handleWsResponse, type HydraResponseMessage } from './node-frames';
import { canonicalHydraTransactionIdSchema, hydraCommandTransactionSchema } from './schemas';
import { HydraTransaction } from './types';

export interface HydraCommandOptions {
	command: string;
	payload: unknown;
	timeoutMs: number;
	transactionHash?: string;
	isComplete: (message: HydraResponseMessage) => boolean;
	timeoutMessage: string;
	retryIntervalMs?: number;
}

export function sendHydraCommandAndWait(
	connection: Connection,
	expectedHeadId: string | undefined,
	options: HydraCommandOptions,
): Promise<void> {
	const { command, payload, timeoutMs, transactionHash, isComplete, timeoutMessage, retryIntervalMs } = options;
	return new Promise<void>((resolve, reject) => {
		let isSettled = false;
		let wasQueued = false;
		let retryInterval: ReturnType<typeof setInterval> | undefined;

		const cleanup = () => {
			clearTimeout(timeout);
			if (retryInterval) clearInterval(retryInterval);
			connection.removeListener('message', handleMessage);
			connection.removeListener('close', handleClose);
		};
		const settleResolve = () => {
			if (isSettled) return;
			isSettled = true;
			cleanup();
			resolve();
		};
		const settleReject = (error: unknown) => {
			if (isSettled) return;
			isSettled = true;
			cleanup();
			// Forwards whatever the handlers rejected with; every producing site
			// already constructs an Error subtype.
			// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
			reject(error);
		};
		const ambiguousError = (message: string, cause?: unknown) =>
			new HydraTransportAmbiguousError(message, cause === undefined ? undefined : { cause });
		const handleMessage = (data: string) => {
			const outcome = handleWsResponse(data, command, transactionHash, expectedHeadId);
			if (outcome.kind === 'ignore') return;
			if (outcome.kind === 'protocol-error') {
				settleReject(
					wasQueued
						? ambiguousError(`Hydra ${command} outcome is ambiguous after a malformed response`, outcome.error)
						: outcome.error,
				);
				return;
			}
			if (outcome.kind === 'reject') {
				settleReject(
					command === 'Close' && wasQueued
						? ambiguousError('Hydra Close was rejected after dispatch; the head may already have closed', outcome.error)
						: outcome.error,
				);
				return;
			}
			if (isComplete(outcome.message)) settleResolve();
		};
		const handleClose = (reason: unknown) => {
			// Let Connection.send's promise settle first when the close happened
			// while it was still waiting for OPEN. Once bytes were queued, loss of
			// the response is explicitly ambiguous.
			queueMicrotask(() => {
				if (isSettled) return;
				settleReject(
					wasQueued
						? ambiguousError(`Hydra ${command} outcome is ambiguous after transport closure`, reason)
						: new HydraTransportError(`Hydra ${command} was not sent before transport closure`, {
								cause: reason,
							}),
				);
			});
		};
		const send = () => {
			void connection
				.send(payload)
				.then(() => {
					wasQueued = true;
				})
				.catch((error: unknown) => {
					if (!wasQueued) settleReject(error);
				});
		};

		connection.on('message', handleMessage);
		connection.on('close', handleClose);
		const timeout = setTimeout(() => {
			settleReject(
				wasQueued
					? ambiguousError(timeoutMessage)
					: new HydraTransportError(`${command} was not sent before its ${timeoutMs}ms deadline`),
			);
		}, timeoutMs);
		send();
		if (retryIntervalMs) retryInterval = setInterval(send, retryIntervalMs);
	});
}

/**
 * Validate a transaction for NewTx submission: bounded schema, valid CBOR,
 * and a supplied txId that matches the CBOR body it claims to name.
 */
export function prepareNewTxCommand(transaction: HydraTransaction): {
	txHash: string;
	commandTransaction: HydraTransaction;
} {
	const parsedTransaction = hydraCommandTransactionSchema.safeParse(transaction);
	if (!parsedTransaction.success) {
		throw new HydraProtocolError('Cannot submit a transaction that violates the bounded Hydra schema', {
			cause: parsedTransaction.error,
		});
	}
	let txHash: string;
	try {
		txHash = String(resolveTxHash(parsedTransaction.data.cborHex)).toLowerCase();
	} catch (error) {
		throw new HydraProtocolError('Cannot submit invalid transaction CBOR to Hydra', { cause: error });
	}
	const suppliedTxId =
		parsedTransaction.data.txId == null
			? undefined
			: canonicalHydraTransactionIdSchema.safeParse(parsedTransaction.data.txId);
	if (suppliedTxId && (!suppliedTxId.success || suppliedTxId.data !== txHash)) {
		throw new HydraProtocolError('Cannot submit a transaction whose txId does not match its CBOR body');
	}
	return {
		txHash,
		commandTransaction: {
			...parsedTransaction.data,
			...(suppliedTxId?.success ? { txId: suppliedTxId.data } : {}),
		},
	};
}

/**
 * Wait for a submitted transaction to show up in confirmed evidence. Closure
 * of either evidence socket makes the outcome explicitly ambiguous — the
 * confirmation may exist and simply not have been observed.
 */
export function awaitHydraTxConfirmation(options: {
	connections: Connection[];
	hasConfirmed: (txHash: string) => boolean;
	txHash: string;
	checkIntervalMs: number;
	timeoutMs: number;
}): Promise<boolean> {
	const { connections, hasConfirmed, txHash, checkIntervalMs, timeoutMs } = options;
	return new Promise<boolean>((resolve, reject) => {
		const cleanup = () => {
			clearInterval(interval);
			clearTimeout(timeout);
			for (const connection of connections) connection.removeListener('close', handleClose);
		};
		const handleClose = (reason: unknown) => {
			cleanup();
			if (hasConfirmed(txHash)) {
				resolve(true);
				return;
			}
			reject(
				new HydraTransportAmbiguousError(`Hydra confirmation for ${txHash} is unknown after transport closure`, {
					cause: reason,
				}),
			);
		};
		const interval = setInterval(() => {
			if (hasConfirmed(txHash)) {
				cleanup();
				resolve(true);
			}
		}, checkIntervalMs);
		const timeout = setTimeout(() => {
			cleanup();
			reject(new HydraTransportAmbiguousError(`Hydra transaction ${txHash} was not confirmed within ${timeoutMs}ms`));
		}, timeoutMs);
		for (const connection of connections) connection.on('close', handleClose);
	});
}
