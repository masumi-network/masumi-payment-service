/* eslint-disable @typescript-eslint/prefer-promise-reject-errors */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { EventEmitter } from 'node:events';
import { castProtocol, Protocol, resolveTxHash, UTxO } from '@meshsdk/core';

import { mapHydraUTxOToUTxO, mapUTxOToHydraUTxO } from './codec';
import { Connection } from './connection';
import { hydraHeadStatusSchema, messageSchema, snapshotConfirmedMessageSchema } from './schemas';
import { HydraNodeEvent, HydraTransaction, HydraUTxO, StatusChangeData } from './types';
import { jsonToString } from '@/utils/converter/json-to-string';
import { HydraHeadStatus } from '@/generated/prisma/client';

export interface IHydraNode {
	connect(): void | Promise<void>;
	init(): Promise<unknown>;
	commit(utxos: UTxO[], blueprintTx?: string): Promise<HydraTransaction>;
	cardanoTransaction(transaction: HydraTransaction): Promise<unknown>;
	snapshotUTxO(): Promise<UTxO[]>;
	fetchProtocolParameters(): Promise<Protocol>;
	newTx(transaction: HydraTransaction): Promise<string>;
	isTxConfirmed(txHash: string): boolean;
	awaitTx(txHash: string, checkInterval?: number): Promise<boolean>;
	close(): Promise<unknown>;
	fanout(): Promise<unknown>;

	get(url: string): Promise<any>;
	post(url: string, payload: unknown): Promise<any>;

	get status(): HydraHeadStatus;
	get httpUrl(): string;
	get wsUrl(): string;
}

export class HydraNode extends EventEmitter {
	private readonly _httpUrl: string;
	private readonly _wsUrl: string;
	private _status: HydraHeadStatus;
	private readonly _connection: Connection;
	private readonly _txCircularBuffer: CircularBuffer<string>;

	constructor(config: { httpUrl: string; wsUrl?: string }) {
		super();
		this._httpUrl = config.httpUrl;
		this._wsUrl = config.wsUrl ?? config.httpUrl.replace('http://', 'ws://').replace('https://', 'wss://');
		this._status = HydraHeadStatus.Disconnected;
		this._connection = new Connection(this._wsUrl + '?history=no');
		this._txCircularBuffer = new CircularBuffer(1000);
	}

	connect() {
		if (this._status === HydraHeadStatus.Disconnected) {
			this._connection.on('message', (data) => this.processStatus(data));
			this._connection.on('message', (data) => void this.processConfirmedTx(data));
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
				parsedMessage.snapshot.confirmed.forEach((tx) => {
					this._txCircularBuffer.add(tx.txId);
					this.emit(HydraNodeEvent.TxConfirmed, tx.txId);
				});
			}
		} catch (error) {
			console.error('[HydraNode] Error processing confirmed tx', error);
			throw error;
		}
	}

	async init() {
		this._connection.send({ tag: 'Init' });

		return new Promise<void>((resolve, reject) => {
			const resolveCallback = (data: string) => {
				const rejectCb = (reason?: unknown) => {
					this._connection.removeListener('message', resolveCallback);
					reject(reason);
				};

				const message = handleWsResponse(data, 'Init', rejectCb);
				if (message.tag === 'HeadIsInitializing') {
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

		const response = await this.post('/commit', bodyRequest);
		return response as HydraTransaction;
	}

	async cardanoTransaction(transaction: HydraTransaction) {
		const response = await this.post('/cardano-transaction', transaction);
		return response;
	}

	async snapshotUTxO(): Promise<UTxO[]> {
		const response = await this.get('/snapshot/utxo');
		const utxos = Object.keys(response).map((txId: string) => mapHydraUTxOToUTxO(txId, response[txId] as HydraUTxO));
		return utxos;
	}

	async fetchProtocolParameters() {
		const response = await this.get('/protocol-parameters');

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

	async get(url: string): Promise<any> {
		const body = await fetch(this._httpUrl + url, {
			method: 'GET',
			headers: { 'Content-Type': 'application/json' },
		});
		return await handleHttpResponse(body);
	}

	async post(url: string, payload: unknown): Promise<any> {
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
