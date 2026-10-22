/**
 * One Hydra command over the live websocket, resolved against the frames the
 * node answers with.
 *
 * The hard part this owns is ambiguity: once the command's bytes were queued
 * on the socket, a malformed response, a failed L1 post that names no
 * transaction, a rejection of a Close already dispatched, transport closure,
 * or a timeout no longer means "not done": the head may have acted. Every such
 * case surfaces as
 * `HydraTransportAmbiguousError` so callers reconcile instead of retrying.
 */

import { resolveTxHash } from '@meshsdk/core';
import { Connection } from './connection';
import { HydraProtocolError, HydraTransportAmbiguousError, HydraTransportError } from './errors';
import { assertL2TxWithinMaxSize } from './l2-tx-size';
import { handleWsResponse, postChainTxTagsFor, type HydraResponseMessage } from './node-frames';
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

/**
 * Commands still waiting for their answer, per live socket.
 *
 * The node answers a command's failed L1 post with the same
 * `PostTxOnChainFailed` frame it sends for a post nobody asked for, such as a
 * contest. The live frame processor reads that frame before the command's own
 * listener does, so it asks here whether a waiting caller will report it.
 */
const awaitedCommands = new WeakMap<Connection, string[]>();

/**
 * Whether a command waiting on `connection` posts the L1 transaction
 * `postChainTxTag`, so its caller records the failure.
 *
 * Never true for a failure that names no transaction. That one fails a waiting
 * L1 command as ambiguous (see `handleWsResponse`), and the Init route can
 * settle an ambiguous Init without a record, so the connection manager keeps
 * its own.
 */
export function isAwaitingPostChainTx(connection: Connection, postChainTxTag: string): boolean {
	return (awaitedCommands.get(connection) ?? []).some((command) => postChainTxTagsFor(command).has(postChainTxTag));
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
		const pendingSend = new AbortController();
		let retryInterval: ReturnType<typeof setInterval> | undefined;

		const awaited = awaitedCommands.get(connection) ?? [];
		awaitedCommands.set(connection, awaited);
		awaited.push(command);
		const cleanup = () => {
			const awaitedIndex = awaited.indexOf(command);
			if (awaitedIndex !== -1) awaited.splice(awaitedIndex, 1);
			clearTimeout(timeout);
			if (retryInterval) clearInterval(retryInterval);
			// A command deadline can precede Connection.send's open deadline. Stop
			// that pending send before releasing a never-dispatched reservation.
			pendingSend.abort();
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
						? ambiguousError(`Hydra ${command} outcome is ambiguous: ${outcome.error.message}`, outcome.error)
						: outcome.error,
				);
				return;
			}
			if (outcome.kind === 'reject') {
				settleReject(
					command === 'Close' && wasQueued
						? ambiguousError(
								`Hydra Close was rejected after dispatch; the head may already have closed: ${outcome.error.message}`,
								outcome.error,
							)
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
				.send(payload, {
					signal: pendingSend.signal,
					onQueued: () => {
						wasQueued = true;
					},
				})
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
	assertL2TxWithinMaxSize(parsedTransaction.data.cborHex);
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

/** The NewTx command for a transaction `prepareNewTxCommand` accepts. It completes on the node's TxValid. */
export function newTxCommand(
	transaction: HydraTransaction,
	timeoutMs: number,
): { txHash: string; command: HydraCommandOptions } {
	const { txHash, commandTransaction } = prepareNewTxCommand(transaction);
	return {
		txHash,
		command: {
			command: 'NewTx',
			payload: { tag: 'NewTx', transaction: commandTransaction },
			timeoutMs,
			transactionHash: txHash,
			timeoutMessage: `Hydra did not report an outcome for transaction ${txHash} within ${timeoutMs}ms`,
			isComplete: (message) => message.tag === 'TxValid' && message.transactionId === txHash,
		},
	};
}

/** Refuse polling options that would never settle or spin. */
export function assertTxConfirmationPolling(checkIntervalMs: number, timeoutMs: number): void {
	if (!Number.isSafeInteger(checkIntervalMs) || checkIntervalMs <= 0) {
		throw new HydraProtocolError('Hydra confirmation polling interval must be a positive safe integer');
	}
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new HydraProtocolError('Hydra confirmation timeout must be a positive safe integer');
	}
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
