//// Property tests over the budget arithmetic and the full spend rule.
////
//// The unit tests pin known attack shapes; these throw randomized inputs at
//// the same code to find the shapes nobody thought to pin. Each runs 100
//// cases per `aiken check`.
////
//// Toolchain notes, all verified on v1.1.23 and all failing with `aiken
//// check` exit 1 and NO diagnostic:
////
//// - bounds in a `via` fuzzer argument must be literals, not expressions
//// - a test may take at most ONE `via` argument; pack pairs with `fuzz.both`
//// - property tests that construct a full `Transaction` and call
////   `spend.agent_spend_is_valid` trip a further silent failure this module
////   could not isolate; randomized full-validator coverage therefore lives in
////   fuzz-e2e.mjs, which exercises the real script through evaluateTx
////   against preprod instead.

use aiken/collection/list
use aiken/fuzz
use aiken/interval
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets.{from_asset, from_lovelace, merge, negate}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}
use smart_wallet/asset_value
use smart_wallet/mint.{state_token_name}
use smart_wallet/spend
use smart_wallet/types.{AssetValue, Datum}

const ada: Int = 1_000_000

const day_ms: Int = 86_400_000

const window_open: Int = 1_000_000_000_000

fn lovelace_only(quantity: Int) -> AssetValue {
  [Pair(#"", [Pair(#"", quantity)])]
}

// ## Arithmetic properties

test prop_charge_never_decreases_a_counter(outflow_lovelace via fuzz.int_between(-100_000_000, 100_000_000)) {
  let before = lovelace_only(3 * ada)
  let after = asset_value.charge(before, from_lovelace(outflow_lovelace))
  expect Some(Pair(_, names)) = list.head(after)
  expect Some(Pair(_, charged)) = list.head(names)
  // A positive outflow adds; a zero or negative one changes nothing. In no
  // case does a counter shrink — that is the rule that stops deposits buying
  // back budget.
  charged >= 3 * ada
}

test prop_zeroed_preserves_shape(quantities via fuzz.list_between(fuzz.int_between(0, 1_000_000_000), 1, 8)) {
  let shape =
    list.indexed_map(
      quantities,
      fn(index, quantity) {
        Pair(
          fuzz_policy(index),
          [Pair(#"", quantity)],
        )
      },
    )
  asset_value.same_shape(shape, asset_value.zeroed(shape))
}

fn fuzz_policy(index: Int) -> ByteArray {
  when index is {
    0 -> #""
    1 -> #"01"
    2 -> #"02"
    3 -> #"03"
    4 -> #"04"
    5 -> #"05"
    6 -> #"06"
    _ -> #"07"
  }
}

test prop_within_limit_is_monotone(spent via fuzz.int_between(0, 20_000_000)) {
  let limit = lovelace_only(10 * ada)
  let counters = lovelace_only(spent)
  // within_limit answers exactly `spent <= limit`, for every spent.
  asset_value.within_limit(counters, limit) == (spent <= 10 * ada)
}


fn index_pair() {
  fuzz.both(fuzz.int_between(0, 1000), fuzz.int_between(0, 1000))
}

test prop_derived_names_never_collide_on_index(pair via index_pair()) {
  let (index_a, index_b) = pair
  let tx_id =
    #"0000000000000000000000000000000000000000000000000000000000000001"
  let name_a =
    state_token_name(OutputReference { transaction_id: tx_id, output_index: index_a })
  let name_b =
    state_token_name(OutputReference { transaction_id: tx_id, output_index: index_b })
  // Equal names imply equal indices: the fixed-width encoding cannot alias.
  index_a == index_b || name_a != name_b
}
