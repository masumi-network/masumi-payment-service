use aiken/collection/list
use aiken/primitive/bytearray
use aiken/interval
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets.{Value, from_asset, from_lovelace, merge}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}
use smart_wallet/spend
use smart_wallet/types.{AssetValue, Datum, POSIXTime}

// ## Fixtures

const owner_key: ByteArray =
  #"00000000000000000000000000000000000000000000000000000001"

const agent_key: ByteArray =
  #"00000000000000000000000000000000000000000000000000000002"

const stranger_key: ByteArray =
  #"00000000000000000000000000000000000000000000000000000003"

const owner_stake: ByteArray =
  #"00000000000000000000000000000000000000000000000000000004"

const cosigner_a: ByteArray =
  #"000000000000000000000000000000000000000000000000000000a1"

const cosigner_b: ByteArray =
  #"000000000000000000000000000000000000000000000000000000a2"

const cosigner_c: ByteArray =
  #"000000000000000000000000000000000000000000000000000000a3"

/// Doubles as the script hash, the wallet address's payment credential, and
/// the state token's policy id — the validator is its own minting policy.
const wallet_hash: ByteArray =
  #"000000000000000000000000000000000000000000000000000000aa"

const escrow_hash: ByteArray =
  #"000000000000000000000000000000000000000000000000000000bb"

const usdm_policy: ByteArray =
  #"000000000000000000000000000000000000000000000000000000cc"

const nft_policy: ByteArray =
  #"000000000000000000000000000000000000000000000000000000dd"

const ada: Int = 1_000_000

const day_ms: Int = 86_400_000

const period_start: POSIXTime = 1_000_000_000_000

/// Comfortably inside the first window.
const now: POSIXTime = 1_000_000_100_000

fn quorum() -> List<ByteArray> {
  [cosigner_a, cosigner_b, cosigner_c]
}

fn wallet_address() -> Address {
  Address {
    payment_credential: Script(wallet_hash),
    stake_credential: Some(Inline(VerificationKey(owner_stake))),
  }
}

fn escrow_address() -> Address {
  Address { payment_credential: Script(escrow_hash), stake_credential: None }
}

fn agent_address() -> Address {
  Address {
    payment_credential: VerificationKey(agent_key),
    stake_credential: None,
  }
}

fn own_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000001",
    output_index: 0,
  }
}

fn funding_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000002",
    output_index: 0,
  }
}

fn second_wallet_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000003",
    output_index: 0,
  }
}

/// This wallet's state token name — derived at mint from a consumed seed, an
/// opaque 32-byte identifier by the time the spend path sees it.
const token_name: ByteArray =
  #"1111111111111111111111111111111111111111111111111111111111111111"

/// Wallet value: lovelace, the state token, and optionally other assets.
fn wallet_value(lovelace: Int) -> Value {
  merge(from_lovelace(lovelace), from_asset(wallet_hash, token_name, 1))
}

fn lovelace_limit(quantity: Int) -> AssetValue {
  [Pair(#"", [Pair(#"", quantity)])]
}

fn lovelace_and_usdm_limit(lovelace: Int, usdm: Int) -> AssetValue {
  [Pair(#"", [Pair(#"", lovelace)]), Pair(usdm_policy, [Pair("USDM", usdm)])]
}

/// Same shape, all counters at zero.
fn zeroed_like(shape: AssetValue) -> AssetValue {
  list.map(
    shape,
    fn(Pair(policy, names)) {
      Pair(policy, list.map(names, fn(Pair(name, _)) { Pair(name, 0) }))
    },
  )
}

/// Same shape, with only the lovelace counter advanced.
fn charged_lovelace(shape: AssetValue, quantity: Int) -> AssetValue {
  list.map(
    zeroed_like(shape),
    fn(Pair(policy, names)) {
      if policy == #"" {
        Pair(policy, list.map(names, fn(Pair(name, _)) { Pair(name, quantity) }))
      } else {
        Pair(policy, names)
      }
    },
  )
}

fn base_datum() -> Datum {
  Datum {
    agent: agent_key,
    limit: lovelace_limit(10 * ada),
    period_length: day_ms,
    period_start: period_start,
    spent_in_period: lovelace_limit(0),
    min_balance_lovelace: 5 * ada,
  }
}

fn spent(quantity: Int) -> Datum {
  Datum { ..base_datum(), spent_in_period: lovelace_limit(quantity) }
}

fn wallet_input(value: Value, datum: Datum) -> Input {
  Input {
    output_reference: own_ref(),
    output: Output {
      address: wallet_address(),
      value: value,
      datum: InlineDatum(datum),
      reference_script: None,
    },
  }
}

fn continuing(value: Value, datum: Datum) -> Output {
  Output {
    address: wallet_address(),
    value: value,
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn payment(address: Address, value: Value) -> Output {
  Output {
    address: address,
    value: value,
    datum: NoDatum,
    reference_script: None,
  }
}

/// A key-locked input the agent contributes for fees and collateral.
fn funding_input(lovelace: Int) -> Input {
  Input {
    output_reference: funding_ref(),
    output: Output {
      address: agent_address(),
      value: from_lovelace(lovelace),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

fn tx(
  inputs: List<Input>,
  outputs: List<Output>,
  signatories: List<ByteArray>,
  lower: POSIXTime,
  upper: POSIXTime,
) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: inputs,
    outputs: outputs,
    extra_signatories: signatories,
    validity_range: interval.between(lower, upper),
    fee: 200_000,
  }
}

/// The happy-path shape, with every knob a test might bend.
fn agent_tx(
  input_value: Value,
  input_datum: Datum,
  remaining: Value,
  output_datum: Datum,
  payout: Value,
  signatories: List<ByteArray>,
  lower: POSIXTime,
  upper: POSIXTime,
) -> Transaction {
  tx(
    [wallet_input(input_value, input_datum), funding_input(3 * ada)],
    [continuing(remaining, output_datum), payment(escrow_address(), payout)],
    signatories,
    lower,
    upper,
  )
}

fn valid(datum: Datum, self: Transaction) -> Bool {
  spend.agent_spend_is_valid(datum, quorum(), 2, owner_key, own_ref(), self)
}

// ## Agent spend — happy paths

test agent_spend_within_limit() {
  let datum = base_datum()
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      wallet_value(95 * ada),
      spent(5 * ada),
      from_lovelace(5 * ada),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

test agent_spend_accumulates_within_window() {
  let datum = spent(4 * ada)
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      wallet_value(94 * ada),
      spent(10 * ada),
      from_lovelace(6 * ada),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

test agent_spend_rolls_over_elapsed_window() {
  let stale =
    Datum {
      ..base_datum(),
      spent_in_period: lovelace_limit(10 * ada),
      period_start: now - 2 * day_ms,
    }
  let rolled =
    Datum { ..stale, period_start: now, spent_in_period: lovelace_limit(5 * ada) }
  let self =
    agent_tx(
      wallet_value(100 * ada),
      stale,
      wallet_value(95 * ada),
      rolled,
      from_lovelace(5 * ada),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(stale, self)
}

test agent_spend_counts_a_repeated_cosigner_twice() {
  // Weighted by repetition: one signer reaches a threshold of 2 alone.
  let datum = base_datum()
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      wallet_value(95 * ada),
      spent(5 * ada),
      from_lovelace(5 * ada),
      [agent_key, cosigner_a],
      now,
      now + 600_000,
    )
  spend.agent_spend_is_valid(
    datum,
    [cosigner_a, cosigner_a, cosigner_b],
    2,
    owner_key,
    own_ref(),
    self,
  )
}

test agent_spend_moves_a_budgeted_token() {
  let datum =
    Datum {
      ..base_datum(),
      limit: lovelace_and_usdm_limit(10 * ada, 100),
      spent_in_period: lovelace_and_usdm_limit(0, 0),
    }
  let with_usdm =
    merge(wallet_value(100 * ada), from_asset(usdm_policy, "USDM", 500))
  let after =
    merge(wallet_value(100 * ada), from_asset(usdm_policy, "USDM", 450))
  let charged =
    Datum { ..datum, spent_in_period: lovelace_and_usdm_limit(0, 50) }
  let self =
    agent_tx(
      with_usdm,
      datum,
      after,
      charged,
      from_asset(usdm_policy, "USDM", 50),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

// ## Agent spend — budget

test agent_spend_over_limit_fails() fail {
  let datum = spent(8 * ada)
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      wallet_value(95 * ada),
      spent(13 * ada),
      from_lovelace(5 * ada),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

test agent_spend_understating_the_charge_fails() fail {
  let datum = base_datum()
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      wallet_value(95 * ada),
      spent(1 * ada),
      from_lovelace(5 * ada),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

test agent_spend_depositing_to_shrink_the_counter_fails() fail {
  // A negative delta must not buy back budget.
  let datum = spent(9 * ada)
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      wallet_value(105 * ada),
      spent(4 * ada),
      from_lovelace(0),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

test agent_spend_breaching_min_balance_fails() fail {
  let datum = base_datum()
  let self =
    agent_tx(
      wallet_value(10 * ada),
      datum,
      wallet_value(4 * ada),
      spent(6 * ada),
      from_lovelace(6 * ada),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

// ## Agent spend — authorisation

test agent_spend_without_quorum_fails() fail {
  let datum = base_datum()
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      wallet_value(95 * ada),
      spent(5 * ada),
      from_lovelace(5 * ada),
      [agent_key, cosigner_a],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

test agent_spend_cannot_count_its_own_key_as_quorum() fail {
  // The agent sits in the quorum list and signs. It must not count toward the
  // threshold, so one genuine co-signer leaves the tally at 1 of 2.
  let datum = base_datum()
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      wallet_value(95 * ada),
      spent(5 * ada),
      from_lovelace(5 * ada),
      [agent_key, cosigner_a],
      now,
      now + 600_000,
    )
  spend.agent_spend_is_valid(
    datum,
    [agent_key, cosigner_a, cosigner_b],
    2,
    owner_key,
    own_ref(),
    self,
  )
}

test agent_spend_without_the_agent_fails() fail {
  let datum = base_datum()
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      wallet_value(95 * ada),
      spent(5 * ada),
      from_lovelace(5 * ada),
      [stranger_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

// ## Agent spend — asset freeze

test agent_spend_stealing_an_unlisted_token_fails() fail {
  let with_nft = merge(wallet_value(100 * ada), from_asset(nft_policy, "AGENT", 1))
  let datum = base_datum()
  let self =
    agent_tx(
      with_nft,
      datum,
      wallet_value(95 * ada),
      spent(5 * ada),
      from_lovelace(5 * ada),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

test agent_spend_injecting_an_unlisted_token_fails() fail {
  let datum = base_datum()
  let padded =
    merge(wallet_value(95 * ada), from_asset(nft_policy, "JUNK", 1))
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      padded,
      spent(5 * ada),
      from_lovelace(5 * ada),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

test agent_spend_dropping_the_state_token_fails() fail {
  let datum = base_datum()
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      from_lovelace(95 * ada),
      spent(5 * ada),
      from_lovelace(5 * ada),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

test agent_spend_on_a_tokenless_utxo_fails() fail {
  let datum = base_datum()
  let self =
    tx(
      [
        Input {
          output_reference: own_ref(),
          output: Output {
            address: wallet_address(),
            value: from_lovelace(100 * ada),
            datum: InlineDatum(datum),
            reference_script: None,
          },
        },
        funding_input(3 * ada),
      ],
      [
        continuing(from_lovelace(95 * ada), spent(5 * ada)),
        payment(escrow_address(), from_lovelace(5 * ada)),
      ],
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

// ## Agent spend — continuation integrity

test agent_spend_merging_two_wallet_utxos_fails() fail {
  let datum = base_datum()
  let second =
    Input {
      output_reference: second_wallet_ref(),
      output: Output {
        address: wallet_address(),
        value: from_lovelace(50 * ada),
        datum: NoDatum,
        reference_script: None,
      },
    }
  let self =
    tx(
      [wallet_input(wallet_value(100 * ada), datum), second, funding_input(3 * ada)],
      [
        continuing(wallet_value(145 * ada), spent(5 * ada)),
        payment(escrow_address(), from_lovelace(5 * ada)),
      ],
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

test agent_spend_alongside_a_foreign_script_input_succeeds() {
  // Foreign scripts are allowed by design: the wallet funds transactions that
  // interact with other contracts — locking into the payment escrow being the
  // primary case. The no-merge rule constrains OUR script only.
  let datum = base_datum()
  let foreign =
    Input {
      output_reference: second_wallet_ref(),
      output: Output {
        address: escrow_address(),
        value: from_lovelace(20 * ada),
        datum: NoDatum,
        reference_script: None,
      },
    }
  let self =
    tx(
      [wallet_input(wallet_value(100 * ada), datum), foreign, funding_input(3 * ada)],
      [
        continuing(wallet_value(95 * ada), spent(5 * ada)),
        payment(escrow_address(), from_lovelace(25 * ada)),
      ],
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

test agent_spend_merging_two_tokened_shards_fails() fail {
  // Two wallets can share the address but never a transaction: each shard
  // settles alone, so the ceilings stay independent.
  let datum = base_datum()
  let sibling_name =
    #"2222222222222222222222222222222222222222222222222222222222222222"
  let sibling =
    Input {
      output_reference: second_wallet_ref(),
      output: Output {
        address: wallet_address(),
        value: merge(from_lovelace(50 * ada), from_asset(wallet_hash, sibling_name, 1)),
        datum: InlineDatum(base_datum()),
        reference_script: None,
      },
    }
  let self =
    tx(
      [wallet_input(wallet_value(100 * ada), datum), sibling, funding_input(3 * ada)],
      [
        continuing(wallet_value(145 * ada), spent(5 * ada)),
        payment(escrow_address(), from_lovelace(5 * ada)),
      ],
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

test agent_spend_swapping_the_token_fails() fail {
  // The continuing output must carry the SAME token the input held — not a
  // sibling wallet's. Identity is the name, not just the policy.
  let datum = base_datum()
  let other_name =
    #"3333333333333333333333333333333333333333333333333333333333333333"
  let swapped =
    merge(from_lovelace(95 * ada), from_asset(wallet_hash, other_name, 1))
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      swapped,
      spent(5 * ada),
      from_lovelace(5 * ada),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

test agent_spend_splitting_the_wallet_fails() fail {
  let datum = base_datum()
  let self =
    tx(
      [wallet_input(wallet_value(100 * ada), datum), funding_input(3 * ada)],
      [
        continuing(wallet_value(90 * ada), spent(5 * ada)),
        continuing(from_lovelace(5 * ada), spent(5 * ada)),
        payment(escrow_address(), from_lovelace(5 * ada)),
      ],
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

test agent_spend_redelegating_the_wallet_fails() fail {
  // Same script, different stake credential — a staking hijack.
  let datum = base_datum()
  let hijacked =
    Address {
      payment_credential: Script(wallet_hash),
      stake_credential: Some(Inline(VerificationKey(stranger_key))),
    }
  let self =
    tx(
      [wallet_input(wallet_value(100 * ada), datum), funding_input(3 * ada)],
      [
        Output {
          address: hijacked,
          value: wallet_value(95 * ada),
          datum: InlineDatum(spent(5 * ada)),
          reference_script: None,
        },
        payment(escrow_address(), from_lovelace(5 * ada)),
      ],
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

test agent_spend_rotating_its_own_key_fails() fail {
  let datum = base_datum()
  let rotated =
    Datum { ..spent(5 * ada), agent: stranger_key }
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      wallet_value(95 * ada),
      rotated,
      from_lovelace(5 * ada),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

test agent_spend_raising_its_own_limit_fails() fail {
  let datum = base_datum()
  let widened =
    Datum { ..spent(5 * ada), limit: lovelace_limit(1_000 * ada) }
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      wallet_value(95 * ada),
      widened,
      from_lovelace(5 * ada),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

test agent_spend_lowering_min_balance_fails() fail {
  let datum = base_datum()
  let lowered = Datum { ..spent(5 * ada), min_balance_lovelace: 0 }
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      wallet_value(95 * ada),
      lowered,
      from_lovelace(5 * ada),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

// ## Agent spend — window handling

test agent_spend_rollover_with_an_overlong_range_fails() fail {
  let stale =
    Datum {
      ..base_datum(),
      spent_in_period: lovelace_limit(10 * ada),
      period_start: now - 2 * day_ms,
    }
  let rolled =
    Datum { ..stale, period_start: now, spent_in_period: lovelace_limit(5 * ada) }
  let self =
    agent_tx(
      wallet_value(100 * ada),
      stale,
      wallet_value(95 * ada),
      rolled,
      from_lovelace(5 * ada),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 2 * day_ms,
    )
  valid(stale, self)
}

test agent_spend_resetting_an_open_window_fails() fail {
  let datum = spent(9 * ada)
  let reset =
    Datum { ..base_datum(), period_start: now, spent_in_period: lovelace_limit(5 * ada) }
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      wallet_value(95 * ada),
      reset,
      from_lovelace(5 * ada),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

test agent_spend_without_a_finite_upper_bound_fails() fail {
  let datum = base_datum()
  let self =
    Transaction {
      ..agent_tx(
        wallet_value(100 * ada),
        datum,
        wallet_value(95 * ada),
        spent(5 * ada),
        from_lovelace(5 * ada),
        [agent_key, cosigner_a, cosigner_b],
        now,
        now + 600_000,
      ),
      validity_range: interval.after(now),
    }
  valid(datum, self)
}

// ## Agent spend — malformed datum

test agent_spend_with_a_duplicated_limit_entry_fails() fail {
  // A datum authored outside the validator can repeat an asset. Failing closed
  // is the point: the alternative is an ambiguity whose resolution an attacker
  // chooses.
  let datum =
    Datum {
      ..base_datum(),
      limit: [Pair(#"", [Pair(#"", 10 * ada), Pair(#"", 1_000 * ada)])],
    }
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      wallet_value(95 * ada),
      Datum { ..datum, spent_in_period: lovelace_limit(5 * ada) },
      from_lovelace(5 * ada),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

/// Lovelace plus `extra` distinct junk policies, each budgeted.
fn wide_limit(extra: Int) -> AssetValue {
  let junk =
    list.map(
      list.range(1, extra),
      fn(index) {
        Pair(bytearray.from_int_big_endian(index, 28), [Pair(#"", 1_000_000)])
      },
    )
  list.concat([Pair(#"", [Pair(#"", 10 * ada)])], junk)
}

test agent_spend_at_the_asset_bound_succeeds() {
  // 16 entries: lovelace plus 15 others.
  let datum =
    Datum {
      ..base_datum(),
      limit: wide_limit(15),
      spent_in_period: zeroed_like(wide_limit(15)),
    }
  let charged =
    Datum { ..datum, spent_in_period: charged_lovelace(wide_limit(15), 5 * ada) }
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      wallet_value(95 * ada),
      charged,
      from_lovelace(5 * ada),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

test agent_spend_past_the_asset_bound_fails() fail {
  // 17 entries. Unbounded lists make a spend cost (assets moved x assets
  // listed) and eventually exceed the execution budget; the bound is checked
  // where the datum is used, so an unvalidated funding datum cannot dodge it.
  let datum =
    Datum {
      ..base_datum(),
      limit: wide_limit(16),
      spent_in_period: zeroed_like(wide_limit(16)),
    }
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      wallet_value(95 * ada),
      Datum { ..datum, spent_in_period: charged_lovelace(wide_limit(16), 5 * ada) },
      from_lovelace(5 * ada),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

test agent_spend_with_mismatched_limit_and_counter_shape_fails() fail {
  let datum =
    Datum {
      ..base_datum(),
      limit: lovelace_and_usdm_limit(10 * ada, 100),
      spent_in_period: lovelace_limit(0),
    }
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      wallet_value(95 * ada),
      Datum { ..datum, spent_in_period: lovelace_limit(5 * ada) },
      from_lovelace(5 * ada),
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  valid(datum, self)
}

// ## Deposit

fn deposit_tx(
  before: Value,
  after: Value,
  datum: Datum,
  output_datum: Datum,
  signatories: List<ByteArray>,
) -> Transaction {
  tx(
    [wallet_input(before, datum), funding_input(50 * ada)],
    [continuing(after, output_datum)],
    signatories,
    now,
    now + 600_000,
  )
}

fn deposit_valid(datum: Datum, self: Transaction) -> Bool {
  spend.deposit_is_valid(datum, owner_key, own_ref(), self)
}

test deposit_by_the_agent() {
  let datum = base_datum()
  let self =
    deposit_tx(
      wallet_value(10 * ada),
      wallet_value(60 * ada),
      datum,
      datum,
      [agent_key],
    )
  deposit_valid(datum, self)
}

test deposit_by_the_owner() {
  let datum = base_datum()
  let self =
    deposit_tx(
      wallet_value(10 * ada),
      wallet_value(60 * ada),
      datum,
      datum,
      [owner_key],
    )
  deposit_valid(datum, self)
}

test deposit_without_a_signature_fails() fail {
  // Otherwise anyone churns the wallet UTxO with dust and breaks in-flight
  // transaction builds for the price of a fee.
  let datum = base_datum()
  let self =
    deposit_tx(
      wallet_value(10 * ada),
      wallet_value(60 * ada),
      datum,
      datum,
      [stranger_key],
    )
  deposit_valid(datum, self)
}

test deposit_that_deposits_nothing_fails() fail {
  // `merge` prunes zeros, so an unchanged value flattens to `[]` and every
  // per-asset check passes vacuously. Without the non-empty guard the holder of
  // the agent key could churn the wallet UTxO for the price of a fee — and
  // since Deposit needs no quorum, co-signers refusing could not stop it.
  let datum = base_datum()
  let self =
    deposit_tx(
      wallet_value(10 * ada),
      wallet_value(10 * ada),
      datum,
      datum,
      [agent_key],
    )
  deposit_valid(datum, self)
}

test deposit_removing_value_fails() fail {
  let datum = base_datum()
  let self =
    deposit_tx(
      wallet_value(60 * ada),
      wallet_value(10 * ada),
      datum,
      datum,
      [agent_key],
    )
  deposit_valid(datum, self)
}

test deposit_rewriting_the_datum_fails() fail {
  let datum = base_datum()
  let self =
    deposit_tx(
      wallet_value(10 * ada),
      wallet_value(60 * ada),
      datum,
      Datum { ..datum, limit: lovelace_limit(1_000 * ada) },
      [agent_key],
    )
  deposit_valid(datum, self)
}

test deposit_of_an_unlisted_asset_fails() fail {
  let datum = base_datum()
  let self =
    deposit_tx(
      wallet_value(10 * ada),
      merge(wallet_value(60 * ada), from_asset(nft_policy, "JUNK", 1)),
      datum,
      datum,
      [agent_key],
    )
  deposit_valid(datum, self)
}

// ## Owner paths

test owner_spend_needs_the_owner() {
  let self = tx([], [], [owner_key], now, now + 600_000)
  spend.owner_signed(owner_key, self)
}

test owner_spend_without_the_owner_fails() fail {
  let self = tx([], [], [agent_key, cosigner_a, cosigner_b], now, now + 600_000)
  spend.owner_signed(owner_key, self)
}

test update_policy_rotates_the_agent() {
  let datum = base_datum()
  let rotated = Datum { ..datum, agent: stranger_key }
  let self =
    tx(
      [wallet_input(wallet_value(100 * ada), datum)],
      [continuing(wallet_value(100 * ada), rotated)],
      [owner_key],
      now,
      now + 600_000,
    )
  spend.update_is_valid(owner_key, own_ref(), self)
}

test update_policy_without_the_owner_fails() fail {
  let datum = base_datum()
  let self =
    tx(
      [wallet_input(wallet_value(100 * ada), datum)],
      [continuing(wallet_value(100 * ada), datum)],
      [agent_key, cosigner_a, cosigner_b],
      now,
      now + 600_000,
    )
  spend.update_is_valid(owner_key, own_ref(), self)
}

test update_policy_dropping_the_token_fails() fail {
  let datum = base_datum()
  let self =
    tx(
      [wallet_input(wallet_value(100 * ada), datum)],
      [continuing(from_lovelace(100 * ada), datum)],
      [owner_key],
      now,
      now + 600_000,
    )
  spend.update_is_valid(owner_key, own_ref(), self)
}

test update_policy_without_a_continuing_output_fails() fail {
  let datum = base_datum()
  let self =
    tx(
      [wallet_input(wallet_value(100 * ada), datum)],
      [payment(agent_address(), from_lovelace(100 * ada))],
      [owner_key],
      now,
      now + 600_000,
    )
  spend.update_is_valid(owner_key, own_ref(), self)
}

test agent_spend_cannot_count_the_owner_as_quorum() fail {
  // The cold key never doubles as a co-signer: a deployment listing the owner
  // in the quorum must not weaken the threshold.
  let datum = base_datum()
  let self =
    agent_tx(
      wallet_value(100 * ada),
      datum,
      wallet_value(95 * ada),
      spent(5 * ada),
      from_lovelace(5 * ada),
      [agent_key, owner_key, cosigner_a],
      now,
      now + 600_000,
    )
  spend.agent_spend_is_valid(
    datum,
    [owner_key, cosigner_a, cosigner_b],
    2,
    owner_key,
    own_ref(),
    self,
  )
}
