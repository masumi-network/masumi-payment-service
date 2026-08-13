use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval.{Finite, Interval, IntervalBound}
use cardano/address.{Script}
use cardano/assets.{lovelace_of, merge, negate, tokens}
use cardano/transaction.{
  InlineDatum, Output, OutputReference, Transaction, ValidityRange, find_input,
}
use smart_wallet/asset_value
use smart_wallet/types.{Datum, POSIXTime}

/// The wallet UTxO this spend continues, its own script hash, and the name of
/// the state token identifying this wallet.
///
/// Enforces the rules the whole design rests on:
///
/// - **Exactly one input of OUR script.** Two wallets at this address can never
///   be merged or spent together — each shard settles alone. Foreign script
///   inputs are permitted: the wallet funds transactions that interact with
///   other contracts, locking into the payment escrow being the primary case.
/// - **Exactly one continuing output at the same full address**, stake part
///   included, which stops a spend re-delegating the treasury.
/// - **The input carries exactly one state token**, and the continuing output
///   carries exactly the same one. Each token is one wallet; a UTxO holding
///   zero or two is not a wallet.
fn continuation(
  own_ref: OutputReference,
  self: Transaction,
) -> (Output, Output, ByteArray, ByteArray) {
  expect Some(own_input) = find_input(self.inputs, own_ref)
  let own_address = own_input.output.address
  expect Script(own_hash) = own_address.payment_credential

  expect [_] =
    list.filter(
      self.inputs,
      fn(input) {
        input.output.address.payment_credential == Script(own_hash)
      },
    )
  expect [continuing] =
    list.filter(self.outputs, fn(output) { output.address == own_address })
  expect continuing.reference_script == own_input.output.reference_script

  expect [Pair(token_name, 1)] =
    own_input.output.value |> tokens(own_hash) |> dict.to_pairs()
  expect
    ( continuing.value |> tokens(own_hash) |> dict.to_pairs() ) == [
      Pair(token_name, 1),
    ]

  (own_input.output, continuing, own_hash, token_name)
}

fn continuing_datum(continuing: Output) -> Datum {
  expect InlineDatum(raw) = continuing.datum
  expect datum: Datum = raw
  datum
}

pub fn owner_signed(owner: VerificationKeyHash, self: Transaction) -> Bool {
  list.has(self.extra_signatories, owner)
}

/// Weighted quorum tally.
///
/// A key listed twice carries two votes, matching `admin_vks` in
/// `vested_pay.ak`. The agent's own key never counts, even if it appears in the
/// list: otherwise a compromised hot key contributes a vote toward approving
/// its own spend, and the quorum is weaker than it reads in exactly the
/// scenario it exists for.
pub fn quorum_met(
  quorum: List<VerificationKeyHash>,
  threshold: Int,
  agent: VerificationKeyHash,
  self: Transaction,
) -> Bool {
  let weight =
    list.count(
      quorum,
      fn(key) { key != agent && list.has(self.extra_signatories, key) },
    )
  weight >= threshold
}

/// Both ends of the validity range, or a script failure when either is
/// unbounded.
///
/// The ledger only applies a transaction while `lower <= now <= upper`, which
/// is what makes the ends usable as conservative clocks: `lower` proves time
/// has already passed, `upper` proves a deadline has not.
pub fn finite_bounds(range: ValidityRange) -> (POSIXTime, POSIXTime) {
  expect Interval {
    lower_bound: IntervalBound { bound_type: Finite(lower), .. },
    upper_bound: IntervalBound { bound_type: Finite(upper), .. },
  } = range
  (lower, upper)
}

/// A delegated agent moves value out, co-authorized by the quorum.
pub fn agent_spend_is_valid(
  datum: Datum,
  quorum: List<VerificationKeyHash>,
  threshold: Int,
  own_ref: OutputReference,
  self: Transaction,
) -> Bool {
  let (wallet, continuing, _own_hash, _token_name) = continuation(own_ref, self)

  expect list.has(self.extra_signatories, datum.agent)
  expect quorum_met(quorum, threshold, datum.agent, self)

  // Keeps the per-spend cost affordable. Enforced here, where the datum is
  // used, rather than on `UpdatePolicy` where it is written — the funding
  // transaction runs no script, so only a check on the spend path binds every
  // datum that ever reaches a spend.
  expect asset_value.is_bounded(datum.limit)
  // The counter is a map over the limit's shape, so the two must agree.
  expect asset_value.same_shape(datum.limit, datum.spent_in_period)

  let outflow = merge(wallet.value, negate(continuing.value))
  // Anything unlisted that moved — in either direction — is rejected here. The
  // state token is unlisted by construction, so this is also a second fence
  // keeping it in place.
  expect asset_value.all_movements_listed(outflow, datum.limit)
  expect lovelace_of(continuing.value) >= datum.min_balance_lovelace

  let (lower, upper) = finite_bounds(self.validity_range)
  let rolled_over = lower >= datum.period_start + datum.period_length
  // On roll-over the fresh window must contain the present. The ledger keeps
  // `now` inside `[lower, upper]`, so demanding the whole range fit inside the
  // new window stops an agent back-dating windows to accrue budget.
  expect !rolled_over || upper <= lower + datum.period_length

  let period_start =
    if rolled_over {
      lower
    } else {
      datum.period_start
    }
  let opening =
    if rolled_over {
      asset_value.zeroed(datum.spent_in_period)
    } else {
      datum.spent_in_period
    }
  let spent_in_period = asset_value.charge(opening, outflow)
  expect asset_value.within_limit(spent_in_period, datum.limit)

  continuing_datum(continuing) == Datum {
    ..datum,
    period_start: period_start,
    spent_in_period: spent_in_period,
  }
}

/// Value moves in and nothing leaves. Agent or owner; no quorum, because there
/// is nothing for co-signers to approve.
pub fn deposit_is_valid(
  datum: Datum,
  owner: VerificationKeyHash,
  own_ref: OutputReference,
  self: Transaction,
) -> Bool {
  let (wallet, continuing, _own_hash, _token_name) = continuation(own_ref, self)

  // A signature is not ceremony here: without one, anyone could churn the
  // wallet UTxO with dust deposits and break in-flight transaction builds for
  // the price of a fee.
  expect or {
    list.has(self.extra_signatories, datum.agent),
    owner_signed(owner, self),
  }

  // The configuration may not ride in on a deposit.
  expect continuing_datum(continuing) == datum

  let inflow = merge(continuing.value, negate(wallet.value))
  asset_value.is_a_real_deposit(inflow, datum.limit)
}

/// The owner rewrites the dynamic configuration and keeps the wallet alive.
///
/// The new datum is otherwise unconstrained — the owner may rotate the agent,
/// re-budget, or move value in the same transaction.
///
/// Unguarded, and the failure is silent: a datum whose `limit` and
/// `spent_in_period` list different assets, or in a different order, brings
/// every subsequent agent spend down on the shape check with no on-chain
/// feedback at the moment the mistake is made. `OwnerSpend` always recovers the
/// funds, so this costs automation rather than money.
pub fn update_is_valid(
  owner: VerificationKeyHash,
  own_ref: OutputReference,
  self: Transaction,
) -> Bool {
  expect owner_signed(owner, self)
  let (_wallet, continuing, _own_hash, _token_name) = continuation(own_ref, self)
  let _new_datum = continuing_datum(continuing)
  True
}
