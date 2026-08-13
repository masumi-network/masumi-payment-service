/**
 * What the Hydra API returns, as the admin UI reads it.
 *
 * Types only, so anything may import them without pulling in a query client.
 * Split out of `useHydraHeads` when that file passed the size limit: the hooks
 * split by what they do, and every one of them needed these.
 */

export type HydraHeadStatus =
  | 'Disconnected'
  | 'Connected'
  | 'Connecting'
  | 'Idle'
  | 'Initializing'
  | 'Open'
  | 'Closed'
  | 'FanoutPossible'
  | 'Final';

export type HydraParticipant = {
  id: string;
  createdAt: string;
  updatedAt?: string;
  hydraHeadId?: string | null;
  walletId: string;
  Wallet: {
    walletVkey: string;
    walletAddress: string;
    collectionAddress: string | null;
    note: string | null;
    type: 'Purchasing' | 'Selling' | 'Funding';
  };
  /** The head this node serves, when it has one. */
  HydraHead?: { status: HydraHeadStatus } | null;
  nodeUrl: string;
  nodeHttpUrl: string;
  hasCommitted: boolean;
  commitTxHash: string | null;
  /**
   * The node's own Cardano key hash, the head's on-chain identity, kept
   * separate from the settling wallet so a node compromise cannot reach funds.
   */
  cardanoVkey?: string;
  /** Which connected node runs this participant's hydra-node process. */
  hydraHostId?: string;
  hostNodeId?: string;
  /** Null until an operator has taken the one-time backup of this node's keys. */
  keysDisclosedAt?: string | null;
};

export type HydraNodeKeys = {
  id: string;
  disclosedAt: string;
  hydraSigningKey: string;
  cardanoSigningKey: string | null;
};

/**
 * The counterparty's node, as agreed in the handshake.
 *
 * No node URL: their API sits behind their own Host's proxy and we hold no
 * token for it. What we have is the peer-plane address etcd dials.
 */
export type HydraRemoteParticipant = Omit<
  HydraParticipant,
  'nodeUrl' | 'nodeHttpUrl' | 'Wallet'
> & {
  Wallet: {
    walletVkey: string;
    walletAddress: string;
  };
  advertise: string;
  /** The counterparty node's Hydra verification key (cborHex). */
  HydraVerificationKey: { hydraVK: string };
};

export type HydraHead = {
  id: string;
  createdAt: string;
  updatedAt: string;
  hydraRelationId: string;
  headIdentifier: string | null;
  status: HydraHeadStatus;
  contestationPeriod: string;
  isEnabled: boolean;
  openedAt: string | null;
  closedAt: string | null;
  finalizedAt: string | null;
  contestationDeadline: string | null;
  latestActivityAt: string | null;
  latestSnapshotNumber: string;
  initTxHash: string | null;
  closeTxHash: string | null;
  fanoutTxHash: string | null;
  /** Absent for heads that predate invites; decides which side may Init. */
  Invite?: {
    role: 'Issuer' | 'Redeemer';
    /** Agreed when the invite was issued; unchangeable for the head's life. */
    contestationPeriodSeconds: number;
    depositPeriodSeconds: number;
    unsyncedPeriodSeconds: number;
  } | null;
  LocalParticipant?: HydraParticipant | null;
  RemoteParticipants?: HydraRemoteParticipant[];
  _count?: {
    Errors: number;
    Transactions: number;
  };
};

export type HydraWalletSummary = {
  id: string;
  walletVkey: string;
  walletAddress: string;
  type: string;
  note: string | null;
};

export type HydraRelation = {
  id: string;
  createdAt: string;
  updatedAt: string;
  network: 'Preprod' | 'Mainnet';
  localHotWalletId: string;
  remoteWalletId: string;
  counterpartyBaseUrl: string | null;
  LocalHotWallet?: HydraWalletSummary;
  RemoteWallet?: HydraWalletSummary;
  _count?: {
    Heads: number;
  };
};

export type HydraWalletBase = {
  id: string;
  createdAt: string;
  updatedAt: string;
  paymentSourceId: string;
  type: string;
  walletVkey: string;
  walletAddress: string;
  note: string | null;
  PaymentSource: {
    id: string;
    network: 'Preprod' | 'Mainnet';
    paymentSourceType: string;
  };
};

export type HydraNodeCheckResult = {
  reachable: boolean;
  protocolParametersOk: boolean;
  websocketReachable: boolean;
  httpStatus: number | null;
  status: HydraHeadStatus | null;
  checkedAt: string;
  error: string | null;
};

export type CreateHydraRelationPayload = {
  network: 'Preprod' | 'Mainnet';
  localHotWalletId: string;
  remoteWalletId: string;
  /** Where this relation's head offers are delivered. */
  counterpartyBaseUrl: string;
};

export type HydraTopupResult = {
  headId: string;
  topupId: string;
  depositTxHash: string;
  confirmed: boolean;
  committedLovelace: string;
  committedAssets: Record<string, string>;
  /**
   * When the deposit may be sent back. Null until the head has stated it.
   *
   * NOT the last moment it might still be absorbed — that is `absorbBy`, a
   * whole deposit period earlier.
   */
  deadline?: string | null;
  /** Before this, the head will not take it however confirmed the transaction is. */
  usableFrom?: string | null;
  /** After this the head will no longer absorb it, and recovery is not yet open. */
  absorbBy?: string | null;
};

export type HydraTopupRequest = {
  headId: string;
  /** Ignored when assetUnit is set. */
  assetFilter?: 'all' | 'ada-only';
  /** policyId+assetName hex; commit only UTxOs containing this token. */
  assetUnit?: string;
  /** Exact amount (base unit) to pre-split then commit; overrides the filter. */
  exactAmount?: string;
};

export type HydraHeadBalanceAsset = {
  /** Empty string for ADA/lovelace; otherwise policyId+assetName hex. */
  unit: string;
  quantity: string;
};

export type HydraHeadBalance = {
  hydraHeadId: string;
  address: string;
  /** False when the head has no live connection (balance unknown, not zero). */
  connected: boolean;
  utxoCount: number;
  /**
   * Lovelace the head reports holding that L1 no longer backs.
   *
   * hydra-node can keep a deposit in its L2 ledger that was never really
   * absorbed, so the balance reads high by this much.
   */
  unbackedLovelace?: string;
  hasUnbackedUtxos?: boolean;
  balance: HydraHeadBalanceAsset[];
};

/**
 * Everything about invites.
 *
 * A head is opened by issuing an invite and having someone redeem it, or by
 * redeeming theirs, there is no other path. Relations are a consequence of a
 * redemption rather than something created here.
 */
export type HydraInvite = {
  id: string;
  nonce: string;
  network: 'Preprod' | 'Mainnet';
  role: 'Issuer' | 'Redeemer';
  status: 'Issued' | 'Redeemed' | 'Started' | 'Completed' | 'Expired' | 'Revoked';
  createdAt: string;
  expiresAt: string;
  hydraHostId: string;
  hostNodeId: string;
  issuerWalletAddress: string;
  issuerExchangeUrl: string;
  redeemedAt: string | null;
  redeemerWalletAddress: string | null;
  hydraHeadId: string | null;
};

export type HydraInvitePreview = {
  nonce: string;
  network: 'Preprod' | 'Mainnet';
  issuerWalletAddress: string;
  /** Which side the issuer takes. Ours has to be the other one. */
  issuerWalletRole?: 'Buyer' | 'Seller';
  advertise: string;
  exchangeUrl: string;
  expiresAt: string;
  contestationPeriodSeconds: number;
  depositPeriodSeconds: number;
  unsyncedPeriodSeconds: number;
  exchangeUsesPrivateNetwork: boolean | null;
  exchangeNetworkWarning: string | null;
  signatureValid: boolean;
  alreadyKnown: boolean;
  identity: {
    policyId: string;
    entries: { unit: string; assetName: string; name: string | null }[];
    lookupError: string | null;
  };
};

/**
 * Top up the node's own Cardano key.
 *
 * A node cannot open a head from an empty address, Init consumes a seed UTxO
 * there, so a freshly provisioned node fails with `NoSeedInput` until this has
 * run. A scheduled cycle does it too; this is for not waiting.
 */
export type HydraHeadError = {
  id: string;
  errorType: string;
  errorMessage: string;
  headStatus: string;
  clientInput: string | null;
  txHash: string | null;
  errorAt: string;
};

export type HydraHeadTransaction = {
  id: string;
  /** What kind of money movement this row is. Absent on older payloads. */
  kind?: 'Ledger' | 'Deposit' | 'NodeFunding';
  /** Amount moved, for deposits and node funding. */
  lovelace?: string | null;
  createdAt: string;
  txHash: string | null;
  intendedTxHash: string | null;
  status: string;
  layer: 'L1' | 'L2';
  confirmations: number | null;
  fees: string | null;
  blockTime: number | null;
  lastCheckedAt: string | null;
};

export type HydraHeadConnection = {
  /** Whether our node is in the Hydra cluster, so the counterparty's node is reachable. */
  peerConnected?: boolean | null;
  headId: string;
  connected: boolean;
  nodeState: string;
  isReady: boolean;
  reason: string | null;
  /**
   * Ways the head's own ledger no longer matches the chain it settles on.
   *
   * Empty in the normal case. A head's ledger is frozen when it opens, so a
   * chain that moves afterwards can leave the head holding outputs L1 will
   * refuse to take back at settlement.
   */
  paramDrift?: Array<{ parameter: string; head: number; chain: number; blocksFanout: boolean }>;
  /**
   * Why this node cannot act inside the head, though the head itself is fine.
   *
   * Null in the normal case. A participant holding no funds inside the head can
   * lock, submit and collect nothing: every action from this side spends a
   * script output and needs one of its own in-head outputs for collateral.
   */
  l2Blocked?: string | null;
  /**
   * What closing this head right now would cost, or null when it holds nothing.
   *
   * Non-null means the API will refuse a close that does not acknowledge it, and
   * this is the wording of that refusal. Read before offering the action so the
   * confirmation can state the cost rather than the operator meeting it as a
   * failure.
   */
  closeWithActiveWork?: string | null;
  checkedAt: string;
};

export type HydraTopup = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'Preparing' | 'Pending' | 'Confirmed' | 'Failed' | 'Recovered' | 'Absorbed';
  /** Null until the deposit is built; a preparing top-up has no deposit yet. */
  depositTxHash: string | null;
  /** The L1 split that carves the exact amount, present while preparing. */
  splitTxHash?: string | null;
  committedLovelace: string;
  committedAssets: Record<string, string>;
  /**
   * When the deposit may be sent back. Null until the head has stated it.
   *
   * NOT the last moment it might still be absorbed — that is `absorbBy`, a
   * whole deposit period earlier.
   */
  deadline?: string | null;
  /** Before this, the head will not take it however confirmed the transaction is. */
  usableFrom?: string | null;
  /** After this the head will no longer absorb it, and recovery is not yet open. */
  absorbBy?: string | null;
  /**
   * Set once the node has been asked to send this deposit back to the wallet.
   *
   * Read from the record rather than remembered by the page: a recovery leaves
   * no other mark on the deposit, so without this a reload offered the button
   * again at funds already on their way home.
   */
  recoveryRequestedAt?: string | null;
};

export type HydraWithdrawal = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'Preparing' | 'Pending' | 'Approved' | 'Finalized' | 'Failed';
  /** The in-head split that carved the exact amount. Null when whole UTxOs went. */
  splitTxId: string | null;
  decommitTxId: string | null;
  /**
   * The L1 transaction that paid it out, once identified. The head does not
   * report this, so it is observed on chain; null until then.
   */
  l1TxId: string | null;
  requestedLovelace: string;
  /**
   * Native assets that left with it, as unit to quantity. A decommit removes
   * whole outputs, so the lovelace above is what carried them rather than the
   * point of the withdrawal.
   */
  requestedAssets: Record<string, string>;
  /**
   * What actually reached L1, once the withdrawal finalized. Null until then,
   * and routinely different from what was requested: a decommit takes whole
   * outputs and the decrement's fee comes out of the value that travels.
   */
  settledLovelace: string | null;
  settledAssets: Record<string, string> | null;
  destinationAddress: string;
  failureReason: string | null;
  /** The point of no return: the head has signed the removal. */
  approvedAt: string | null;
  /** When the funds became spendable on L1. */
  finalizedAt: string | null;
};

export type HydraNodeFunding = {
  address: string;
  balanceLovelace: string;
  isUnderfunded: boolean;
  shortfallLovelace: string;
  checked: boolean;
  /**
   * Provisioned is not ready: a node must start and sync before it can post.
   *
   * Optional because a service that predates it simply omits it, and the dialog
   * has to keep working against one.
   */
  node?: { state: string; isReady: boolean; reason: string | null };
};
