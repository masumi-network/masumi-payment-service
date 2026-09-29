# Guarded wallet purchases (Exchain co-sign in the V2 purchase flow)

Status: design approved section by section on 2026-09-29. Implemented on the PR 878 branch; live preprod acceptance not yet run.
Parent: MAS-596, PR 878 (`mas-596-featsmart-wallet-exchain-quorum-co-signing-integration`).

Provenance tags: VERIFIED = read in the code or run in this session. INFERRED = reasoned from verified facts. DECIDED = a design choice the user approved.

## Problem

VERIFIED: purchases that go through Exchain do not show on the Transactions page.
The page reads only `GET /purchase` and `GET /payment` (`PurchaseRequest` and `PaymentRequest` rows).
The demo runner (`packages/payment-source-v2/scripts/smart-wallet-demo/run.mts`) locks escrow outside the node and writes no database rows.
Tx-sync follows only purchases the node owns, so it never picks the demo locks up.

## Goal

A purchase made with `POST /purchase` on a guarded wallet locks funds from the smart wallet, with Exchain quorum co-signing.
It shows on the Transactions page like any other purchase.

## Decisions (user answers)

1. DECIDED: the owner mints the smart wallet outside the node. The node gets an admin attach endpoint and a Wallets UI form.
2. DECIDED: refunds follow the existing rule: `buyerReturnAddress`, else the hot wallet `collectionAddress`, else the hot wallet.
3. DECIDED: guarded status is per hot wallet.
4. DECIDED: a policy denial puts the purchase in `WaitingForManualAction` with Exchain's code and reason. Transient denials stay in `FundsLockingRequested` and retry next tick. Allowed members are rebuilt from `rebuild.keep`. There is never an unguarded fallback.
5. DECIDED: approach 1, a branch inside the existing V2 batch job.
6. DECIDED: guarded wallets stay in the general wallet pool. A purchase without a `HotWalletLimit` can land on a guarded or a plain wallet.

## 1. Data model

```prisma
model GuardedWallet {
  id              String    @id @default(cuid())
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  hotWalletId     String    @unique
  ownerAddress    String
  quorumVkhs      String[]
  threshold       Int
  stateTokenName  String
  scriptAddress   String
  policyId        String
  exchainWalletId String?
  HotWallet       HotWallet @relation(fields: [hotWalletId], references: [id], onDelete: Cascade)
}

enum PurchaseErrorType {
  NetworkError
  InsufficientFunds
  Unknown
  PolicyDenied // new
}
```

- A row means the hot wallet is guarded. No separate flag.
- The agent key is the hot wallet key. It signs the AgentSpend and is the datum buyer, so refunds work unchanged. INFERRED from the validator's buyer-signature rule and `createDatumFromBlockchainIdentifierV2` taking `buyerAddress` from the hot wallet (`batch-payments/service.ts:277`).
- The owner key never reaches the node. Only `ownerAddress` is stored.
- The script comes from `loadSmartWalletScript({ ownerAddress, quorumVkhs, threshold, network })` (`packages/payment-source-v2/src/smart-wallet/wallet-lifecycle.ts:59`). `network` comes from the hot wallet's `PaymentSource`.
- `scriptAddress` and `policyId` are cached. Attach computes them again and refuses a mismatch.
- The Exchain URL and token stay in node config. Only the Exchain wallet id is stored per wallet.
- Detach deletes the row. Exchain keeps the co-sign history.

## 2. Endpoints

New route area `src/routes/api/wallet/guarded/` (`schemas.ts`, `service.ts`, `index.ts`, `docs.ts`). All three use `adminAuthenticatedEndpointFactory`.

### `POST /wallet/guarded` (attach)

Body: `hotWalletId`, `ownerAddress`, `quorumVkhs[]`, `threshold`, `stateTokenName`, and either `register: { mandate }` or `exchainWalletId`.

1. Load the hot wallet. Refuse unless it is Purchasing, not deleted, and on a V2 payment source.
2. Compute the script. `fetchWalletUtxo` must find exactly one state-token UTxO at the address, else 409.
3. Read the datum. `agent` must equal the hot wallet key hash, else 409.
4. With `register`, call `POST /v1/wallets` (logic moved from the demo's `register`, `run.mts:631`, to `src/services/exchain/register.ts`):
   - `agentKeyHashes` = [hot wallet key hash]
   - `escrowAddresses` = [the payment source's V2 contract address]
   - `constitution.params` = the mandate from the body
   - `mandate.daily` must equal the datum's period limit
   - `registryGate` = `true`
5. Write the row and return it, with `mandateEnglish` when Exchain sends it.

### `DELETE /wallet/guarded` (detach)

Body: `hotWalletId`. Refuse with 409 while `HotWallet.lockedAt` is set. Delete the row.
The node does not touch Exchain or the chain. The owner recovers funds with the owner sweep, outside the node.

### `GET /wallet/guarded?hotWalletId=`

The row plus live chain state: wallet lovelace, period spent, period limit, period start.

### Read-token change

`mintExchainReadToken` (`src/routes/api/exchain/service.ts:21`) takes `hotWalletId` and uses the row's `exchainWalletId`. `CONFIG.EXCHAIN_WALLET_ID` stays as the fallback for the demo page.

## 3. Job flow

VERIFIED: `packages/payment-source-v2/src/services/purchases/batch-payments/service.ts` has 1680 lines, over the 750-line limit.

### Step 0: pure move (own commit, no behavior change)

- Move `executeSpecificBatchPayment` (`service.ts:259`) to `execute-batch.ts`.
- Extract `submitBatchTx(signedTx, pairing)`: intendedTxHash, pre-submit write, the five submit outcomes, divergence check.
- Extract `buildLockOutputs(pairing)`: datum and lock outputs.
- The existing specs pass unchanged.

### Step 1: packing

- The wallet query includes `GuardedWallet`.
- For a guarded wallet, the packing loop uses `guardedSpendable(row)` (new `guarded-packing.ts`) in place of the hot wallet amounts: the lesser of (smart-wallet lovelace minus `minBalanceLovelace`) and (period limit minus period spent, after `applyAgentSpend` resets an elapsed period).
- The hot wallet must still cover `BATCH_TX_LOVELACE_OVERHEAD`, because the builder pays fee and collateral from agent UTxOs.
- A purchase with native tokens is never packed onto a guarded wallet.

### Step 2: fork

At the dispatch (`service.ts:1336`): a guarded pairing calls `executeGuardedBatch`, a plain pairing calls `executeSpecificBatchPayment`.

### Step 3: `execute-guarded-batch.ts`

1. `fetchWalletUtxo` and `readWalletDatum`.
2. `buildLockOutputs(pairing)`. Same datum as the plain path.
3. `buildGuardedLockTx` with `agentUtxos` = hot wallet UTxOs and `cosignerVkhs` = the row's quorum.
4. The hot wallet signs as agent.
5. `requestCosign`. Each purchase id binds to `lockOutputIndexes[i]`. Context carries `EXCHAIN_NODE_ID` and `EXCHAIN_ORG_ID`.
6. Approved: `mergeCosignWitnesses`, then `submitBatchTx`. From here the plain flow applies.
7. Denied or error: return a `BatchPairingOutcome` (section 4).

`lockedAt` already serialises spends of the single wallet UTxO. The co-sign timeout (10 s) is shorter than the tx validity window.

## 4. Errors

INFERRED safety rule: before submit, a guarded tx lacks quorum witnesses and cannot land on chain. Reverting a purchase is safe until `submitBatchTx` starts.

Denial `errorNote`: `Exchain <code>: <reasonEnglish> (journal <journalRef>)`.

| Co-sign result | Purchases | New state |
| --- | --- | --- |
| 200 approved | all | merge witnesses, submit |
| 409 `member_denied`, not in `keep`, `velocity_burst` | that member | `FundsLockingRequested`, note says retry |
| 409 `member_denied`, not in `keep`, other code | that member | `WaitingForManualAction` + `PolicyDenied` |
| 409 `member_denied`, in `keep` | kept members | rebuild with exactly `keep`, same `batchId`, co-sign again |
| 409 batch `utxo_unknown`, `clock_skew`, `reservation_conflict` | all | `FundsLockingRequested` |
| 409 batch `asset_not_listed`, `payee_unpinned` | all | `WaitingForManualAction` + `PolicyDenied` |
| 409 batch `body_mismatch` or unknown code | all | `WaitingForManualAction` + `Unknown`, error log |
| 503, timeout, network error, malformed reply | all | `FundsLockingRequested` |

Rules:

1. At most one rebuild per tick. A second denial sends the kept members back to `FundsLockingRequested`.
2. A transient retry sets an errorNote on the new `FundsLockingRequested` NextAction (same pattern as `service.ts:842`).
3. `alarm: true` is logged at error level with `journalRef`.
4. Unlock and revert go through the existing `BatchPairingOutcome` dispatch.
5. Manual recovery is the existing flow. Exchain decides again on the next attempt.

The classification is a pure function `classifyCosignResult(decision)` returning a per-purchase outcome.

## 5. UI

- `frontend/src/components/wallets/sections/GuardedWalletSection.tsx` (view) in `WalletDetailsDialog`, only for Purchasing wallets on V2.
  - Not guarded: attach form (owner address, quorum keys, threshold, state token name, register-with-mandate or existing wallet id).
  - Guarded: script address, balance, period spent against limit, Exchain wallet id, Detach with confirm.
- `frontend/src/components/wallets/useGuardedWallet.ts` (model): queries, mutations, validation.
- A "Guarded" badge in `frontend/src/pages/wallets.tsx`.
- No change to the Transactions page.

## 6. Tests

1. Step 0: existing batch-payments specs pass unchanged.
2. `guarded-packing.spec.ts`: lesser of balance and budget, period reset, min balance held back, token purchase skipped.
3. `classifyCosignResult`: one case per row in section 4, rebuild cap.
4. Attach: refused for non-Purchasing, non-V2, address mismatch, 0 or 2 state tokens, agent mismatch. Detach refused while locked. Register body mapping.
5. Guarded executor with mocked `requestCosign`: approve calls `submitBatchTx` with merged witnesses; deny never submits.
6. Frontend hook test for `useGuardedWallet`.
7. For each fix: revert the source, keep the tests, confirm a non-zero failure count.

### Live acceptance (preprod, first vertical slice = layers 1 to 4 below, without UI)

1. Import the demo agent mnemonic as a Purchasing hot wallet. Its key is the datum `agent` of registered wallet `wal_01M3P5ZM0EP8R4NCQWS7TBWZFZ` (VERIFIED registered 2026-09-29).
2. Attach it with `exchainWalletId`.
3. `POST /purchase` at 6 tADA: reaches FundsLocked on the Transactions page; the tx carries 3 quorum signatures.
4. `POST /purchase` at 60 tADA: `WaitingForManualAction` + `PolicyDenied`, note `Exchain per_tx_cap: ...`.

## Delivery (sequential commits on the PR 878 branch)

DECIDED: no gh stack. The user asked for all layers in the existing PR 878.

1. Schema: `GuardedWallet`, `PolicyDenied`, migration.
2. Refactor: step 0 pure move.
3. API: attach, detach, read, register, read-token change.
4. Job: packing, fork, executor, classifier.
5. UI.

## Implementation deviations

Each item changes what the sections above say. VERIFIED = in the committed code.

1. VERIFIED: the co-sign runs before `recordBatchPresubmit`, not after a pre-submit write. A refusal leaves the purchases with no shared transaction, and `executeGuardedBatch` writes the per-purchase NextAction itself.
2. VERIFIED: the hot wallet signs after `mergeCosignWitnesses`, not before `requestCosign` (step 3.4). The executor builds its own V2 `BlockfrostProvider` and `MeshWallet`, because the root shared provider and wallet are on the V1 Mesh line.
3. VERIFIED: no `buildLockOutputs` extraction. `execute-batch.ts` exports `batchLockDatum`, `recordBatchPresubmit` and `submitBatchTx`.
4. VERIFIED: `registerGuardedWalletWithExchain` takes `registryGate` as a parameter. The node sends `true`; the demo runner sends `false`.
5. VERIFIED: `GET /wallet/list` returns `isGuarded`, so the Wallets page can badge rows without one request per wallet.
6. VERIFIED: `batch-payments/service.ts` is 1170 lines after the job layer, not 1280.

## Follow-up (out of scope)

- `batch-payments/service.ts` stays at 1170 lines, over the 750-line limit. A full split is separate work.

## Least confident decisions

1. `registryGate: true` on registration through the node. Not checked what Exchain does with it on preprod. The live slice uses the existing `false` registration, so it does not test this.
2. Transient retries have no attempt cap. A `utxo_unknown` that never clears retries every tick, visible only in the errorNote.
3. Guarded wallets in the general pool. An unpinned purchase can be guarded or not, depending on which wallet packs it.
4. Lovelace-only packing for guarded wallets. The contract supports multi-asset; the Exchain mandate governs lovelace only.
5. `velocity_burst` as next-tick retry. The tick can come before `retryAfterSec` ends and spend one more denied round trip.
6. The mandate as request input on attach. v1.3.0 requires `constitution` on `POST /v1/wallets`, but a console-only mandate may be the intended flow.
7. `body_mismatch` mapped to `Unknown`, not `PolicyDenied`.
