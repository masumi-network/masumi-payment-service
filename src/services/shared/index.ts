export type { JobDefinition } from './job-runner';
export { withJobLock } from './job-runner';
export { createApiClient, createMeshProvider } from './provider-factory';
export { fetchAddressBalance, fetchAddressBalanceMap, toBalanceMapFromAddressAmounts } from './address-balance';
export type { AddressBalanceAmount, AddressBalanceMap } from './address-balance';
// CAUTION — partial ADR-0005 (`docs/adr/0005-meshsdk-version-pinning-v1-v2.md`)
// boundary. This file lives at the repo root, whose `package.json` pins
// `@meshsdk/core@1.9.0-beta.96` (V1 mesh). The re-exports below therefore
// resolve to V1 mesh classes regardless of which package consumes them.
//
// Allowed uses from V2 service code:
//   - `BlockfrostProvider`, `MeshWallet` (interfaces — no CBOR encoding)
//   - `Transaction`, `MeshTxBuilder` for **value-transfer txs without datums**
//     (e.g. wallet self-transfer prep tx in `ensure-collateral-ready.ts`,
//     buyer→script funding in `batch-payments/service.ts`, the 402-payment
//     envelope in `x402-build/service.ts`). Pure value tx CBOR is stable
//     across the two mesh lines in use today (1.9.0-beta.96 ↔ .102).
//
// FORBIDDEN from V2 service code:
//   - Building script-spending txs with this `MeshTxBuilder`. V2 contract
//     interactions MUST go through `packages/payment-source-v2/src/builders/`
//     which import mesh DIRECTLY (resolves to V2's pinned 1.9.0-beta.102).
//     Script-data-hash + datum/redeemer CBOR drifts between mesh lines and
//     submission with the wrong line fails phase-1 with
//     `PPViewHashesDontMatch` or similar.
//
// Rationale for the shared re-export at all: passing a `MeshWallet` produced
// by `loadHotWalletSession` (which uses V1 mesh) into a V2-mesh constructor
// would trigger `instanceof` mismatches because the two mesh lines export
// distinct classes with identical names. Consistency around the value-tx
// wrappers below avoids that — at the cost of the partial-ADR-0005 carve-out
// documented here.
export type { BlockfrostProvider, MeshWallet } from '@meshsdk/core';
export { MeshTxBuilder, Transaction } from '@meshsdk/core';
export type { WalletSession } from './wallet-session';
export { loadHotWalletSession } from './wallet-session';
export type { TxWindow } from './tx-window';
export { createTxWindow } from './tx-window';
export { runSubmitResultSubmissionLifecycle, type SubmitResultSubmissionOutcome } from './submit-result-lifecycle';
export {
	connectExistingNextPaymentAction,
	connectExistingNextPurchaseAction,
	connectExistingTransaction,
	connectPreviousAction,
	createNextPaymentAction,
	createNextPurchaseAction,
	createPendingTransaction,
	disconnectTransactionWallet,
	safeDeleteOrphanNextPaymentAction,
	safeDeleteOrphanNextPurchaseAction,
	updateCurrentTransactionHash,
	updateCurrentTransactionStatus,
} from './transition-writer';
