# Masumi Payment Contract V2

## Overview

The payment V2 contract is an Aiken Plutus V3 escrow validator for Cardano payments. A buyer locks funds, the seller submits a non-empty result hash, and the seller can withdraw after `unlock_time`. Buyers can request refunds before seller withdrawal, and unresolved disputes can be settled by weighted admin signatures after `external_dispute_unlock_time`.

V2 differs from the original payment contract in a few important ways:

- `buyer` and `seller` are full Cardano `Address` values, not only verification key hashes.
- `buyer_return_address` and `seller_return_address` can route final payouts to fixed return addresses.
- `agent_identifier` is carried in the datum and preserved across state transitions.
- `WithdrawDisputed` uses CIP-8 style admin signatures in the redeemer instead of transaction required signers.
- `admin_vks` is intentionally weighted: repeating the same admin verification key hash gives that admin multiple voting slots.
- The current V2 validator parameters are `required_admins_multi_sig`, `admin_vks`, and `cooldown_period`. Protocol fee payment is not enforced by this validator version.
- Dispute settlements intentionally allow any escrow value above the admin-signed buyer and seller minimum payouts to be taken as the settlement submitter fee.

## Building

Install Aiken, then run:

```sh
aiken build
```

Run contract tests with:

```sh
aiken check
```

## Validator Parameters

```aiken
validator vested_pay(
  required_admins_multi_sig: Int,
  admin_vks: List<VerificationKeyHash>,
  cooldown_period: Int,
)
```

- `required_admins_multi_sig`: Weighted approval threshold for dispute withdrawals.
- `admin_vks`: Admin verification key hashes. Duplicate entries are allowed by design and count as additional voting weight.
- `cooldown_period`: Milliseconds added to the current transaction upper bound when setting the next actor cooldown.

Deployment configuration is part of the contract's trust boundary. The validator includes spend-time guards against an empty admin list and a zero dispute threshold, but immutable script parameters cannot be corrected on-chain after funds are locked. Deployment tooling must review that `required_admins_multi_sig` is reachable with the configured weighted `admin_vks`, that `cooldown_period` is non-negative and operationally appropriate, and that any repeated admin key is intentional governance weight.

## Datum

```aiken
pub type Datum {
  buyer: Address,
  buyer_return_address: Option<Address>,
  seller: Address,
  seller_return_address: Option<Address>,
  reference_key: ByteArray,
  reference_signature: ByteArray,
  seller_nonce: ByteArray,
  buyer_nonce: ByteArray,
  agent_identifier: ByteArray,
  collateral_return_lovelace: Int,
  input_hash: ByteArray,
  result_hash: ByteArray,
  pay_by_time: POSIXTime,
  submit_result_time: POSIXTime,
  unlock_time: POSIXTime,
  external_dispute_unlock_time: POSIXTime,
  seller_cooldown_time: POSIXTime,
  buyer_cooldown_time: POSIXTime,
  state: State,
}
```

Principal addresses (`buyer`, `seller`) vs payout addresses
(`buyer_return_address`, `seller_return_address`):

- **Principal addresses MUST be verification-key credentials.** Every
  redeemer that mutates contract state dereferences the buyer or seller
  principal via `address_to_verification_key(...)` to derive a vkey hash
  used for required-signer checks (lines 257, 388, 409, 491, 677, 738 in
  the validator). That helper returns `None` for a script-credential
  address, and the surrounding `expect Some(...)` then aborts the redeemer.
  A payment locked with a script-credential `buyer` or `seller` is
  PERMANENTLY UNSPENDABLE: no `Withdraw`, no `WithdrawRefund`, no
  `WithdrawDisputed`, no `SetRefundRequested` — every branch needs the
  vkey. Off-chain locking tooling MUST reject script-credential addresses
  (smart wallets, multisig wrappers, hardware-wallet abstractions) for
  these two fields before broadcasting a lock. This service rejects them
  at the API boundary on the `POST /payment/x402/build-tx` and
  `POST /purchase` endpoints (after resolving the seller principal from
  the on-chain agent-NFT holder).
- **Payout / return addresses can be ANY address shape.** The validator
  only ever uses `buyer_return_address` and `seller_return_address` as
  output destinations (`output.address == expected`), never dereferencing
  them for a vkey. Script-credential addresses are valid here — buyers
  and sellers may legitimately want refund / withdrawal funds routed to a
  smart wallet, multisig vault, or any other script destination. The
  current API additionally restricts return addresses to base addresses
  with stake credentials as a UX guard; that restriction is not a
  validator requirement and can be relaxed if integrators need script
  payouts.

Return-address behavior:

- If a return address is `None`, the validator does not enforce a tagged payout
  output for that side. The actor (who must sign the tx) is free to route the
  payout to any address of their choice via normal tx outputs.
- If a return address is `Some(address)`, the validator requires a tagged
  payout output at exactly that address (full Cardano `Address` equality
  including stake credential).
- Tagged payout outputs use an inline datum equal to the spent contract `OutputReference`.
- On seller withdrawal, the buyer must receive at least `collateral_return_lovelace`, and the seller return output must cover the contract input value minus that collateral lovelace.
- Buyer and seller payout checks assume the effective payout targets are distinct: `buyer_return_address` or `buyer` for the buyer side, and `seller_return_address` or `seller` for the seller side. This holds for normal buyer/seller wallets. If a deployment intentionally points both sides at the same address, one tagged output can satisfy both role checks, so off-chain validation should reject equal effective payout targets unless that aggregation is intended.

## States

```typescript
const States = {
  FundsLocked: 0,
  ResultSubmitted: 1,
  RefundRequested: 2,
  Disputed: 3,
  WithdrawAuthorized: 4,
  RefundAuthorized: 5,
};
```

## Actions

```typescript
const Actions = {
  Withdraw: 0,
  SetRefundRequested: 1,
  AuthorizeWithdrawal: 2,
  WithdrawRefund: 3,
  WithdrawDisputed: 4,
  SubmitResult: 5,
  AuthorizeRefund: 6,
};
```

### Withdraw

Seller withdrawal from `ResultSubmitted` after `unlock_time`, or from `WithdrawAuthorized` after buyer approval.

Requirements:

- Seller address payment key signs the transaction.
- Current state is `ResultSubmitted` with a transaction starting at or after `unlock_time`, or current state is `WithdrawAuthorized`.
- `result_hash` is non-empty.
- Buyer receives at least `collateral_return_lovelace` at the buyer return target.
- If `seller_return_address` is set, the seller return target receives at least the contract input value minus `collateral_return_lovelace`.

### SetRefundRequested

Buyer requests a refund before seller withdrawal.

Requirements:

- Buyer address payment key signs the transaction.
- Transaction ends before `unlock_time`.
- Transaction starts at or after `buyer_cooldown_time`.
- Current state is `FundsLocked`, `ResultSubmitted`, or `Disputed`.
- Contract value is preserved in a continuing script output.
- Next state is `RefundRequested` when no result exists, otherwise `Disputed`.

### AuthorizeWithdrawal

Buyer authorizes seller withdrawal from a disputed payment.

Requirements:

- Buyer address payment key signs the transaction.
- Transaction starts at or after `buyer_cooldown_time`.
- Current state is `Disputed`.
- Existing `result_hash` is non-empty.
- Contract value is preserved in a continuing script output.
- Next state is `WithdrawAuthorized`.
- Once `WithdrawAuthorized`, the seller can use `Withdraw` without waiting for `unlock_time`.

**Intentionally irrevocable.** V2 deliberately dropped the V1
`UnSetRefundRequested` transition for this branch. Once the buyer signs
`AuthorizeWithdrawal`, the contract transitions to `WithdrawAuthorized` and
there is no on-chain path back: the seller can `Withdraw` at any time
afterwards with no upper time bound, and the buyer cannot rescind. This is
by design — `AuthorizeWithdrawal` is the buyer's explicit, final decision
to release escrowed funds to the seller (typically when the dispute has
been resolved in the seller's favor off chain). Integrators MUST surface
this irrevocability in the buyer-facing UI before requesting the signature
(confirmation dialog, summary of consequences, no "undo" affordance).
Wallet-key compromise vectors (drainers, social engineering, mis-click on
an auto-approving UI) therefore have full settlement authority — operators
should treat `AuthorizeWithdrawal` signatures with the same key-hygiene
posture as a direct fund transfer.

### WithdrawRefund

Buyer withdraws a refund after the seller misses `submit_result_time`, or immediately after seller authorization.

Requirements:

- Buyer address payment key signs the transaction.
- Current state is `FundsLocked`, `RefundRequested`, or `RefundAuthorized`.
- Transaction starts at or after `submit_result_time`, unless the current state is `RefundAuthorized`.
- `result_hash` is empty.
- If `buyer_return_address` is set, the buyer return target receives at least the contract input value.

### WithdrawDisputed

Admins settle a dispute after the external dispute window.

Redeemer fields:

```aiken
WithdrawDisputed {
  buyer_value: AssetValue,
  seller_value: AssetValue,
  admin_signatures: List<AdminSignature>,
}
```

Admins sign the hash of:

```aiken
DisputeWithdrawal {
  own_ref,
  buyer_value,
  seller_value,
}
```

The signed `own_ref` is the transaction hash and output index of the exact contract UTxO being spent. It is the replay boundary for V2 dispute approvals: a signature for one disputed UTxO is not valid for another UTxO. Admin tooling should generate the intent from the decoded target UTxO and the agreed buyer/seller minimum payout values, then present those values to signers.

Requirements:

- Current state is `Disputed`.
- `result_hash` is non-empty.
- Transaction starts at or after `external_dispute_unlock_time`.
- Buyer and seller tagged outputs pay at least the values specified in the redeemer.
- The weighted count of valid admin signatures is at least `required_admins_multi_sig`.
- Any remaining value from the disputed UTxO after the signed buyer/seller minimum payouts is intentionally unconstrained and serves as the transaction builder or settlement submitter fee.

Admin signing runbook (mandatory off-chain process):

- **Admins MUST NOT sign before `external_dispute_unlock_time`.** This is the
  single hard rule that makes the dispute outcome safe to reason about. The
  validator allows the seller to call `SubmitResult` and rotate `result_hash`
  on the disputed UTxO right up until `external_dispute_unlock_time`. The
  admin-signed `DisputeWithdrawal` payload binds `own_ref` (the spent
  UTxO's tx hash + output index) but does NOT bind `result_hash`, so any
  signature collected during the rotation window remains technically valid
  against a later state of the same UTxO. If admins sign while rotation is
  still possible, the seller can swap `result_hash` between admin review
  and tx settlement — admins would have signed for hash `H1` while the
  buyer ultimately sees `H2` on chain, undermining the dispute outcome.

  The on-chain `must_start_after(external_dispute_unlock_time)` gate on
  `WithdrawDisputed` (vested_pay.ak: enforced via the time bound checks in
  the dispute branch) closes the seller's `SubmitResult` window
  simultaneously with opening the dispute settlement window. Once the
  external dispute timeout has passed:

  - The contract REJECTS any further `SubmitResult` on the disputed UTxO.
  - The on-chain `result_hash` is therefore frozen for as long as the UTxO
    remains in the disputed state.
  - Admins reading the on-chain hash at this point can be sure it cannot
    change before their settlement tx lands.

  Operationally: admin tooling MUST refuse to issue a signature whose
  signing-time wall clock is earlier than `external_dispute_unlock_time` of
  the target disputed UTxO. Settlement-submission tooling SHOULD re-verify
  on-chain `result_hash` immediately before broadcast as a defense-in-depth
  cross-check; this matters less once the timeout has passed (rotation is
  impossible) but catches operator errors where signing was issued
  prematurely.

- **Hash-pin the result_hash for the audit record.** Even with the timeout
  rule above honored, admin tooling should capture the on-chain
  `result_hash` at signing time and persist it alongside the signature for
  audit/forensic purposes. The pinned hash MUST equal the hash present on
  chain at the time of settlement broadcast.
- **Use canonical CBOR encoding when serializing the signing payload.**
  `DisputeWithdrawal { own_ref, buyer_value, seller_value }` is hashed via
  `cbor.serialise |> blake2b_224` on-chain. Two equivalent payloads with
  different map orderings produce different hashes and therefore different
  signatures. Off-chain tooling MUST use deterministic CBOR encoding
  (lexicographic ordering of asset names / policy ids) so that the signed
  bytes round-trip exactly against the on-chain serialization.
- **`collateral_return_lovelace` is NOT applied by the validator in
  `WithdrawDisputed`.** Admins have full discretion over the buyer / seller
  split via the signed minimum payouts. If admins intend the dispute
  settlement to preserve the locked collateral semantics, they must encode
  that in the signed `buyer_value` themselves. The collateral field on the
  datum is only enforced on the cooperative `Withdraw` path.

Weighted admin policy:

- `admin_vks` is a weighted list, not a set.
- Repeating a verification key hash gives that admin multiple voting slots.
- This is intentional for deployments that want weighted governance, but deployment tooling should make the chosen weights explicit.

### SubmitResult

Seller submits or updates a result hash.

Requirements:

- Seller address payment key signs the transaction.
- Transaction starts at or after `seller_cooldown_time`.
- Contract value is preserved in a continuing script output.
- New `result_hash` is non-empty.
- Allowed before `submit_result_time`, or before `external_dispute_unlock_time` when a prior result already exists.
- Next state is `ResultSubmitted` from `FundsLocked` or `ResultSubmitted`, otherwise `Disputed`.

### AuthorizeRefund

Seller authorizes buyer refund by clearing the result hash and moving the contract to `RefundAuthorized`.

Requirements:

- Seller address payment key signs the transaction.
- Current state is `FundsLocked`, `ResultSubmitted`, `RefundRequested`, or `Disputed`.
- Transaction starts at or after `seller_cooldown_time`.
- Contract value is preserved in a continuing script output.
- New `result_hash` is empty.
- Next state is `RefundAuthorized`.
- Once `RefundAuthorized`, the buyer can use `WithdrawRefund` without waiting for `submit_result_time`.

## Multi-UTxO Guardrails

The validator allows multiple contract inputs in one transaction only when their `reference_signature` values are unique. Continuing contract outputs must also have unique `reference_signature` values. This keeps batched transitions distinguishable while preventing duplicate processing of the same payment reference.

Inputs at the script address whose datum is missing, not inline, or not parseable as the `Datum` shape are filtered out of the dedupe set rather than aborting the transaction. This protects legitimate spends from a "datum dust" griefing vector where anyone can deposit a UTxO with an arbitrary datum at the script address. Such inputs still have to satisfy some validator path of their own to be spent, so including them is a tx-builder mistake whose blast radius is limited to that builder.

The dedupe check is O(n²) but bounded in practice by Cardano's ledger-enforced limits on script inputs per tx (currently ~30 effective for typical Plutus scripts due to CPU / memory units). No application-level cap is added; the ledger cap is the effective bound. Revisit if ledger limits are raised significantly.

## Design Decisions

This section summarizes the intentional design decisions where the validator
deliberately leaves something un-enforced because the cost of enforcement is
not justified by the threat model. Each item is also documented at its
specific code site in `validators/vested_pay.ak`.

### Double-satisfaction is acceptable when buyer == seller

In the `Withdraw` and `WithdrawDisputed` branches, the collateral-return
filter and the seller-residual filter are independent. When
`buyer_return_address == seller_return_address` (or `buyer == seller` when
either address is omitted), a single tx output tagged with `own_ref` and
addressed to the shared target satisfies both filters at once. The validator
accepts this because the return addresses are pulled from the locked datum
(not the redeemer), so no third party can manipulate the aggregation, and
the "victim" and the "winner" of the aggregated payout are the same on-chain
identity. Off-chain tx builders that want separate accounting MUST emit two
explicit outputs; the validator only checks economic safety, not bookkeeping
clarity.

### Admin signature dedup is intentional (weighted multi-sig)

`admin_vks` is allowed to contain duplicate entries. Each duplicate
represents an additional voting slot, and a single physical signature from
a key listed N times counts N times toward `required_admins_multi_sig`.
This is the intended weighted-multisig behavior — for example, a 5-of-7
weighted scheme `[ceo, ceo, b1, b2, b3, b4, b5]` lets the CEO + any three
board members settle a dispute. This contrasts with naive multisig where
duplicate keys would be a deployment bug. Off-chain tooling MUST construct
`admin_vks` with the correct duplication when modeling weighted authorities
and MUST surface the weights to deployers.

### Dispute settler reward cap is intentional (INTENDED DESIGN)

The validator does NOT cap the residual (surplus) that goes to the
dispute-settlement transaction builder in `WithdrawDisputed`. The signed
`buyer_value` / `seller_value` are MINIMUM payouts; any escrow value above
their sum accrues to the wallet that builds and submits the tx, as a
"finder's reward" for cleaning up the dispute without requiring buyer or
seller to spend their own ADA on fees. Admins sign with full knowledge of
the residual (the signed payload binds `own_ref`, so the admin can review
the exact UTxO they are settling).

Operational caveat: anyone can send dust ADA or arbitrary tokens to a
script address. The disputed UTxO's value at settlement time can therefore
exceed the value originally locked. The submitter sweeps whatever residual
exists above the signed minimums; the validator does not distinguish
"original lock" from "later dust accretion". Admins should sign settlements
promptly to avoid dust-pump scenarios if "winner takes the surplus" is
undesirable for a specific deployment.

Front-running threat model: a mempool-monitoring attacker who notices a
disputed UTxO approaching settlement can deliberately inflate its value
(send ADA to the script address) before the admin-signed settlement tx
lands, then submit the settlement themselves to capture the inflated
residual. Mitigations off-chain:

- The settlement submitter (typically operator tooling) SHOULD compute the
  expected residual at signing time (`disputed_utxo_value - buyer_value -
  seller_value`) and refuse to broadcast if the actual residual at submit
  time exceeds that by more than a configured tolerance.
- High-value disputes can mitigate this entirely by having admins sign
  exact-payout payloads where `buyer_value + seller_value = disputed_utxo_value`,
  leaving zero residual. The validator allows this.
- A v2.1 contract revision could cap the residual via an admin-signed
  `max_submitter_reward` field; this is tracked but out of scope for v2.0.

### `list.unique` is O(n²) but ledger-bounded

The per-batch dedupe of `reference_signature` values uses `list.unique`,
which is quadratic in the number of parseable script inputs (or continuing
script outputs). Cardano's ledger-enforced limits on script inputs per tx
(currently ~30 effective for typical Plutus scripts due to CPU / memory
units) bound this in practice, so no explicit application-level cap is
added. Revisit if ledger limits are ever raised significantly.

### Malformed-datum inputs are skipped, not fatal

Inputs at the script address whose datum is not inline or does not parse
as the `Datum` shape are filtered out of the dedupe set via
`list.filter_map` rather than aborting the transaction. This prevents a
"datum dust" griefing vector where anyone could attach an unparseable UTxO
to the script address and freeze any future spend that happens to include
it. The validator continues to enforce all checks on the parseable inputs;
the unparseable input must still satisfy some validator path of its own to
be spent, so including it is a tx-builder mistake whose blast radius stays
local.

## Example Scripts

Install dependencies, generate local test wallets, and fund the buyer/admin wallets on the selected network:

```sh
pnpm install
pnpm run generate-wallet
```

Available scripts:

```sh
pnpm run lock
TX_HASH=<contract-utxo-tx-hash> pnpm run submit-result
TX_HASH=<contract-utxo-tx-hash> pnpm run request-refund
TX_HASH=<contract-utxo-tx-hash> pnpm run cancel-refund # legacy script name for AuthorizeWithdrawal
TX_HASH=<contract-utxo-tx-hash> pnpm run authorize-refund
TX_HASH=<contract-utxo-tx-hash> pnpm run withdraw-refund
TX_HASH=<contract-utxo-tx-hash> pnpm run withdraw
TX_HASH=<contract-utxo-tx-hash> pnpm run withdraw-disputed
```

Common environment variables:

- `NETWORK`: `preprod` by default.
- `TX_HASH`: Contract UTxO transaction hash for every spending action.
- `OUTPUT_INDEX`: Optional contract UTxO output index when a transaction has more than one matching output.
- `LOCK_LOVELACE`: Lovelace locked by `pnpm run lock`, default `5000000`.
- `COLLATERAL_RETURN_LOVELACE`: Buyer collateral returned on seller withdrawal, default `0`.
- `BUYER_RETURN_ADDRESS` and `SELLER_RETURN_ADDRESS`: Optional fixed payout targets matching the V2 datum return-address fields.
- `RESULT_HASH` or `RESULT_TEXT`: Result committed by `submit-result`.
- `BUYER_LOVELACE`: Buyer share used by `withdraw-disputed`; the remaining assets default to the seller.
- `REQUIRED_ADMINS` and `COOLDOWN_PERIOD_MS`: Validator parameters used when deriving the script address.
- `INVALID_BEFORE_MS` and `INVALID_AFTER_MS`: Optional transaction validity bounds for timing-sensitive examples.

The examples now use the V2 validator parameter list, V2 datum field order, tagged payout outputs, and the `WithdrawDisputed` redeemer with distribution values plus CIP-8 admin signatures.
