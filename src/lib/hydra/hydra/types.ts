import { HydraHeadStatus } from '@/generated/prisma/client';

export enum MessageTag {
	Greetings = 'Greetings',
	Init = 'Init',
	Abort = 'Abort',
	NewTx = 'NewTx',
	Recover = 'Recover',
	Decommit = 'Decommit',
	Close = 'Close',
	Contest = 'Contest',
	Fanout = 'Fanout',

	NetworkConnected = 'NetworkConnected',
	NetworkDisconnected = 'NetworkDisconnected',
	PeerConnected = 'PeerConnected',
	PeerDisconnected = 'PeerDisconnected',

	HeadIsInitializing = 'HeadIsInitializing',
	Committed = 'Committed',
	HeadIsOpen = 'HeadIsOpen',
	HeadIsClosed = 'HeadIsClosed',
	HeadIsContested = 'HeadIsContested',
	ReadyToFanout = 'ReadyToFanout',
	HeadIsAborted = 'HeadIsAborted',
	HeadIsFinalized = 'HeadIsFinalized',

	TxValid = 'TxValid',
	TxInvalid = 'TxInvalid',
	SnapshotConfirmed = 'SnapshotConfirmed',

	CommitFinalized = 'CommitFinalized',
	CommitRecovered = 'CommitRecovered',

	InvalidInput = 'InvalidInput',
	PostTxOnChainFailed = 'PostTxOnChainFailed',
	CommandFailed = 'CommandFailed',
}

export enum HydraHeadEvent {
	MainNodeConnected = 'MainNodeConnected',
	MainNodeDisconnected = 'MainNodeDisconnected',
	StatusChange = 'StatusChange',
}

export enum HydraNodeEvent {
	StatusChange = 'StatusChange',
	TxConfirmed = 'TxConfirmed',
}

export interface StatusChangeData {
	status: HydraHeadStatus;
	headId?: string;
	snapshotNumber?: number;
	contestationDeadline?: string;
}

export enum HydraTransactionType {
	TxConwayEra = 'Tx ConwayEra',
	UnwitnessedTxConwayEra = 'Unwitnessed Tx ConwayEra',
	WitnessedTxConwayEra = 'Witnessed Tx ConwayEra',
}

export type HydraTransaction = {
	type: HydraTransactionType;
	cborHex: string;
	description: string;
	txId?: string;
};

export enum HydraScriptLanguage {
	SimpleScript = 'SimpleScript',
	PlutusScriptV1 = 'PlutusScriptV1',
	PlutusScriptV2 = 'PlutusScriptV2',
	PlutusScriptV3 = 'PlutusScriptV3',
}

export type HydraScript = {
	cborHex: string;
	description: string;
	type: HydraScriptLanguage;
};

export type HydraReferenceScript = {
	scriptLanguage: string;
	script: HydraScript;
};

export type HydraValue = Record<string, number>;

export type HydraUTxO = {
	address: string;
	value: HydraValue;
	referenceScript: HydraReferenceScript | null;
	datumhash: string | null;
	inlineDatum: object | null;
	inlineDatumRaw: string | null;
	datum: string | null;
};

export type HydraWallet = {
	paymentKey: string;
	verificationKey: string;
	address: string;
};

/**
 * In this type, fundWallet and nodeWallet are the same wallets in most of the cases.
 * And walletId is the ID from database for the HotWallet.
 * fundWallet and nodeWallet are optional -- only needed when building/signing transactions.
 */
export type HydraNodeConfig = {
	httpUrl: string;
	walletId: string;
	fundWallet?: HydraWallet;
	nodeWallet?: HydraWallet;
};
