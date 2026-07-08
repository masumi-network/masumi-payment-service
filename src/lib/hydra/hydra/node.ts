/* eslint-disable @typescript-eslint/prefer-promise-reject-errors */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { EventEmitter } from 'node:events';
import { castProtocol, Protocol, resolveTxHash, UTxO } from '@meshsdk/core';

import { mapHydraUTxOToUTxO, mapUTxOToHydraUTxO } from './codec';
import { Connection } from './connection';
import { headClockMessageSchema, hydraHeadStatusSchema, messageSchema, snapshotConfirmedMessageSchema } from './schemas';
import { HydraNodeEvent, HydraTransaction, HydraUTxO, StatusChangeData } from './types';
import { jsonToString } from '@/utils/converter/json-to-string';
import { HydraHeadStatus } from '@/generated/prisma/client';

/**
 * The head's Plutus cost models, as returned by hydra-node's
 * `/protocol-parameters` endpoint under `costModels`. Same `{ PlutusVN: number[] }`
 * shape Blockfrost returns under `cost_models_raw`, so the V2 cost-model sync
 * helper consumes either source identically. Used to patch the V2 mesh line's
 * bundled `DEFAULT_V*_COST_MODEL_LIST` arrays so an in-head (isHydra) Plutus tx
 * computes a script-data-hash the head's ledger accepts (otherwise:
 * `PPViewHashesDontMatch`). See docs/adr/0005.
 */
export type HydraRawCostModels = {
	PlutusV1?: number[];
	PlutusV2?: number[];
	PlutusV3?: number[];
};

/**
 * The subset of hydra-node's `/protocol-parameters` JSON that
 * `fetchProtocolParameters` reads (Cardano-API ProtocolParameters shape).
 */
type RawHydraProtocolParameters = {
	utxoCostPerByte: number;
	collateralPercentage: number;
	maxBlockExecutionUnits: { memory: number; steps: number };
	maxBlockHeaderSize: number;
	maxBlockBodySize: number;
	maxCollateralInputs: number;
	maxTxExecutionUnits: { memory: number; steps: number };
	maxTxSize: number;
	maxValueSize: number;
	txFeePerByte: number;
	txFeeFixed: number;
	minPoolCost: number;
	stakePoolDeposit: number;
	executionUnitPrices: { priceMemory: number; priceSteps: number };
};

/**
 * The head's last observed L1 chain time, from the API websocket's
 * `Tick`/`SyncedStatusReport` broadcasts. This is the clock the head's ledger
 * checks tx validity intervals against — it can lag wall-clock time by many
 * minutes (Blockfrost-backed chain followers drift), so L2 validity windows
 * must anchor to it, not to `Date.now()`. `receivedAtMs` lets consumers judge
 * staleness.
 */
export interface HydraHeadClock {
	chainTimeMs: number;
	chainSlot?: number;
	receivedAtMs: number;
}

export interface IHydraNode {
	connect(): void | Promise<void>;
	init(): Promise<unknown>;
	commit(utxos: UTxO[], blueprintTx?: string): Promise<HydraTransaction>;
	cardanoTransaction(transaction: HydraTransaction): Promise<unknown>;
	snapshotUTxO(): Promise<UTxO[]>;
	fetchProtocolParameters(): Promise<Protocol>;
	fetchRawCostModels(): Promise<HydraRawCostModels>;
	newTx(transaction: HydraTransaction): Promise<string>;
	isTxConfirmed(txHash: string): boolean;
	awaitTx(txHash: string, checkInterval?: number): Promise<boolean>;
	close(): Promise<unknown>;
	fanout(): Promise<unknown>;

	// Raw hydra-node HTTP responses are untyped JSON; callers pass the expected
	// shape via the type parameter (defaults to `unknown`, forcing narrowing).
	get<T = unknown>(url: string): Promise<T>;
	post<T = unknown>(url: string, payload: unknown): Promise<T>;

	get status(): HydraHeadStatus;
	get httpUrl(): string;
	get wsUrl(): string;
	get headClock(): HydraHeadClock | undefined;
}

export class HydraNode extends EventEmitter {
	private readonly _httpUrl: string;
	private readonly _wsUrl: string;
	private _status: HydraHeadStatus;
	private readonly _connection: Connection;
	private readonly _txCircularBuffer: CircularBuffer<string>;
	private _headClock: HydraHeadClock | undefined;

	constructor(config: { httpUrl: string; wsUrl?: string }) {
		super();
		this._httpUrl = config.httpUrl;
		this._wsUrl = config.wsUrl ?? config.httpUrl.replace('http://', 'ws://').replace('https://', 'wss://');
		this._status = HydraHeadStatus.Disconnected;
		this._connection = new Connection(this._wsUrl + '?history=no');
		this._txCircularBuffer = new CircularBuffer(10000);
	}

	connect() {
		if (this._status === HydraHeadStatus.Disconnected) {
			this._connection.on('message', (data) => this.processStatus(data));
			this._connection.on('message', (data) => void this.processConfirmedTx(data));
			this._connection.on('message', (data) => this.processHeadClock(data));
			void this._connection.connect();
		}
	}

	private processStatus(rawMessage: string) {
		const changeData = extractStatusChangeData(rawMessage);
		if (changeData && changeData.status !== this._status) {
			this._status = changeData.status;
			this.emit(HydraNodeEvent.StatusChange, changeData);
		}
	}

	private async processConfirmedTx(rawMessage: string) {
		try {
			const message = JSON.parse(rawMessage);
			if (message.tag === 'SnapshotConfirmed') {
				const parsedMessage = snapshotConfirmedMessageSchema.parse(message);
				parsedMessage.snapshot.confirmed.forEach((tx: { txId: string }) => {
					this._txCircularBuffer.add(tx.txId);
					this.emit(HydraNodeEvent.TxConfirmed, tx.txId);
				});
			}
		} catch (error) {
			// Never rethrow: this runs as a fire-and-forget ws 'message' handler,
			// so a throw becomes an unhandled rejection that can kill the process
			// on any malformed frame.
			console.error('[HydraNode] Error processing confirmed tx', error);
		}
	}

	private processHeadClock(rawMessage: string) {
		try {
			const parsed = headClockMessageSchema.safeParse(JSON.parse(rawMessage));
			if (!parsed.success) return;
			const chainTimeMs = Date.parse(parsed.data.chainTime);
			if (Number.isNaN(chainTimeMs)) return;
			this._headClock = {
				chainTimeMs,
				chainSlot: parsed.data.chainSlot,
				receivedAtMs: Date.now(),
			};
		} catch {
			// non-JSON frames are other consumers' problem; the clock just skips them
		}
	}

	get headClock(): HydraHeadClock | undefined {
		return this._headClock;
	}

	async init() {
		// The head may already be initializing or open (e.g. on reconnect, or
		// when hydra-node transitions past Initializing before we observe it).
		// The WS is opened with `?history=no`, so a missed HeadIsInitializing is
		// never replayed — guard against waiting forever for a message that has
		// already passed.
		if (this._status === HydraHeadStatus.Initializing || this._status === HydraHeadStatus.Open) {
			return;
		}

		this._connection.send({ tag: 'Init' });

		return new Promise<void>((resolve, reject) => {
			const resolveCallback = (data: string) => {
				const rejectCb = (reason?: unknown) => {
					this._connection.removeListener('message', resolveCallback);
					reject(reason);
				};

				const message = handleWsResponse(data, 'Init', rejectCb);
				// Resolve once the head has reached or passed Initializing.
				// hydra-node 2.x can transition Init -> Open quickly, surfacing
				// only HeadIsOpen (or a Greetings carrying the new headStatus),
				// so accept those as init completion too.
				if (
					message.tag === 'HeadIsInitializing' ||
					message.tag === 'HeadIsOpen' ||
					(message.tag === 'Greetings' && (message.headStatus === 'Initializing' || message.headStatus === 'Open'))
				) {
					this._connection.removeListener('message', resolveCallback);
					resolve();
				}
			};

			this._connection.on('message', resolveCallback);
		});
	}

	async commit(utxos: UTxO[] = [], blueprintTx?: string | null) {
		const hydraUTxOs = utxos.reduce(
			(acc, utxo) => {
				acc[`${utxo.input.txHash}#${utxo.input.outputIndex}`] = mapUTxOToHydraUTxO(utxo);
				return acc;
			},
			{} as Record<string, HydraUTxO>,
		);

		let bodyRequest;
		if (blueprintTx) {
			bodyRequest = {
				blueprintTx,
				utxo: hydraUTxOs,
			};
		} else {
			bodyRequest = hydraUTxOs;
		}

		const response = await this.post<HydraTransaction>('/commit', bodyRequest);
		return response;
	}

	async cardanoTransaction(transaction: HydraTransaction) {
		const response = await this.post('/cardano-transaction', transaction);
		return response;
	}

	async snapshotUTxO(): Promise<UTxO[]> {
		const response = await this.get<Record<string, HydraUTxO>>('/snapshot/utxo');
		const utxos = Object.keys(response).map((txId: string) => mapHydraUTxOToUTxO(txId, response[txId]));
		return utxos;
	}

	async fetchProtocolParameters() {
		const response = await this.get<RawHydraProtocolParameters>('/protocol-parameters');

		const parameters: Protocol = castProtocol({
			coinsPerUtxoSize: Number(response.utxoCostPerByte),
			collateralPercent: Number(response.collateralPercentage),
			maxBlockExMem: String(response.maxBlockExecutionUnits.memory),
			maxBlockExSteps: String(response.maxBlockExecutionUnits.steps),
			maxBlockHeaderSize: Number(response.maxBlockHeaderSize),
			maxBlockSize: Number(response.maxBlockBodySize),
			maxCollateralInputs: Number(response.maxCollateralInputs),
			maxTxExMem: String(response.maxTxExecutionUnits.memory),
			maxTxExSteps: String(response.maxTxExecutionUnits.steps),
			maxTxSize: Number(response.maxTxSize),
			maxValSize: Number(response.maxValueSize),
			minFeeA: Number(response.txFeePerByte),
			minFeeB: Number(response.txFeeFixed),
			minPoolCost: String(response.minPoolCost),
			poolDeposit: Number(response.stakePoolDeposit),
			priceMem: Number(response.executionUnitPrices.priceMemory),
			priceStep: Number(response.executionUnitPrices.priceSteps),
		});

		return parameters;
	}

	async fetchRawCostModels(): Promise<HydraRawCostModels> {
		// `/protocol-parameters` returns the Cardano-API ProtocolParameters JSON
		// the head was configured with; its `costModels` field carries the exact
		// per-language arrays the head's ledger hashes into the script-data-hash.
		// castProtocol() (used by fetchProtocolParameters above) drops these, so
		// fetch the raw payload and extract them here.
		const response = await this.get<{ costModels?: HydraRawCostModels }>('/protocol-parameters');
		const costModels = response?.costModels;
		const toNumberArray = (value: unknown): number[] | undefined => {
			if (!Array.isArray(value)) return undefined;
			const out: number[] = [];
			for (const entry of value) {
				const n = typeof entry === 'number' ? entry : Number(entry);
				if (!Number.isFinite(n)) return undefined;
				out.push(n);
			}
			return out;
		};
		return {
			PlutusV1: toNumberArray(costModels?.PlutusV1),
			PlutusV2: toNumberArray(costModels?.PlutusV2),
			PlutusV3: toNumberArray(costModels?.PlutusV3),
		};
	}

	async newTx(transaction: HydraTransaction) {
		this._connection.send({ tag: 'NewTx', transaction });

		const txHash = resolveTxHash(transaction.cborHex);
		return new Promise<string>((resolve, reject) => {
			const resolveCallback = (data: string) => {
				const rejectCb = (reason?: unknown) => {
					this._connection.removeListener('message', resolveCallback);
					reject(reason);
				};

				const message = handleWsResponse(data, 'NewTx', rejectCb, txHash);
				if (message.tag === 'TxValid' && message.transactionId === txHash) {
					this._connection.removeListener('message', resolveCallback);
					resolve(txHash);
				} else if (message.tag === 'TxInvalid' && message.transaction.txId === txHash) {
					this._connection.removeListener('message', resolveCallback);
					reject(new Error('Transaction is invalid'));
				}
			};

			this._connection.on('message', resolveCallback);
		});
	}

	isTxConfirmed(txHash: string): boolean {
		return this._txCircularBuffer.getBuffer().includes(txHash);
	}

	async awaitTx(txHash: string, checkInterval: number = 1000) {
		return new Promise<boolean>((resolve) => {
			const interval = setInterval(() => {
				if (this._txCircularBuffer.getBuffer().includes(txHash)) {
					resolve(true);
					clearInterval(interval);
				}
			}, checkInterval);
		});
	}

	async close() {
		this._connection.send({ tag: 'Close' });

		return new Promise<void>((resolve, reject) => {
			const interval = setInterval(() => this._connection.send({ tag: 'Close' }), 60000);
			const resolveCallback = (data: string) => {
				const rejectCb = (reason?: unknown) => {
					this._connection.removeListener('message', resolveCallback);
					clearInterval(interval);
					reject(reason);
				};

				const message = handleWsResponse(data, 'Close', rejectCb);
				if (message.tag === 'HeadIsClosed') {
					this._connection.removeListener('message', resolveCallback);
					clearInterval(interval);
					resolve();
				}
			};

			this._connection.on('message', resolveCallback);
		});
	}

	async fanout() {
		this._connection.send({ tag: 'Fanout' });

		return new Promise<void>((resolve, reject) => {
			const resolveCallback = (data: string) => {
				const rejectCb = (reason?: unknown) => {
					this._connection.removeListener('message', resolveCallback);
					reject(reason);
				};

				const message = handleWsResponse(data, 'Fanout', rejectCb, 'Fanout');
				if (message.tag === 'HeadIsFinalized') {
					this._connection.removeListener('message', resolveCallback);
					resolve();
				}
			};

			this._connection.on('message', resolveCallback);
		});
	}

	async get<T = unknown>(url: string): Promise<T> {
		const body = await fetch(this._httpUrl + url, {
			method: 'GET',
			headers: { 'Content-Type': 'application/json' },
		});
		return (await handleHttpResponse(body)) as T;
	}

	async post<T = unknown>(url: string, payload: unknown): Promise<T> {
		const body = await fetch(this._httpUrl + url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: jsonToString(payload),
		});
		return await handleHttpResponse(body);
	}

	get status() {
		return this._status;
	}

	get httpUrl() {
		return this._httpUrl;
	}

	get wsUrl() {
		return this._wsUrl;
	}
}

class CircularBuffer<T> {
	private buffer: T[];
	private length: number;
	private pointer: number;

	constructor(length: number) {
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
}

async function handleHttpResponse(response: Response) {
	try {
		return await response.json();
	} catch (e) {
		if (e instanceof Error && e.name === 'SyntaxError') {
			throw new Error(await response.text());
		} else {
			throw e;
		}
	}
}

function handleWsResponse(rawMessage: string, command: string, reject: (reason?: unknown) => void, ...args: string[]) {
	try {
		const message = JSON.parse(rawMessage);

		if (message.tag === 'CommandFailed' && message.clientInput) {
			if (
				command === 'NewTx' &&
				message.clientInput?.tag === 'NewTx' &&
				message.clientInput?.transaction?.txId === args[0]
			) {
				reject(new Error('Error posting transaction with hash ' + args[0]));
			} else if (message.clientInput?.tag === command) {
				reject(new Error('Command ' + command + ' failed'));
			}
		} else if (message.tag === 'PostTxOnChainFailed' && message.postChainTx?.tag === command + 'Tx') {
			reject(
				new Error(
					`Error posting transaction for command ${command}.\n Error:\n ${JSON.stringify(message.postTxError, null, 2)}`,
				),
			);
		}

		return message;
	} catch (e) {
		if (e instanceof Error && e.name === 'SyntaxError') {
			reject(new Error(rawMessage));
		} else {
			reject(e);
		}
	}
}

function extractStatusChangeData(rawMessage: string): StatusChangeData | null {
	try {
		const message = JSON.parse(rawMessage);
		const parsedMessage = messageSchema.parse(message);
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
			default:
				newStatus = hydraHeadStatusSchema.safeParse(parsedMessage.headStatus).data ?? null;
				break;
		}

		if (!newStatus) return null;

		return {
			status: newStatus,
			headId: parsedMessage.headId ?? parsedMessage.hydraHeadId ?? undefined,
			snapshotNumber: parsedMessage.snapshotNumber,
			contestationDeadline: parsedMessage.contestationDeadline,
		};
	} catch (error) {
		console.error('[HydraNode] Error extracting status from message', error, rawMessage);
		return null;
	}
}
