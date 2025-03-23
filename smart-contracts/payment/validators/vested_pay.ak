use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval.{Finite, Interval, IntervalBound, PositiveInfinity}
use aiken/primitive/bytearray
use cardano/address.{Address}
use cardano/assets.{Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, ValidityRange,
  find_input,
}

type POSIXTime =
  Int

pub type State {
  FundsLocked
  ResultSubmitted
  RefundRequested
  Disputed
}

//this will be provided by the buyer and accepted by the seller off-chain
pub type Datum {
  buyer: VerificationKeyHash,
  seller: VerificationKeyHash,
  reference_id: ByteArray,
  input_hash: ByteArray,
  result_hash: ByteArray,
  submit_result_time: POSIXTime,
  unlock_time: POSIXTime,
  external_dispute_unlock_time: POSIXTime,
  seller_cooldown_time: POSIXTime,
  buyer_cooldown_time: POSIXTime,
  state: State,
}

pub type Action {
  //this will only work after the unlock time
  Withdraw
  //this will set the state to RefundRequested, can only be called before the unlock_time
  SetRefundRequested
  //this will cancel any refund request and unlock the funds (immediately if the unlock time is over)
  UnSetRefundRequested
  //is implicitly allowed if the refund was requested and the refund time is over (and not denied) or if the submit_result_time is over and no result was submitted
  WithdrawRefund
  //multi sig 2/3 to withdraw the disputed funds via network admins
  WithdrawDisputed
  //submits the result hash to the contract and thereby denies any pending (or future) refund
  SubmitResult
  //this will approve a refund withdrawal, can only be called in case of a disputed state
  AuthorizeRefund
}

validator vested_pay(
  required_admins_multi_sig: Int,
  admin_vks: List<VerificationKeyHash>,
  fee_address: Address,
  fee_permille: Int,
  cooldown_period: Int,
) {
  spend(
    datum: Option<Datum>,
    redeemer: Action,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(Datum {
      buyer,
      seller,
      reference_id,
      input_hash,
      result_hash,
      submit_result_time,
      unlock_time,
      external_dispute_unlock_time,
      seller_cooldown_time,
      buyer_cooldown_time,
      state,
    }) = datum
    let Transaction { validity_range, .. } = self
    expect Finite(tx_latest_time) = validity_range.upper_bound.bound_type
    let current_time = tx_latest_time
    let cooldown_time = current_time + cooldown_period

    //requires 15 min cooldown
    expect Some(input) =
      self.inputs
        |> find_input(own_ref)

    let count_script_address = input.output.address

    let inputs =
      self.inputs
        |> list.filter(fn(input) { input.output.address == count_script_address })
    //ensure there is only one input utxo from our script, to prevent double spending
    expect list.length(inputs) == 1

    let outputs =
      self.outputs
        |> list.filter(fn(output) { output.address == count_script_address })

    expect list.length(outputs) <= 1

    expect
      self.outputs
        |> list.all(
            fn(output) {
              validate_no_reference_script_attacked_to_script(
                output,
                count_script_address,
              )
            },
          )

    when redeemer is {
      // Seller can withdraw after unlock_time if no refund was requested
      Withdraw -> {
        expect must_be_signed_by(self, seller)

        expect must_start_after(validity_range, unlock_time)
        expect state == ResultSubmitted

        expect Some(fee_output) =
          self.outputs
            |> list.filter(fn(output) { output.address == fee_address })
            |> list.head()

        expect
          fee_value_is_preserved(
            input.output.value,
            fee_output.value,
            fee_permille,
          )

        bytearray.is_empty(result_hash) == False
      }

      SetRefundRequested -> {
        expect Some(output) =
          self.outputs
            |> list.filter(fn(output) { output.address == count_script_address })
            |> list.head()
        expect InlineDatum(maybe_new_datum) = output.datum
        expect new_datum: Datum = maybe_new_datum
        expect must_be_signed_by(self, buyer)
        expect output_value_is_preserved(input.output.value, output.value)

        expect must_end_before(validity_range, unlock_time)
        expect must_start_after(validity_range, buyer_cooldown_time)

        expect or {
            state == FundsLocked,
            state == ResultSubmitted,
            //allow to set the field again, to signal a dispute when the result hash is updated
            state == Disputed,
          }

        let new_state =
          if bytearray.is_empty(result_hash) {
            RefundRequested
          } else {
            Disputed
          }

        and {
          new_datum.buyer == buyer,
          new_datum.seller == seller,
          new_datum.reference_id == reference_id,
          new_datum.input_hash == input_hash,
          new_datum.result_hash == result_hash,
          new_datum.unlock_time == unlock_time,
          new_datum.submit_result_time == submit_result_time,
          new_datum.external_dispute_unlock_time == external_dispute_unlock_time,
          new_datum.seller_cooldown_time == 0,
          new_datum.buyer_cooldown_time >= cooldown_time,
          new_datum.state == new_state,
        }
      }
      // Seller can approve the refund request by letting it run into the refund time
      WithdrawRefund -> {
        expect must_be_signed_by(self, buyer)
        expect or {
            state == FundsLocked,
            state == RefundRequested,
          }

        and {
          must_start_after(validity_range, submit_result_time),
          bytearray.is_empty(result_hash),
        }
      }
      //The buyer can cancel the refund request, if the vesting period is over, this will immediately give the seller the option to withdraw any funds
      UnSetRefundRequested -> {
        expect Some(output) =
          self.outputs
            |> list.filter(fn(output) { output.address == count_script_address })
            |> list.head()
        expect InlineDatum(maybe_new_datum) = output.datum
        expect new_datum: Datum = maybe_new_datum
        expect must_be_signed_by(self, buyer)

        //expect the locked value to be preserved
        expect output_value_is_preserved(input.output.value, output.value)
        expect must_start_after(validity_range, buyer_cooldown_time)

        expect or {
            state == RefundRequested,
            state == Disputed,
          }

        let new_state =
          if bytearray.is_empty(result_hash) {
            FundsLocked
          } else {
            ResultSubmitted
          }

        //we always allow to cancel the refund request
        and {
          new_datum.buyer == buyer,
          new_datum.seller == seller,
          new_datum.reference_id == reference_id,
          new_datum.input_hash == input_hash,
          new_datum.result_hash == result_hash,
          new_datum.submit_result_time == submit_result_time,
          new_datum.unlock_time == unlock_time,
          new_datum.external_dispute_unlock_time == external_dispute_unlock_time,
          new_datum.seller_cooldown_time == 0,
          new_datum.buyer_cooldown_time >= cooldown_time,
          new_datum.state == new_state,
        }
      }
      //multi sig 2/X to withdraw the disputed funds via network admins
      WithdrawDisputed -> {
        expect bytearray.is_empty(result_hash) == False

        expect must_start_after(validity_range, external_dispute_unlock_time)

        //this allows to add one admin multiple times, giving them more voting power
        let countOfAdmins = list.length(admin_vks)
        //safety check to require at least one admin and disallow misconfigured contracts
        expect countOfAdmins >= 1
        //safety check to disallow anyone to withdraw from a misconfigured contract
        expect required_admins_multi_sig > 0

        expect state == Disputed

        let signedBy =
          list.filter(admin_vks, fn(vk) { must_be_signed_by(self, vk) })
        //this allows to add one admin multiple times, giving them more voting power
        list.length(signedBy) >= required_admins_multi_sig
      }
      SubmitResult -> {
        expect Some(output) =
          self.outputs
            |> list.filter(fn(output) { output.address == count_script_address })
            |> list.head()
        expect InlineDatum(maybe_new_datum) = output.datum
        expect new_datum: Datum = maybe_new_datum

        expect must_be_signed_by(self, seller)

        expect or {
            must_end_before(validity_range, submit_result_time),
            and {
              must_end_before(validity_range, external_dispute_unlock_time),
              bytearray.is_empty(result_hash) == False,
            },
          }

        expect output_value_is_preserved(input.output.value, output.value)
        expect must_start_after(validity_range, seller_cooldown_time)
        expect bytearray.is_empty(new_datum.result_hash) == False

        expect or {
            state == FundsLocked,
            state == RefundRequested,
            //allow to set the field again, to update to a new result
            state == ResultSubmitted,
            state == Disputed,
          }

        let new_state =
          if state == FundsLocked || state == ResultSubmitted {
            ResultSubmitted
          } else {
            Disputed
          }

        and {
          new_datum.buyer == buyer,
          new_datum.seller == seller,
          new_datum.reference_id == reference_id,
          new_datum.unlock_time == unlock_time,
          new_datum.input_hash == input_hash,
          new_datum.submit_result_time == submit_result_time,
          new_datum.external_dispute_unlock_time == external_dispute_unlock_time,
          new_datum.seller_cooldown_time >= cooldown_time,
          new_datum.buyer_cooldown_time == 0,
          new_datum.state == new_state,
        }
      }

      AuthorizeRefund -> {
        expect Some(output) =
          self.outputs
            |> list.filter(fn(output) { output.address == count_script_address })
            |> list.head()
        expect InlineDatum(maybe_new_datum) = output.datum
        expect new_datum: Datum = maybe_new_datum
        expect must_be_signed_by(self, seller)

        //expect the locked value to be preserved
        expect output_value_is_preserved(input.output.value, output.value)

        expect state == Disputed

        expect bytearray.is_empty(new_datum.result_hash)
        expect must_start_after(validity_range, buyer_cooldown_time)
        and {
          new_datum.buyer == buyer,
          new_datum.seller == seller,
          new_datum.reference_id == reference_id,
          new_datum.submit_result_time == submit_result_time,
          new_datum.input_hash == input_hash,
          new_datum.unlock_time == unlock_time,
          new_datum.external_dispute_unlock_time == external_dispute_unlock_time,
          new_datum.seller_cooldown_time >= cooldown_time,
          new_datum.buyer_cooldown_time == 0,
          new_datum.state == RefundRequested,
        }
      }
    }
  }

  else(_) {
    fail
  }
}

fn validate_no_reference_script_attacked_to_script(
  output: Output,
  script_address: Address,
) -> Bool {
  if output.address == script_address {
    output.reference_script == None
  } else {
    True
  }
}

fn output_value_is_preserved(input_value: Value, output_value: Value) {
  input_value == output_value
}

test output_value_is_preserved_succeeds() {
  let input_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 51)
      |> assets.add("foo2", "bar", 32)
      |> assets.add("foo2", "baz", 1)
  let output_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 51)
      |> assets.add("foo2", "bar", 32)
      |> assets.add("foo2", "baz", 1)
  output_value_is_preserved(input_value, output_value)
}

test output_value_is_preserved_fails_1() {
  let input_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 42)

  let output_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 4)
      |> assets.add("foo2", "bar", 42)
      |> assets.add("foo", "baz", 100)
  output_value_is_preserved(input_value, output_value) == False
}

test output_value_is_preserved_fails_2() {
  let input_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 42)

  let output_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo2", "bar", 42)
      |> assets.add("foo", "baz", 100)
  output_value_is_preserved(input_value, output_value) == False
}

test output_value_is_preserved_fails_0() {
  let input_value: Value = assets.from_lovelace(105)

  let output_value: Value = assets.from_lovelace(100)
  output_value_is_preserved(input_value, output_value) == False
}

test output_value_is_preserved_fails_3() {
  let input_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 42)

  let output_value: Value =
    assets.from_lovelace(98)
      |> assets.add("foo", "bar", 42)
      |> assets.add("foo", "baz", 100)
  output_value_is_preserved(input_value, output_value) == False
}

test output_value_is_preserved_fails_4() {
  let input_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 42)

  let output_value: Value =
    assets.from_lovelace(98)
      |> assets.add("foo", "bar", 43)
  output_value_is_preserved(input_value, output_value) == False
}

test output_value_is_preserved_fails_5() {
  let input_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 42)

  let output_value: Value =
    assets.from_lovelace(98)
      |> assets.add("foo", "bar", 42)
      |> assets.add("foo", "bar1", 1)
  output_value_is_preserved(input_value, output_value) == False
}

fn fee_value_is_preserved(
  input_value: Value,
  output_value: Value,
  fee_permille: Int,
) {
  //ignore if the output contains more assets than the input 
  assets.flatten(input_value)
    |> list.all(
        fn(asset) {
          let fee_amount = asset.3rd * fee_permille / 1000
          //cutoff to round down
          let out_value = assets.quantity_of(output_value, asset.1st, asset.2nd)
          out_value >= fee_amount
        },
      )
}

test fee_value_is_preserved_succeeds() {
  let input_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 42)
      |> assets.add("foo2", "bar", 32) //correctly round down and ignore 0
      |> assets.add("foo2", "baz", 1)
  let output_value: Value =
    //check for correct equal behavior
    assets.from_lovelace(10) //check for correct rounding behavior
      |> assets.add("foo", "bar", 4) //ignore additional assets
      |> assets.add("foo", "baz", 4) //allow bigger output value
      |> assets.add("foo2", "bar", 4)
  fee_value_is_preserved(input_value, output_value, 100)
}

test fee_value_is_preserved_fails_5() {
  let input_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 42)
      |> assets.add("foo", "bar", 8)

  let output_value: Value =
    //check for correct equal behavior
    assets.from_lovelace(10) //check for correct rounding behavior
      |> assets.add("foo", "bar", 4)

  fee_value_is_preserved(input_value, output_value, 100) == False
}

test fee_value_is_preserved_fails_1() {
  let input_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 50)

  let output_value: Value =
    //check for correct equal behavior
    assets.from_lovelace(10) //check for failing down
      |> assets.add("foo", "bar", 4)
      |> assets.add("foo", "baz", 5)
      |> assets.add("foo1", "bar", 5)

  fee_value_is_preserved(input_value, output_value, 100) == False
}

test fee_value_is_preserved_fails_4() {
  let input_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 50)

  let output_value: Value =
    //check for correct equal behavior
    assets.from_lovelace(10) //check for failing not included
      |> assets.add("foo", "baz", 5)

  fee_value_is_preserved(input_value, output_value, 100) == False
}

test fee_value_is_preserved_fails_2() {
  let input_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 50)

  let output_value: Value =
    //check for correct equal behavior
    assets.from_lovelace(10) //check for failing down
      |> assets.add("foo", "bar", 4)

  fee_value_is_preserved(input_value, output_value, 100) == False
}

test fee_value_is_preserved_fails_3() {
  let input_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 50)

  let output_value: Value =
    //check for correct equal behavior
    assets.from_lovelace(9) //check for failing down
      |> assets.add("foo", "bar", 60)

  fee_value_is_preserved(input_value, output_value, 100) == False
}

fn must_be_signed_by(transaction: Transaction, vk: VerificationKeyHash) {
  list.has(transaction.extra_signatories, vk)
}

fn must_start_after(range: ValidityRange, lock_expiration_time: POSIXTime) {
  when range.lower_bound.bound_type is {
    Finite(tx_earliest_time) -> lock_expiration_time <= tx_earliest_time
    _ -> False
  }
}

test must_start_after_succeed_when_lower_bound_is_after() {
  must_start_after(interval.after(2), 1)
}

test must_start_after_succeed_when_lower_bound_is_equal() {
  must_start_after(interval.after(2), 2)
}

test must_start_after_fail_when_lower_bound_is_before() {
  must_start_after(interval.after(2), 3) == False
}

test must_start_after_fail_if_infinite() {
  must_start_after(
    Interval {
      lower_bound: IntervalBound {
        bound_type: PositiveInfinity,
        is_inclusive: True,
      },
      upper_bound: IntervalBound {
        bound_type: PositiveInfinity,
        is_inclusive: True,
      },
    },
    3,
  ) == False
}

test must_start_after_success_if_custom_lower_bound() {
  must_start_after(
    Interval {
      lower_bound: IntervalBound { bound_type: Finite(10), is_inclusive: True },
      upper_bound: IntervalBound {
        bound_type: PositiveInfinity,
        is_inclusive: True,
      },
    },
    8,
  )
}

fn must_end_before(range: ValidityRange, lock_expiration_time: POSIXTime) {
  when range.upper_bound.bound_type is {
    Finite(tx_latest_time) -> tx_latest_time < lock_expiration_time
    _ -> False
  }
}

test must_end_before_succeed_when_upper_bound_is_before() {
  must_end_before(interval.before(1), 2)
}

test must_end_before_fail_when_upper_bound_is_equal() {
  must_end_before(interval.before(2), 2) == False
}

test must_end_before_fail_when_upper_bound_is_after() {
  must_end_before(interval.before(2), 1) == False
}

test must_end_before_fail_when_upper_bound_is_not_set() {
  must_end_before(interval.after(2), 3) == False
}

test must_end_before_fail_if_infinite() {
  must_end_before(
    Interval {
      lower_bound: IntervalBound { bound_type: Finite(10), is_inclusive: True },
      upper_bound: IntervalBound {
        bound_type: PositiveInfinity,
        is_inclusive: True,
      },
    },
    3,
  ) == False
}
