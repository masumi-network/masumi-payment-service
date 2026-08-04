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
	HistoryReplayFailed = 'HistoryReplayFailed',
	/**
	 * A deposit finished folding in, so its funds are spendable at last.
	 *
	 * Worth an event rather than a poll: work that was waiting on those funds
	 * would otherwise sit until the next batch tick, which is the difference
	 * between a payment settling now and settling in half a minute.
	 */
	IncrementFinalized = 'IncrementFinalized',
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

export type HydraConfirmedTransaction = HydraTransaction & {
	txId: string;
	/** Tx/reference metadata is attested by the configured local node, not Hydra's signed accumulator. */
	metadataSource?: 'ConfiguredLocalHydraNode';
	/** Hydra frame time; null when the confirmation timestamp is unproven. */
	confirmedAtMs: number | null;
	/** TimedServerOutput sequence; null only for live frames (history requires it). */
	snapshotSequence: number | null;
	/** Position inside one SnapshotConfirmed frame. */
	snapshotTransactionIndex: number;
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

export type HydraQuantity = number | bigint;

export type HydraValue = {
	lovelace?: HydraQuantity;
	[policyId: string]: HydraQuantity | Record<string, HydraQuantity> | undefined;
};

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
 * WalletId is the ID from database for the HotWallet.
 */
export type HydraNodeConfig = {
	httpUrl: string;
	wsUrl?: string;
	expectedHeadId?: string;
	reconciledHistoryCursor?: { snapshotSequence: number; snapshotTransactionIndex: number };
	snapshotVerificationKeys?: string[];
	expectedNodeVerificationKey?: string;
	trustLocalNodeSnapshotMetadata?: boolean;
	/**
	 * Bearer token for a node reached through a Hydra Host. Absent for a node on
	 * loopback, which has nothing in front of it to authenticate to. Travels as a
	 * header only — `node-url.ts` rejects credentials embedded in the URL.
	 */
	authToken?: string;
	walletId: string;
};
