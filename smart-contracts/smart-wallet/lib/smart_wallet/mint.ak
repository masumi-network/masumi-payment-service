use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash, blake2b_256}
use aiken/primitive/bytearray
use cardano/address.{Address, Credential, Inline, Script}
use cardano/assets.{PolicyId, tokens}
use cardano/transaction.{OutputReference, Transaction}

/// The one address wallets under this configuration live at, derived entirely
/// from the script's own parameters.
pub fn wallet_address(policy_id: PolicyId, stake: Option<Credential>) -> Address {
  let stake_credential =
    when stake is {
      Some(credential) -> Some(Inline(credential))
      None -> None
    }
  Address {
    payment_credential: Script(policy_id),
    stake_credential: stake_credential,
  }
}

/// State-token name for the wallet seeded by `ref`:
/// `blake2b_256(transaction_id ++ output_index as 4-byte big-endian)`.
///
/// The seed is a **runtime input, not a script parameter** — one policy and one
/// address serve every wallet under this configuration, and each mint consumes
/// a fresh seed to produce a fresh token. A UTxO can be spent exactly once, so
/// each *name* is mintable exactly once, ever; the ledger enforces the
/// uniqueness, with no registry and no counter.
///
/// The fixed 4-byte width matters: a variable-width index would let two
/// distinct `(transaction_id, index)` pairs serialise to the same preimage.
pub fn state_token_name(ref: OutputReference) -> ByteArray {
  blake2b_256(
    bytearray.concat(
      ref.transaction_id,
      bytearray.from_int_big_endian(ref.output_index, 4),
    ),
  )
}

/// The wallet validator is its own minting policy.
///
/// One script hash serves as the token policy id, the wallet address's payment
/// credential, and the identity the spend path checks. Each token under the
/// policy is one wallet: same address, own UTxO, own datum, own agent, own
/// ceiling. Additional wallets are additional mints, not additional
/// deployments.
pub fn mint_is_valid(
  owner: VerificationKeyHash,
  stake: Option<Credential>,
  policy_id: PolicyId,
  self: Transaction,
) -> Bool {
  // Exactly one asset name may move under this policy per transaction.
  // Guarding only the token you care about is the "infinite mint" hole: a
  // caller mints arbitrary extra names under the same policy id, and anything
  // authenticating on the policy alone is then forgeable.
  expect [Pair(asset_name, quantity)] =
    self.mint |> tokens(policy_id) |> dict.to_pairs()

  if quantity == 1 {
    // Only the owner creates wallets. Without this gate, anyone could mint a
    // shard at this address with an agent of their choosing — harmless to
    // existing wallets, but noise the off-chain layer should never have to
    // distinguish from the real thing.
    expect list.has(self.extra_signatories, owner)

    // The name must derive from an input this transaction consumes. That input
    // can never be spent again, so this name can never be minted again.
    expect
      list.any(
        self.inputs,
        fn(input) { asset_name == state_token_name(input.output_reference) },
      )

    // Destination pinned to the full wallet address, and the receiving UTxO
    // must hold exactly this one token of the policy — the per-UTxO invariant
    // ("every wallet UTxO carries exactly one state token") starts here.
    expect Some(wallet) =
      list.find(
        self.outputs,
        fn(output) { output.address == wallet_address(policy_id, stake) },
      )
    ( wallet.value |> tokens(policy_id) |> dict.to_pairs() ) == [
      Pair(asset_name, 1),
    ]
  } else {
    // Burn, retiring one wallet. Owner-gated so a wallet cannot be retired by
    // whoever happens to reach the token. Other wallets at the address are
    // untouched — their tokens are different assets.
    quantity == -1 && list.has(self.extra_signatories, owner)
  }
}
