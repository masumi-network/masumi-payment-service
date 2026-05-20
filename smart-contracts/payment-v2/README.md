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

- **Hash-pin the result_hash.** The seller can keep updating `result_hash` via
  `SubmitResult` until `external_dispute_unlock_time`. Admins must therefore
  inspect and pin the current `result_hash` on the target UTxO BEFORE
  collecting signatures. Once `external_dispute_unlock_time` passes,
  `SubmitResult` is rejected, so the pinned hash is stable. Admins should
  refuse to sign before that timestamp.
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
