/**
 * Read-side Control Plane queries against a Hydra node's HTTP endpoint, and
 * the request bodies the write side posts. Pure functions over the minimal
 * `get`/`post` surface, so they can be exercised without a session.
 */

import { Protocol, UTxO, castProtocol } from '@meshsdk/core';
import { logger } from '@masumi/payment-core/logger';
import { mapHydraUTxOToUTxO, mapUTxOToHydraUTxO } from './codec';
import { HydraProtocolError } from './errors';
import { extractHeadOutputTxId } from './head-output-tx';
import { protocolErrorToString } from './node-frames';
import { type HydraRawCostModels } from './node-api';
import { reportParamsDrift } from './params-drift';
import {
	hydraCostModelSchema,
	hydraCostModelsEnvelopeSchema,
	hydraProtocolParametersSchema,
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
		maxTxSize: rawParameters.maxTxSize,
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
