/**
 * Reading what a hydra-node said, apart from the session that asked.
 *
 * Split from node.ts, which was well past the 750-line limit. Everything here
 * is frame and response handling with no session behind it: bounding a body or
 * a frame before parsing it, telling a head-scoped frame from a global one,
 * turning a rejection into the error it deserves, and the small ring buffer the
 * session keeps its recent frames in.
 *
 * A leaf. The class calls into these; nothing here reaches back, which is what
 * made this the safe part of that file to move.
 */

import { resolveTxHash } from '@meshsdk/core';

import { logger } from '@masumi/payment-core/logger';
import { HydraCommandRejectedError, HydraProtocolError, HydraTransactionRejectedError } from './errors';
import { parseHydraJson, stringifyHydraJson } from './json';
import {
	MAX_HYDRA_WS_FRAME_BYTES,
	canonicalHydraHeadIdSchema,
	canonicalHydraTransactionIdSchema,
	commandFailedMessageSchema,
	commitRecordedMessageSchema,
	decommitApprovedMessageSchema,
	decommitFinalizedMessageSchema,
	decommitInvalidMessageSchema,
	hydraHeadStatusSchema,
	messageSchema,
	postTxOnChainFailedMessageSchema,
	txInvalidMessageSchema,
	txValidMessageSchema,
} from './schemas';
import { describeDecommitInvalidReason, describePostTxError } from './post-tx-error';
import { HydraHeadStatus } from '@/generated/prisma/client';
import type { DecommitDistributedValue, DecommitSettledData, DepositRecordedData, StatusChangeData } from './types';

const MAX_HYDRA_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;

const UNSUPPORTED_PERSISTENCE_ROTATION_MESSAGE =
	'Hydra persistence event-log rotation is unsupported because compacted replay cannot restore the authenticated head-state anchors';

const HEAD_SCOPED_SERVER_OUTPUT_TAGS = new Set([
	'HeadIsInitializing',
	'Committed',
	'HeadIsOpen',
	'HeadIsClosed',
	'HeadIsContested',
	'ReadyToFanout',
	'HeadIsAborted',
	'HeadIsFinalized',
	'TxValid',
	'TxInvalid',
	'SnapshotConfirmed',
	'IgnoredHeadInitializing',
	'DecommitRequested',
	'DecommitInvalid',
	'DecommitApproved',
	'DecommitFinalized',
	'CommitRecorded',
	'DepositActivated',
	'DepositExpired',
	'CommitApproved',
	'CommitFinalized',
	'CommitRecovered',
	'SnapshotSideLoaded',
]);

export class CircularBuffer<T> {
	// `new Array(n)` is typed any[]; the writes are all through add(), which is
	// typed. Scoped to the two allocations rather than disabling the rule for the
	// file, which is what node.ts did before this moved out of it.
	private buffer: T[];
	private length: number;
	private pointer: number;

	constructor(length: number) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		this.buffer = new Array(length);
		this.length = length;
		this.pointer = 0;
	}

	add(element: T) {
		this.buffer[(this.pointer = (this.pointer + 1) % this.length)] = element;
	}
	getBuffer() {
		return this.buffer;
	}
	clear() {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		this.buffer = new Array(this.length);
		this.pointer = 0;
	}
}

export class HydraHttpResponseError extends Error {
	override readonly name = 'HydraHttpResponseError';

	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export async function handleHttpResponse(response: Response): Promise<unknown> {
	const responseText = await readBoundedHttpResponse(response);
	let responseBody: unknown;
	try {
		responseBody = parseHydraJson(responseText);
	} catch (error) {
		if (response.ok === false) throw createHttpResponseError(response);
		throw new HydraProtocolError('Hydra HTTP response was not valid JSON', { cause: error });
	}
	if (response.ok === false) throw createHttpResponseError(response);
	return responseBody;
}

export async function readBoundedHttpResponse(response: Response): Promise<string> {
	if (response.body && typeof response.body.getReader === 'function') {
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let totalBytes = 0;
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			totalBytes += chunk.value.byteLength;
			if (totalBytes > MAX_HYDRA_HTTP_RESPONSE_BYTES) {
				await reader.cancel();
				throw new HydraProtocolError('Hydra HTTP response exceeded its byte limit');
			}
			chunks.push(chunk.value);
		}
		return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
	}

	let responseText: string;
	if (typeof response.text === 'function') {
		responseText = await response.text();
	} else if (typeof response.json === 'function') {
		try {
			responseText = stringifyHydraJson(await response.json());
		} catch (error) {
			throw new HydraProtocolError('Hydra HTTP response contained an inexact JSON number', { cause: error });
		}
	} else {
		throw new HydraProtocolError('Hydra HTTP response body was unavailable');
	}
	if (Buffer.byteLength(responseText, 'utf8') > MAX_HYDRA_HTTP_RESPONSE_BYTES) {
		throw new HydraProtocolError('Hydra HTTP response exceeded its byte limit');
	}
	return responseText;
}

export function createHttpResponseError(response: Response): Error {
	const status = [response.status, response.statusText].filter(Boolean).join(' ');
	const statusSuffix = status ? ` with ${status}` : '';
	return new HydraHttpResponseError(`Hydra HTTP request failed${statusSuffix}`, response.status);
}

type WsResponseOutcome =
	| { kind: 'message'; message: HydraResponseMessage }
	| { kind: 'reject'; error: Error }
	| { kind: 'protocol-error'; error: HydraProtocolError }
	| { kind: 'ignore' };

export type HydraResponseMessage = {
	tag: string;
	transactionId?: string;
	headStatus?: string;
};

export function parseBoundedJsonFrame(rawMessage: string): unknown {
	if (typeof rawMessage !== 'string') {
		throw new HydraProtocolError('Hydra websocket frame was not text');
	}
	if (Buffer.byteLength(rawMessage, 'utf8') > MAX_HYDRA_WS_FRAME_BYTES) {
		throw new HydraProtocolError(`Hydra websocket frame exceeded ${MAX_HYDRA_WS_FRAME_BYTES} bytes`);
	}
	try {
		return parseHydraJson(rawMessage);
	} catch (error) {
		throw new HydraProtocolError('Hydra websocket frame was not valid JSON', { cause: error });
	}
}

export function protocolErrorToString(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 512);
	return 'Non-error protocol failure';
}

export function isEventLogRotatedFrame(value: unknown): boolean {
	return typeof value === 'object' && value !== null && 'tag' in value && value.tag === 'EventLogRotated';
}

export function createUnsupportedPersistenceRotationError(): HydraProtocolError {
	return new HydraProtocolError(UNSUPPORTED_PERSISTENCE_ROTATION_MESSAGE);
}

export function isHeadScopedServerOutputTag(tag: unknown): tag is string {
	return typeof tag === 'string' && HEAD_SCOPED_SERVER_OUTPUT_TAGS.has(tag);
}

export function frameRequiresHeadId(message: { tag?: string; headStatus?: string }): boolean {
	return (
		isHeadScopedServerOutputTag(message.tag) ||
		(message.tag === 'Greetings' && message.headStatus != null && message.headStatus !== HydraHeadStatus.Idle)
	);
}

export function isConnectionBindingFrame(rawMessage: string): boolean {
	try {
		const value = parseBoundedJsonFrame(rawMessage);
		if (typeof value !== 'object' || value === null) return false;
		return (
			'tag' in value &&
			(value.tag === 'Greetings' ||
				value.tag === 'EventLogRotated' ||
				isHeadScopedServerOutputTag(value.tag) ||
				'headId' in value ||
				'hydraHeadId' in value)
		);
	} catch {
		return false;
	}
}

export function assertExpectedFrameHeadId(
	message: { tag?: string; headStatus?: string; headId?: string; hydraHeadId?: string | null },
	expectedHeadId?: string,
): string | undefined {
	const suppliedIds = [message.headId, message.hydraHeadId]
		.filter((value): value is string => value != null)
		.map((value) => {
			const parsedHeadId = canonicalHydraHeadIdSchema.safeParse(value);
			if (!parsedHeadId.success) {
				throw new HydraProtocolError('Hydra frame contained a non-canonical head identifier');
			}
			return parsedHeadId.data;
		});
	if (new Set(suppliedIds).size > 1) {
		throw new HydraProtocolError('Hydra frame contained conflicting head identifiers');
	}
	if (frameRequiresHeadId(message) && suppliedIds.length === 0) {
		throw new HydraProtocolError(`Hydra ${message.tag ?? 'head-scoped'} frame omitted its head identifier`);
	}
	if (expectedHeadId && suppliedIds[0] && suppliedIds[0] !== expectedHeadId) {
		throw new HydraProtocolError(`Hydra frame head id did not match the pinned head`);
	}
	return suppliedIds[0];
}

export function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	return left.size === right.size && [...left].every((value) => right.has(value));
}

export function stringMapsEqual(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
	return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

export function resolveBoundTransactionHash(transaction: { txId: string; cborHex: string }): string {
	const parsedTxId = canonicalHydraTransactionIdSchema.safeParse(transaction.txId);
	if (!parsedTxId.success) throw new HydraProtocolError('Hydra response contained a non-canonical transaction id');
	let computedTxId: string;
	try {
		computedTxId = String(resolveTxHash(transaction.cborHex)).toLowerCase();
	} catch (error) {
		throw new HydraProtocolError('Hydra response contained invalid transaction CBOR', { cause: error });
	}
	if (computedTxId !== parsedTxId.data) {
		throw new HydraProtocolError('Hydra response transaction id did not match its CBOR body');
	}
	return computedTxId;
}

export function resolveCommandTransactionHash(transaction: { txId?: string; cborHex: string }): string {
	let computedTxId: string;
	try {
		computedTxId = String(resolveTxHash(transaction.cborHex)).toLowerCase();
	} catch (error) {
		throw new HydraProtocolError('CommandFailed echoed invalid transaction CBOR', { cause: error });
	}
	if (transaction.txId != null) {
		const parsedTxId = canonicalHydraTransactionIdSchema.safeParse(transaction.txId);
		if (!parsedTxId.success || parsedTxId.data !== computedTxId) {
			throw new HydraProtocolError('CommandFailed echoed inconsistent transaction identity');
		}
	}
	return computedTxId;
}

export function handleWsResponse(
	rawMessage: string,
	command: string,
	transactionHash?: string,
	expectedHeadId?: string,
): WsResponseOutcome {
	try {
		const raw = parseBoundedJsonFrame(rawMessage);
		if (isEventLogRotatedFrame(raw)) throw createUnsupportedPersistenceRotationError();
		const envelope = messageSchema.parse(raw);
		assertExpectedFrameHeadId(envelope, expectedHeadId);

		if (envelope.tag === 'TxValid') {
			const message = txValidMessageSchema.parse(raw);
			assertExpectedFrameHeadId(message, expectedHeadId);
			return { kind: 'message', message };
		}
		if (envelope.tag === 'TxInvalid') {
			const message = txInvalidMessageSchema.parse(raw);
			assertExpectedFrameHeadId(message, expectedHeadId);
			const rejectedTxHash = resolveBoundTransactionHash(message.transaction);
			if (command === 'NewTx' && transactionHash === rejectedTxHash) {
				// The node's own reason, when it gave one. Without it every rejection
				// reads the same, and the ones worth acting on — a lock that raced a
				// deposit being folded in, say — are indistinguishable from a bug in
				// the transaction we built.
				const reason = message.validationError?.reason;
				return {
					kind: 'reject',
					error: new HydraTransactionRejectedError(
						reason ? `Transaction is invalid: ${reason}` : 'Transaction is invalid',
					),
				};
			}
			return { kind: 'message', message };
		}
		if (envelope.tag === 'CommandFailed') {
			const message = commandFailedMessageSchema.parse(raw);
			assertExpectedFrameHeadId(message, expectedHeadId);
			if (command === 'NewTx') {
				if (message.clientInput?.tag !== 'NewTx' || !message.clientInput.transaction || !transactionHash) {
					return { kind: 'ignore' };
				}
				const rejectedTxHash = resolveCommandTransactionHash(message.clientInput.transaction);
				if (rejectedTxHash !== transactionHash) return { kind: 'ignore' };
				return {
					kind: 'reject',
					error: new HydraTransactionRejectedError(`Error posting transaction with hash ${transactionHash}`),
				};
			}
			if (message.clientInput?.tag === command) {
				return { kind: 'reject', error: new HydraCommandRejectedError(`Command ${command} failed`) };
			}
			return { kind: 'message', message };
		}
		if (envelope.tag === 'PostTxOnChainFailed') {
			const message = postTxOnChainFailedMessageSchema.parse(raw);
			assertExpectedFrameHeadId(message, expectedHeadId);
			if (message.postChainTx?.tag === `${command}Tx`) {
				// Name the node's own reason. Without it every L1 refusal reads the
				// same, and the operator has no way to tell "the node's key holds
				// nothing" (NoSeedInput) from a genuine protocol rejection — the two
				// have completely different fixes.
				const reason = describePostTxError(message.postTxError);
				return {
					kind: 'reject',
					error: new HydraCommandRejectedError(`hydra-node refused to post the ${command} transaction: ${reason}`),
				};
			}
			return { kind: 'message', message };
		}

		return { kind: 'message', message: envelope };
	} catch (error) {
		return {
			kind: 'protocol-error',
			error:
				error instanceof HydraProtocolError
					? error
					: new HydraProtocolError('Hydra websocket response failed schema validation', { cause: error }),
		};
	}
}

export function extractStatusChangeData(rawMessage: string, expectedHeadId?: string): StatusChangeData | null {
	try {
		const message = parseBoundedJsonFrame(rawMessage);
		const parsedMessage = messageSchema.parse(message);
		const suppliedHeadId = assertExpectedFrameHeadId(parsedMessage, expectedHeadId);
		let newStatus: HydraHeadStatus | null = null;
		switch (parsedMessage.tag) {
			case 'Greetings':
				newStatus = hydraHeadStatusSchema.safeParse(parsedMessage.headStatus).data ?? null;
				break;
			case 'HeadIsInitializing':
				newStatus = HydraHeadStatus.Initializing;
				break;
			case 'HeadIsOpen':
				newStatus = HydraHeadStatus.Open;
				break;
			case 'HeadIsClosed':
				newStatus = HydraHeadStatus.Closed;
				break;
			case 'ReadyToFanout':
				newStatus = HydraHeadStatus.FanoutPossible;
				break;
			case 'HeadIsFinalized':
				newStatus = HydraHeadStatus.Final;
				break;
			case 'HeadIsAborted':
				// An abort ends the head before it ever opens, and the frame carries no
				// `headStatus` — so without this case the default branch found nothing
				// and no status change was emitted at all. The head then sat at
				// `Initializing` for the life of the socket: `init()` short-circuits on
				// that status, so a retry never reached the node, and the row stayed
				// `Initializing` with no reason for the socket to drop and correct it.
				//
				// Idle is where hydra-node itself goes, and it ranks below `Open`, so
				// the manager treats it as the rollback it is and quarantines the head
				// for an operator rather than leaving it to look usable.
				newStatus = HydraHeadStatus.Idle;
				break;
			default:
				newStatus = hydraHeadStatusSchema.safeParse(parsedMessage.headStatus).data ?? null;
				break;
		}

		if (!newStatus) return null;

		return {
			status: newStatus,
			headId: suppliedHeadId,
			snapshotNumber: parsedMessage.snapshotNumber,
			contestationDeadline: parsedMessage.contestationDeadline,
		};
	} catch (error) {
		logger.error('[HydraNode] Rejected status frame', { error: protocolErrorToString(error) });
		return null;
	}
}

/**
 * What a finalized withdrawal put on L1, flattened out of the head's report.
 *
 * The head reports a map of in-head references to outputs, each with a value
 * keyed by policy id and then by asset name. Flattened here to the concatenated
 * unit the rest of the service speaks, so nothing downstream has to know the
 * head's nesting.
 */
type HydraAssetQuantity = number | string;
type HydraOutputValue = Record<string, HydraAssetQuantity | Record<string, HydraAssetQuantity>>;

export function summarizeDistributedUtxo(
	distributed: Record<string, { value: HydraOutputValue }> | undefined,
): DecommitDistributedValue | undefined {
	if (!distributed) return undefined;
	let lovelace = 0n;
	const assets: Record<string, string> = {};
	for (const entry of Object.values(distributed)) {
		for (const [policyId, held] of Object.entries(entry.value)) {
			if (policyId === 'lovelace') {
				lovelace += BigInt(held as HydraAssetQuantity);
				continue;
			}
			if (typeof held !== 'object') continue;
			for (const [assetName, quantity] of Object.entries(held)) {
				const unit = `${policyId}${assetName}`;
				assets[unit] = (BigInt(assets[unit] ?? '0') + BigInt(quantity)).toString();
			}
		}
	}
	return { lovelace, assets };
}

/**
 * A deposit frame's deadline, or undefined if it is not a usable date.
 *
 * Parsed rather than trusted: the deadline is written straight to the
 * database and shown to an operator deciding whether to recover funds, so an
 * unparseable one is better absent than stored as Invalid Date.
 */
export function readDepositRecorded(message: unknown): DepositRecordedData | undefined {
	const recorded = commitRecordedMessageSchema.parse(message);
	const deadline = new Date(recorded.deadline);
	if (!Number.isFinite(deadline.getTime())) return undefined;
	return { depositTxId: recorded.pendingDeposit, deadline };
}

/**
 * A withdrawal's settlement, when this frame reports one.
 *
 * Approved is the point of no return — the head has signed the removal, so
 * the value is gone from it whatever L1 does next — which is why it is
 * surfaced rather than waiting for the finalization that follows it. An
 * invalid decommit returns the body the node refused rather than an id, so
 * the id is recovered from it, the same way TxInvalid is matched back to the
 * request that produced it.
 */
export function readDecommitSettled(tag: string, message: unknown): DecommitSettledData | undefined {
	if (tag === 'DecommitApproved') {
		const approved = decommitApprovedMessageSchema.parse(message);
		return { decommitTxId: approved.decommitTxId, outcome: 'approved' };
	}
	if (tag === 'DecommitFinalized') {
		const finalized = decommitFinalizedMessageSchema.parse(message);
		const producedAt = finalized.timestamp === undefined ? undefined : new Date(finalized.timestamp);
		return {
			decommitTxId: finalized.decommitTxId,
			outcome: 'finalized',
			distributed: summarizeDistributedUtxo(finalized.distributedUTxO),
			observedAt: producedAt !== undefined && Number.isFinite(producedAt.getTime()) ? producedAt : undefined,
		};
	}
	if (tag === 'DecommitInvalid') {
		const invalid = decommitInvalidMessageSchema.parse(message);
		return {
			decommitTxId: String(resolveTxHash(invalid.decommitTx.cborHex)),
			outcome: 'invalid',
			reason: describeDecommitInvalidReason(invalid.decommitInvalidReason),
		};
	}
	return undefined;
}
