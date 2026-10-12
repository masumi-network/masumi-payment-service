# Guarded wallet inside a Hydra head

Status: implemented, preprod proof in progress. Branch `feat/smart-wallet-hydra-proof` (on top of PR 952).
Linear: MAS-621 (MAS-622 proof, MAS-624..628).

## Goal

A guarded wallet (smart wallet script UTxO with its state token) moves into an
open head, pays for purchases inside the head with Exchain co-signatures, and
moves back to L1. All through the payment node API. Proven on preprod with two
local hydra-node 2.4.1 nodes and the real service.

## Facts this design rests on

- VERIFIED (code): the wallet validator lets `OwnerSpend` spend with only the
  owner signature, and pins the state token for `AgentSpend` via `continuation()`.
- VERIFIED (hydra 2.4.1 source): a deposit with a blueprint keeps the original
  output (address, value, inline datum) and the node re-balances fees,
  collateral and the script integrity hash (`Deposit.hs:37-41`, `Wallet.hs:283-318`).
- VERIFIED (code): today the service rejects this deposit in 3 places:
  `commit-draft-validation.ts:160` (script input), `:359-385` (script data hash),
  `:355` (inline datum in the commit output). `codec.ts:83` rejects a script ref
  (we have none, so that one is fine).
- VERIFIED (code): L2 purchases exclude guarded wallets at
  `l2-lock.ts:97` and `l2-lock-execute.ts:454`.
- REPORTED (explore agent): Exchain resolves `walletUtxoRef` against its L1
  view. An in-head ref would be denied as `utxo_unknown`, a transient retry.
- NOT DETERMINED: whether hydra-node accepts the `inlineDatumRaw` form for a
  script commit UTxO, and whether default exUnits fit the L2 limits. The preprod
  run settles both.

## Where the wallet is

No new state column. The service asks the head: if the local participant's
open head snapshot holds the state token, the wallet is on L2. Otherwise it is
on L1 (or moving). This cannot drift from the truth.

## API (all under `/wallet/guarded/hydra`, admin auth, same scope rules as attach)

1. `POST /deposit` `{hotWalletId, headId}`: builds the `OwnerSpend` blueprint
   (no outputs, owner as required signer), requests the node draft, validates
   it with a script-commit validator, stores a `GuardedHydraTransfer`
   (Deposit, Prepared), returns the unsigned tx. The owner key never touches
   the node.
2. `POST /deposit/submit` `{transferId, signedTx}`: checks the body hash is
   unchanged and the owner witness is valid, submits on L1, moves to Submitted.
   `GET /` moves it to Confirmed once the snapshot holds the token.
3. `POST /withdraw` `{hotWalletId}`: an `OwnerSpend` in the head that recreates
   the wallet output unchanged. The agent signs only for its in-head collateral,
   and the owner signs on `POST /withdraw/submit`, which sends it as a decommit.
   Settled when the wallet UTxO is back on L1 with the token. The service bounds
   the signing window to 15 minutes because a decommit carries no validity range.

Correction: an earlier draft of this section used a zero-outflow `AgentSpend`
with an Exchain co-sign for the withdraw. The co-sign API needs at least one
intent, and a withdraw has none, so the owner signs instead. The owner can always
spend its own wallet, so this gives up no guard.
4. `GET /` `{hotWalletId}`: location (L1 / L2 / moving), head id, wallet ref,
   L2 datum (spent in period, limit), recent transfers.

New Prisma model `GuardedHydraTransfer` (direction, status Prepared / Submitted
/ Confirmed / Expired / Failed, hydraHeadId, guardedWalletId, txHash, unsignedTx,
walletUtxoRef, signBefore, recoverableAt, failureReason). While a withdraw is
open, guarded purchases in the head stop, so no lock spends the UTxO the owner
is signing against. Topup and decommit rows stay
participant-only: their reconcile heuristics assume the participant address.

## Purchases inside the head

- `l2-lock.ts`: allow a guarded hot wallet when its state token is in the head
  snapshot. Dispatch to `executeGuardedL2Lock`.
- `guarded-lock-builder.ts`: gain an L2 mode: `isHydra`, fee 0, total collateral
  0, explicit agent collateral from the snapshot, head clock window, fixed
  exUnits (no `evaluateTx` on the Hydra provider), head protocol params and
  cost models.
- Co-sign: the request carries `context.hydraHeadId` (the 28-byte head id). The
  proof mock resolves `walletUtxoRef` from L1 first and then from the head
  snapshot. Real Exchain needs the same contract change (open item for Yuval).
  The earlier `context.layer` shape was dropped as larger than needed.
- Reservation and submit reuse `reserveL2LockBeforeSubmit` and the Hydra
  provider, with the guarded wallet claim.

## Proof on preprod (MAS-622)

`packages/payment-source-v2/scripts/smart-wallet-hydra/prove.mts` drives the HTTP
API only: attach guarded wallet, deposit (owner signs locally), wait L2, create a
purchase, see it lock in the head, under-quorum negative via the mock, withdraw,
see the wallet on L1 with the token. Evidence goes to `.state/evidence.ndjson`.
Service runs on a fresh DB `masumi_sw_hydra` on local Postgres 5432.

## Least confident decisions

1. Exchain L2 context shape. Exchain cannot check an in-head UTxO by itself; it
   must trust the node or watch the head. This needs Yuval before mainnet.
2. Location from the snapshot instead of a DB column. Costs one snapshot read
   per tick per guarded wallet; a cached column would be cheaper but can drift.
3. Fixed exUnits on L2. If the validator needs more than the default, txs fail
   with no evaluator to tell us; may need a local evaluator.
4. Owner signs the deposit off-node (prepare + submit). Correct for a cold key,
   but adds a round trip and a draft TTL the owner must meet.
5. A separate transfer model instead of reusing `HydraTopup`/`HydraDecommit`.
