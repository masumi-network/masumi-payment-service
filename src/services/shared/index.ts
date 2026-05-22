export type { JobDefinition } from './job-runner';
export { withJobLock } from './job-runner';
export { createApiClient, createMeshProvider } from './provider-factory';
// Re-export mesh classes and types so Type-specific service packages can pin to the
// root workspace's mesh version even when the package itself depends on a different
// mesh release for contract-script generation. V1 stays on @meshsdk/core 1.9.0-beta.96
// for on-chain address determinism; V2 tracks the latest. Both consume these via the
// shared re-export to avoid duplicate class identity errors AND cross-version CBOR
// codec drift (Transaction built with one mesh's cardano-sdk and signed by another
// produces signatures whose body-hash may not validate on chain). All V2 service code
// that constructs transactions or holds provider/wallet instances must import via
// this module rather than directly from @meshsdk/core.
export type { BlockfrostProvider, MeshWallet } from '@meshsdk/core';
export { MeshTxBuilder, Transaction } from '@meshsdk/core';
export type { WalletSession } from './wallet-session';
export { loadHotWalletSession } from './wallet-session';
export type { TxWindow } from './tx-window';
export { createTxWindow } from './tx-window';
export {
	connectExistingTransaction,
	connectPreviousAction,
	createNextPaymentAction,
	createNextPurchaseAction,
	createPendingTransaction,
	updateCurrentTransactionHash,
	updateCurrentTransactionStatus,
} from './transition-writer';
