/**
 * Read-side Control Plane queries against a Hydra node's HTTP endpoint, and
 * the request bodies the write side posts. Pure functions over the minimal
 * `get`/`post` surface, so they can be exercised without a session.
 */

import { Protocol, UTxO, castProtocol } from '@meshsdk/core';
import { logger } from '@masumi/payment-core/logger';
import { mapHydraUTxOToUTxO, mapUTxOToHydraUTxO } from './codec';
import { HydraProtocolError } from './errors';
import { extractDecommitInFlight, extractHeadOutputTxId, extractPendingDecommitRefs } from './head-output-tx';
import { HydraHttpResponseError, protocolErrorToString } from './node-frames';
import { type HydraRawCostModels } from './node-api';
import { EXPECTED_MAX_TX_SIZE, reportParamsDrift } from './params-drift';
import {
	hydraCostModelSchema,
	hydraAcknowledgedDepositSchema,
	hydraConfirmedSnapshotSchema,
	hydraCostModelsEnvelopeSchema,
	hydraLastSeenSnapshotSchema,
	hydraProtocolParametersSchema,
	hydraSeenDepositSchema,
	hydraSnapshotUtxoSchema,
} from './schemas';
import { HydraUTxO } from './types';

export interface HydraQueryTransport {
	get<T = unknown>(url: string): Promise<T>;
}

export async function fetchHydraProtocolParameters(
	transport: HydraQueryTransport,
	reportedParamsDrift: Set<string>,
): Promise<Protocol> {
	const raw = await transport.get('/protocol-parameters');
	// Checked on the raw payload rather than the parsed one: castProtocol drops
	// the cost models, and the schema is deliberately loose, so this is the only
	// point where what the head actually reports is still intact.
	reportParamsDrift(raw, reportedParamsDrift);
	const response = hydraProtocolParametersSchema.safeParse(raw);
	if (!response.success) {
		throw new HydraProtocolError('Hydra protocol parameters failed schema validation', { cause: response.error });
	}
	const rawParameters = response.data;

	const parameters: Protocol = castProtocol({
		coinsPerUtxoSize: rawParameters.utxoCostPerByte,
		collateralPercent: rawParameters.collateralPercentage,
		maxBlockExMem: String(rawParameters.maxBlockExecutionUnits.memory),
		maxBlockExSteps: String(rawParameters.maxBlockExecutionUnits.steps),
		maxBlockHeaderSize: rawParameters.maxBlockHeaderSize,
		maxBlockSize: rawParameters.maxBlockBodySize,
		maxCollateralInputs: rawParameters.maxCollateralInputs,
		maxTxExMem: String(rawParameters.maxTxExecutionUnits.memory),
		maxTxExSteps: String(rawParameters.maxTxExecutionUnits.steps),
		// Capped, so builders never aim above the shipped limit on a head started
		// on the older 16,384. Drift is reported from the raw value above.
		maxTxSize: Math.min(rawParameters.maxTxSize, EXPECTED_MAX_TX_SIZE),
		maxValSize: rawParameters.maxValueSize,
		minFeeA: rawParameters.txFeePerByte,
		minFeeB: rawParameters.txFeeFixed,
		minPoolCost: String(rawParameters.minPoolCost),
		poolDeposit: rawParameters.stakePoolDeposit,
		priceMem: rawParameters.executionUnitPrices.priceMemory,
		priceStep: rawParameters.executionUnitPrices.priceSteps,
	});

	return parameters;
}

export async function fetchHydraRawCostModels(transport: HydraQueryTransport): Promise<HydraRawCostModels> {
	// `/protocol-parameters` returns the Cardano-API ProtocolParameters JSON
	// the head was configured with; its `costModels` field carries the exact
	// per-language arrays the head's ledger hashes into the script-data-hash.
	// castProtocol() (used by fetchHydraProtocolParameters above) drops these, so
	// fetch the raw payload and extract them here.
	const response = hydraCostModelsEnvelopeSchema.safeParse(await transport.get('/protocol-parameters'));
	if (!response.success) {
		throw new HydraProtocolError('Hydra cost-model response failed schema validation', { cause: response.error });
	}
	const costModels = response.data.costModels;
	const parseCostModel = (language: string, value: unknown): number[] | undefined => {
		if (value === undefined) return undefined;
		const parsedCostModel = hydraCostModelSchema.safeParse(value);
		if (!parsedCostModel.success) {
			throw new HydraProtocolError(`Hydra ${language} cost model failed schema validation`, {
				cause: parsedCostModel.error,
			});
		}
		return parsedCostModel.data;
	};
	return {
		PlutusV1: parseCostModel('PlutusV1', costModels?.PlutusV1),
		PlutusV2: parseCostModel('PlutusV2', costModels?.PlutusV2),
		PlutusV3: parseCostModel('PlutusV3', costModels?.PlutusV3),
	};
}

/**
 * The node's own latest confirmed snapshot number, read from `GET /snapshot`.
 * Unlike the replayed or persisted copies, this cannot lag the node itself.
 */
export async function fetchHydraConfirmedSnapshotNumber(
	transport: HydraQueryTransport,
): Promise<{ headId: string; number: bigint }> {
	const response = hydraConfirmedSnapshotSchema.safeParse(await transport.get('/snapshot'));
	if (!response.success) {
		throw new HydraProtocolError('Hydra confirmed snapshot response failed schema validation', {
			cause: response.error,
		});
	}
	const data = response.data;
	return data.tag === 'ConfirmedSnapshot'
		? { headId: data.snapshot.headId, number: BigInt(data.snapshot.number) }
		: { headId: data.headId, number: 0n };
}

/** `last-seen` tags that mean no snapshot round is in flight. Kept in sync with hydra-host's drain gate. */
const IDLE_SNAPSHOT_ROUND_TAGS = new Set(['LastSeenSnapshot', 'NoSeenSnapshot']);

/** `last-seen` tags for which this node has not signed the round in flight, if there is one. */
const UNSIGNED_SNAPSHOT_ROUND_TAGS = new Set([...IDLE_SNAPSHOT_ROUND_TAGS, 'RequestedSnapshot']);

/** A deposit a snapshot holds in `utxoToCommit`: its transaction id, lowercase, or null when the snapshot names none. */
export type HydraAcknowledgedDeposit = string | null;

function heldDeposits(snapshot: {
	utxoToCommit?: object | null;
	depositTxId?: string | null;
}): HydraAcknowledgedDeposit[] {
	const holdsDeposit = snapshot.utxoToCommit != null && Object.keys(snapshot.utxoToCommit).length > 0;
	return holdsDeposit ? [snapshot.depositTxId ?? null] : [];
}

/** The deposit the latest confirmed snapshot holds, from `GET /snapshot`. */
async function fetchConfirmedSnapshotDeposits(
	transport: HydraQueryTransport,
	roundTag: string,
): Promise<HydraAcknowledgedDeposit[]> {
	let body: unknown;
	try {
		body = await transport.get('/snapshot');
	} catch (error) {
		// hydra-node answers 404 only for an Idle head (`getConfirmedSnapshot` in
		// Hydra/API/ServerOutput.hs), which is where a head ends after fanout, and
		// an Idle head reports `NoSeenSnapshot`. No head is left to wedge then, and
		// recovery is the only way back for the funds. A 404 next to any other
		// round tag did not come from the node, so it is not read as Idle.
		if (error instanceof HydraHttpResponseError && error.status === 404 && roundTag === 'NoSeenSnapshot') {
			return [];
		}
		throw error;
	}
	const confirmed = hydraAcknowledgedDepositSchema.safeParse(body);
	if (!confirmed.success) {
		throw new HydraProtocolError('Hydra snapshot deposit response failed schema validation', {
			cause: confirmed.error,
		});
	}
	return confirmed.data.tag === 'ConfirmedSnapshot' ? heldDeposits(confirmed.data.snapshot) : [];
}

/**
 * The deposits the head has acknowledged: the one the latest confirmed snapshot
 * holds, and the one in a round this node has already signed.
 *
 * Once a signed snapshot carries `utxoToCommit`, recovering that deposit can
 * stop an open head from confirming any later snapshot
 * (docs/hydra-persistence-recovery-verification.md, findings 12 and 17). A round this
 * node has not signed cannot confirm a deposit the node would recover:
 * hydra-node 2.4.1 expires a deposit one deposit period before the deadline a
 * recovery waits for, and rejects a snapshot request for an expired one.
 *
 * `last-seen` is read first: a signed round that confirms between the two reads
 * then shows up in `GET /snapshot`, instead of slipping past both. Throws on a
 * malformed answer or an unknown round tag, so a caller can refuse rather than
 * guess.
 */
export async function fetchHydraAcknowledgedDeposits(
	transport: HydraQueryTransport,
): Promise<HydraAcknowledgedDeposit[]> {
	const seen = hydraSeenDepositSchema.safeParse(await transport.get('/snapshot/last-seen'));
	if (!seen.success) {
		throw new HydraProtocolError('Hydra last-seen snapshot deposit response failed schema validation', {
			cause: seen.error,
		});
	}
	const acknowledged = await fetchConfirmedSnapshotDeposits(transport, seen.data.tag);
	if (UNSIGNED_SNAPSHOT_ROUND_TAGS.has(seen.data.tag)) return acknowledged;
	if (seen.data.tag !== 'SeenSnapshot' || seen.data.snapshot === undefined) {
		throw new HydraProtocolError(`Hydra snapshot round ${seen.data.tag} does not show the snapshot it signs`);
	}
	return [...acknowledged, ...heldDeposits(seen.data.snapshot)];
}

/** The snapshot round a node reports in flight, reduced to what identifies it. */
export type HydraSnapshotRound = {
	/** False only for a tag known to mean idle. An unknown tag counts as in flight. */
	inFlight: boolean;
	tag: string;
	/** The snapshot number under signature, when the node names one. */
	number: number | null;
	/** Parties that have signed it so far. A new signature means the round is moving. */
	signatoryCount: number;
	/** Transactions the round would confirm. */
	txIds: string[];
	/** Changes whenever the round moves, so an unchanged value over time means it is stuck. */
	signature: string;
};

/** The node's snapshot round in flight, from `GET /snapshot/last-seen`. Throws on a malformed answer. */
export async function fetchHydraSnapshotRound(transport: HydraQueryTransport): Promise<HydraSnapshotRound> {
	const response = hydraLastSeenSnapshotSchema.safeParse(await transport.get('/snapshot/last-seen'));
	if (!response.success) {
		throw new HydraProtocolError('Hydra last-seen snapshot response failed schema validation', {
			cause: response.error,
		});
	}
	const data = response.data;
	const inFlight = !IDLE_SNAPSHOT_ROUND_TAGS.has(data.tag);
	const number = data.snapshot?.number ?? (inFlight ? (data.requested ?? null) : null);
	const signatoryCount = Object.keys(data.signatories ?? {}).length;
	return {
		inFlight,
		tag: data.tag,
		number,
		signatoryCount,
		txIds: (data.snapshot?.confirmed ?? []).map((tx) => tx.txId.toLowerCase()),
		signature: `${data.tag}|${number ?? '-'}|${signatoryCount}`,
	};
}

export async function fetchHydraSnapshotUTxO(transport: HydraQueryTransport): Promise<UTxO[]> {
	const response = hydraSnapshotUtxoSchema.safeParse(await transport.get('/snapshot/utxo'));
	if (!response.success) {
		throw new HydraProtocolError('Hydra snapshot UTxO response failed schema validation', {
			cause: response.error,
		});
	}
	return Object.keys(response.data).map((txId: string) => mapHydraUTxOToUTxO(txId, response.data[txId] as HydraUTxO));
}

/**
 * The L1 transaction that produced the head's current state output.
 *
 * At the moment the head reaches `Closed`, before any fanout step, this is
 * the close transaction — the one thing `HeadIsClosed` does not carry. After
 * a partial fanout it becomes that step's transaction instead, so callers
 * must capture it on the transition and not re-derive it later.
 *
 * Returns undefined rather than throwing on any failure: this names a
 * transaction for operators, and a head whose close cannot be named must
 * still be allowed to close.
 */
export async function fetchHydraHeadOutputTxId(
	transport: HydraQueryTransport,
	headIdentifier: string,
): Promise<string | undefined> {
	try {
		return extractHeadOutputTxId(await transport.get('/head'), headIdentifier);
	} catch (error) {
		logger.warn('[HydraNode] Could not read the head state output transaction', {
			headIdentifier,
			error: protocolErrorToString(error),
		});
		return undefined;
	}
}

/**
 * Output references the head's confirmed snapshot is still waiting to
 * decommit onto L1. See `extractPendingDecommitRefs`.
 *
 * `undefined`, never `[]`, when the node cannot be reached or refuses the
 * request. An empty list is the caller's permission to start an in-head
 * transaction, and one started while a decommit is pending is accepted but
 * never snapshot-confirmed. Refusing costs a retry: the decommit request goes
 * over this same HTTP API.
 *
 * A response over the byte limit is `[]` instead. It stays over on every
 * retry, and `/head` carries the whole snapshot more than once, so refusing on
 * it would block every withdrawal and consolidation from a large head. Same
 * reason `extractPendingDecommitRefs` clears on a shape it does not recognise.
 * Invalid JSON throws the same error class and clears too; a working node does
 * not send it. So does the persistence-rotation latch `HydraNode.get` throws
 * before any request, which is harmless: it also rejects every `post` and
 * `newTx`, so nothing reaches the head.
 */
export async function fetchHydraPendingDecommitRefs(transport: HydraQueryTransport): Promise<string[] | undefined> {
	try {
		return extractPendingDecommitRefs(await transport.get('/head'));
	} catch (error) {
		const isUnusableAnswer = error instanceof HydraProtocolError;
		logger.warn('[HydraNode] Could not read the head state for a pending decommit', {
			error: protocolErrorToString(error),
			treatedAs: isUnusableAnswer ? 'nothing pending' : 'unknown',
		});
		return isUnusableAnswer ? [] : undefined;
	}
}

/** See `extractDecommitInFlight`. `undefined`, never `false`, when the node cannot be read. */
export async function fetchHydraDecommitInFlight(transport: HydraQueryTransport): Promise<boolean | undefined> {
	try {
		return extractDecommitInFlight(await transport.get('/head'));
	} catch (error) {
		logger.warn('[HydraNode] Could not read the head state for a withdrawal in flight', {
			error: protocolErrorToString(error),
		});
		return undefined;
	}
}

/** The `/commit` request body: bare UTxOs, or a blueprint plus the UTxOs it spends. */
export function buildHydraCommitRequest(utxos: UTxO[], blueprintTx?: string | null): unknown {
	const hydraUTxOs = utxos.reduce(
		(acc, utxo) => {
			acc[`${utxo.input.txHash}#${utxo.input.outputIndex}`] = mapUTxOToHydraUTxO(utxo);
			return acc;
		},
		{} as Record<string, HydraUTxO>,
	);
	return blueprintTx ? { blueprintTx, utxo: hydraUTxOs } : hydraUTxOs;
}
