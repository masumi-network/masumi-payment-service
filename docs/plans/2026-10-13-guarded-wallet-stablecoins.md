# Guarded wallet: USDM and USDC

Status: built and run live on preprod, 2026-10-14. Lands as commits on PR 952.

Provenance tags: VERIFIED = read or run in this session. REPORTED = a subagent or doc said so. INFERRED = reasoned from other facts.

## Goal

A guarded smart wallet holds ADA, USDM and USDC. The wallet moves into a Hydra head and back with every asset. An agent pays a seller in the wallet's payment asset (ADA, USDM or USDC), on L1 and inside a head, with the quorum's co-signature.

## Facts the plan rests on

1. The contract governs every asset separately. `limit` and `spent_in_period` are per-asset maps with at most 16 entries and the same key order. An unlisted asset cannot move on the agent path (VERIFIED, `asset_value.ak:44-167`, `spend.ak:109-164`).
2. `UpdatePolicy` needs only the owner signature. It may rewrite the datum and move value in the same transaction (VERIFIED, `spend.ak:196-216`).
3. An Exchain wallet governs one asset. `WalletRegistration.governedAsset` is one `AssetSpec {id, decimals}` and `decimals` is the enum `[6]` (VERIFIED, `https://cosign.exchain.network/openapi.yaml` v1.3.0).
4. Every output that carries a token also carries min-UTxO lovelace. Packing already adds it to `PaidFunds` (VERIFIED, `batch-payments/service.ts:599-637`). So a USDM purchase leaves the wallet as USDM plus some ADA.
   - Correction: this plan first said "about 1.2 to 1.5 ADA". That was a guess from the bare ledger min-UTxO of a one-token output. Packing pads the estimate for the escrow output with its datum, and a 5 tUSDM lock carried 4.469470 ADA on preprod, on L1 and in the head (VERIFIED, txs `64b2b030…` and `dc9e0375…`).
5. Today every TypeScript path is lovelace-only:
   - attach and registration: `guarded-wallet.ts:116`, `schemas.ts:8-23`
   - L1 and L2 locks: `guarded-cosign-purchase.ts:19-28`, `execute-guarded-batch.ts:52`, `l2-guarded-lock-execute.ts:152,180`
   - packing: `guarded-packing.ts:139`
   - mock co-signer: `cosign-policy.ts:185-233`
     (VERIFIED.)
6. Preprod has tUSDM (`16a55b2a…0014df10745553444d`) and no USDC. Blockfrost preprod returns 404 for the USDCx unit in Exchain's examples (VERIFIED). USDCx exists on mainnet only (`src/utils/asset-units.ts:1`).
7. The test owner holds 200 tUSDM and 74.27 ADA (VERIFIED, chain read 2026-10-13).

## Design

### Payment asset per wallet

- A guarded wallet has one `governedAsset`: `lovelace`, USDM or USDCx. It is stored in the Exchain `AssetId` format (`lovelace` or `<policy>.<nameHex>`).
- The value is fixed at attach. To change it: detach, then attach again.
- Allowed values per network: preprod `lovelace` and tUSDM; mainnet `lovelace`, USDM and USDCx. All three have 6 decimals, which is what Exchain accepts.
- A token wallet needs a new registration (`register`) at attach. A lovelace wallet may reuse an `exchainWalletId`. The node cannot read back which asset an existing Exchain wallet governs.
- Attach checks two things on chain:
  - the governed asset has a `limit` entry
  - `mandate.daily` equals that entry
- Registration sends `governedAsset: {id, decimals: 6}`. Mandate amounts are in the governed asset's minor units.

### Limits and deposit (owner action)

- `POST /wallet/guarded/policy` with `{hotWalletId, limits: [{unit, amount}], deposit: [{unit, amount}]}` returns `{unsignedTx, txHash}`.
- The new transaction spends the wallet under `UpdatePolicy` and writes a new datum:
  - `limit` = the given limits, in canonical sorted order
  - `spent_in_period` = the old counter for an asset already listed, 0 for a new one, in the same order
  - every other datum field stays as it is
- The continuing output = wallet value + deposit.
- The owner address pays the fee and the collateral.
- The browser signs with CIP-30 (`signTx`) and submits with `submitTx`. The node keeps no state for this action, so there is no submit endpoint.
- The prepare request is refused when:
  - the wallet is not on L1
  - a Hydra move is open
  - `limits` does not list lovelace or the governed asset
  - `limits` lists more than 16 assets, repeats a unit, or has an amount below 0
  - `limits` lists any unit under the state-token policy (listing it would let the state token move)
  - an asset the wallet holds, other than the state token, is dropped from `limits`
  - `deposit` names an unlisted asset (it would be frozen)
  - `exchainWalletId` is set and the new governed-asset limit differs from the old one (the Exchain mandate cannot change, so they would drift)
  - the owner address cannot cover the deposit, the fee, the min-UTxO top-up, or an ADA-only collateral of 5 ADA or more
- **Min-UTxO.** The new datum and token make the continuing output larger. The builder computes `guardedContinuingMinLovelace` on the new datum and value, and the owner adds the lovelace shortfall.
- **Build mechanics.** These are the same as the L1 lock:
  - `loadV2ProtocolParameters` under `withMeshCostModelLock`;
  - `buildWithEvaluatedBudgets`;
  - continuing output first, with the owner as required signer;
  - collateral from `pickBatchCollateral`, which picks an ADA-only owner UTxO.
- **The browser checks the transaction before signing.** `UpdatePolicy` leaves the datum unconstrained, so a compromised node could rotate the agent or drain the wallet through one owner click. Before `signTx`, the dialog decodes the unsigned transaction and checks:
  - the continuing output is at the wallet address
  - `agent`, `period_length`, `period_start` and `min_balance` are unchanged
  - `limit` equals what the operator typed
  - the continuing value is at least the old value plus the deposit
  - every other output goes back to the owner address
- **Endpoint.** It uses `adminAuthenticatedEndpointFactory` with the hot-wallet scope, like its siblings.
- **Stale input.** On a stale-input error (the agent spent the wallet meanwhile), the dialog prepares again.

### Token purchases

- **Unit format.** Use one converter, `governedUnitOf`:
  - the dotted Exchain form (`<policy>.<nameHex>`) appears only in intents and registration;
  - packing uses the concatenated unit, with `''` for lovelace;
  - Mesh outputs use `'lovelace'`.
- **Fit rule** (`guardedPurchaseFits`, a pure function in `guarded-packing.ts`): a purchase fits only when its non-lovelace units are exactly the governed asset, or none for a lovelace wallet. A purchase that does not fit is skipped:
  - at packing, before it can join a batch: one call in `service.ts`, no fit-miss record;
  - in L2 routing (`l2-lock.ts`), before `headAvailable = true`.

  `guardedLockAmounts` still throws on a mismatch, as a second guard. Without the skip, one mismatched purchase sends its batch-mates to manual action (`service.ts:863-890`), or it loops in L2 routing.

- **Lock output:** every `PaidFunds` unit, aggregated through `mapPaidFundsToAssets` (`''` becomes `'lovelace'`), on L1 and L2.
- **Co-sign intent:** `asset` = governed asset in dotted form, `amount` = that asset's quantity in the lock output (L1 `execute-guarded-batch.ts:57`, L2 `l2-guarded-lock-execute.ts:162-165,200`).
- **Packing:** `guardedWalletAmounts` offers lovelace and, for a token wallet, the governed token. Each is `min(balance above reserve, period budget left)`. `evaluated` is false when any offered asset is budget-bound.
- **Where the ride-along ADA goes.** The min-UTxO lovelace of a token-only purchase becomes `collateralReturnLovelace`. At settlement it goes to the buyer return or collection address, not back to the smart wallet (`service.ts:597-614`, `execute-batch.ts:181`). So each token purchase spends about 4.5 ADA of the lovelace budget, and that ADA leaves the guard (VERIFIED: two 5 tUSDM L1 locks moved the lovelace counter to 8.938940 ADA). ADA purchases already do the same; here it happens on every purchase. Size the lovelace limit for it.

### Mock co-signer

- **Policy.** It has `governedAsset`, caps in that asset's units, and `maxRideAlongLovelace` per token lock output. A purchase priced in USDM plus ADA is refused; that is documented.
- **Decoding.** `DecodedOutput` gains `assets: Map<unit, bigint>`. `walletInput` becomes a full asset map. Three resolvers fill it:
  - `mock.mts` L1: the Blockfrost `amount[]`
  - `mock.mts` in-head: the snapshot `value`, flattened from `{policy: {name: qty}}`
  - `demo-context.mts`
- **Token wallet rules.** Each intent output must:
  - carry exactly the governed amount and no other token
  - carry lovelace no higher than the ride-along cap
- **Outflow, per asset.** The governed outflow must equal the declared amount. The lovelace outflow must equal the lovelace of the intent outputs.
- **Decision feed.** `outflowLovelace` and `boundsAfter` are shown in governed-asset units.
- **Setting the asset.** `SW_GOVERNED_ASSET` sets it, passed through `MockCosignOptions`.

### Status and UI

- **Status.** `describeWalletUtxo` gains `governedAsset` and `assets: [{unit, quantity, limit, spentInPeriod}]`. Both `GET /wallet/guarded` and the Hydra status read this one source. The existing lovelace fields stay.
- **Schemas and docs.** Update `guardedWalletRecordSchema` and `hydra/schemas.ts`, which strip unknown fields. Also update both `docs.ts` examples, `openapi-docs.json`, and the regenerated frontend client.
- **Spec fixtures.** Fixtures built `as never` get `governedAsset` set explicitly. No code treats `undefined` as lovelace.
- **Admin UI:**
  - The attach form gets a payment-asset select, and the mandate labels show that asset.
  - The summary lists every asset with its balance and its spent and limit values.
  - A "Limits and deposit" dialog signs through the owner wallet connector.

## Commits (on PR 952, one at a time)

1. `feat(guarded): store the wallet's payment asset` (migration, attach, registration, GET assets)
2. `feat(guarded): owner update of limits and deposit` (builder, endpoint, tests)
3. `feat(guarded): lock usdm and usdc purchases` (packing, L1, L2, intents, tests)
4. `feat(cosign-mock): govern a token` (policy, decoder, tests)
5. `feat(frontend): token limits, balances and deposit`
6. `docs(guarded): live stablecoin run and exchain asks`

## Live run (preprod, our wallet, mock quorum), 2026-10-14

The first guarded wallet stays where it was, in head `141b9819…`. This run used new keys and a new head, so it touched nothing of the first one.

### Setup

- New owner, agent and quorum keys: `SW_PROOF=usdm` keeps them in `scripts/smart-wallet-hydra/.state/usdm/` (git-ignored).
- New Purchasing hot wallet from the new agent key (`749650b1…`), added through `PATCH /payment-source-extended`.
- New node keys and a second node pair on 4003/4004 with their own persistence. Head `87795503…` opened at 16:20:40Z (VERIFIED, `HeadIsOpen`).
- Mock restarted with `SW_GOVERNED_ASSET=<tUSDM>` and the new head's parties in `SW_TRUSTED_HYDRA_PARTIES`.

### Results (all VERIFIED on preprod or in the head snapshot)

| Step                                                 | Result                                                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Mint with limits 50 ADA and 100 tUSDM                | `5b162c6c…`                                                                                                                             |
| Attach as a tUSDM wallet with `register`             | `governedAsset` stored, Exchain id `wal_V0C4…` from the mock                                                                            |
| Deposit 50 tUSDM through `UpdatePolicy`              | `ae9db58e…`; wallet holds 40 ADA and 50 tUSDM                                                                                           |
| Browser check on a real prepared update (not signed) | honest: no problem; wrong agent: "The datum names another agent key"; wrong deposit: refused                                            |
| L1 lock, 5 tUSDM, first try                          | refused by the mock: `Output 1 carries 4.469470 tADA beside the token; the mandate allows 3.000000 tADA`                                |
| L1 lock, 5 tUSDM, cap raised                         | `a08d9c7f…` landed on chain, but the purchase timed out (tx-sync bug, below)                                                            |
| L1 lock, 5 tUSDM, after the tx-sync fix              | `64b2b030…`, `FundsLocked`; escrow output 4.469470 ADA + 5 tUSDM                                                                        |
| Agent top-up in the head                             | 20 ADA, Confirmed                                                                                                                       |
| Move the wallet into the head with 40 tUSDM          | `4becd3a1…`, Confirmed; the snapshot shows the wallet with 40 tUSDM                                                                     |
| L2 lock, 5 tUSDM                                     | `dc9e0375…`, L2 Confirmed; escrow output 4.46947 ADA + 5 tUSDM; wallet keeps 35 tUSDM; the mock proved the wallet input from snapshot 2 |
| L2 lock, 25 tUSDM                                    | refused: `Exchain per_tx_cap: This payment is 25.000000 tUSDM. The mandate allows 20.000000 tUSDM in a single payment.`                 |

Not run: the move back to L1. The new wallet stays in head `87795503…`.

### What the run found

1. **Guarded L1 locks never confirmed.** A guarded lock spends the smart wallet, so the tx has a redeemer and no input at the escrow address. The tx-sync classifier called that `Invalid` and skipped it. Every guarded L1 lock, ADA too, timed out although it was on chain. All earlier guarded purchases in this database ran on L2, so nothing showed it. Fixed in `fix(tx-sync): read a guarded lock as an initial escrow output`.
2. **The mock ride-along cap was too low.** It was 3 ADA, a guess. It is now 6 ADA, from the 4.469470 ADA measured.
3. **5 tUSDM is stranded in escrow.** The timed-out lock `a08d9c7f…` is on chain, but its purchase row says `FailedViaTimeout`, so no job will refund it. It needs a manual refund after its unlock time.
4. **The `Skipping invalid tx` log line drops its reason.** Winston ignores the extra arguments, so the log showed an empty reason. Not fixed here.

## What Exchain may need to change (for their update)

1. **Ride-along lovelace.** For a token wallet, accept the lovelace that rides with each token lock output, and bound it (for example, at most the output's min-UTxO plus a margin). Measured: 4.469470 ADA for a one-token escrow output with its datum, on L1 and in the head. A bound near the bare ledger min-UTxO (about 1.2 ADA) refuses every honest lock. Count it against a lovelace budget, not the token mandate. That lovelace returns to the buyer's return address at settlement, not to the smart wallet.
2. **Multi-asset outflow.** The body check must compare the wallet's outflow per asset, not lovelace only.
3. **Several assets per wallet** (optional). Today a wallet that pays in USDM and USDC needs two registrations and two smart wallets. A list of governed assets would remove that.
4. **Preprod USDC.** There is no preprod USDCx unit to test with.

## Least confident decisions

1. The tx-sync change. Any tx with no escrow input now reads as `Initial`, including a Hydra fanout that pays escrow outputs. The Initial handlers then ignore it: purchases must await a funds lock, payments must await external action, and Hydra-owned rows are skipped (INFERRED from `tx/index.ts` and `force-layer/index.ts`; no fanout ran in this test).
2. The ride-along lovelace bound in the mock. 6 ADA is the 4.47 ADA measured plus a margin. A lock with a larger datum or a second token could need more.
3. Fixing the payment asset at attach. A wallet can hold several tokens, but agents can only pay in one. Changing it needs a detach.
4. The owner address pays the fee for the policy update. A CIP-30 wallet that keeps its ADA on another address of the same account cannot sign for those UTxOs, so the update fails with "owner address cannot cover".
5. Refusing to drop an asset the wallet holds. This blocks one legitimate case: freezing a token on purpose.
