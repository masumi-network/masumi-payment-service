use aiken/cbor
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash, blake2b_224, verify_ed25519_signature}
use aiken/interval.{Finite, Interval, IntervalBound, PositiveInfinity}
use aiken/primitive/bytearray
use cardano/address.{Address, VerificationKey}
use cardano/assets.{Value, lovelace_of}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, ValidityRange,
  find_input,
}

type POSIXTime =
  Int

pub type AssetValue =
  Pairs<ByteArray, Pairs<ByteArray, Int>>

pub type State {
  FundsLocked
  ResultSubmitted
  RefundRequested
  Disputed
  WithdrawAuthorized
  RefundAuthorized
}

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

pub type AdminSignature {
  verification_key: ByteArray,
  protected_headers: ByteArray,
  signature: ByteArray,
}

pub type DisputeWithdrawal {
  own_ref: OutputReference,
  buyer_value: AssetValue,
  seller_value: AssetValue,
}

pub type Action {
  // Seller withdraws after unlock_time once a result was submitted.
  Withdraw
  // Buyer requests a refund before unlock_time; moves to Disputed if a result exists.
  SetRefundRequested
  // Buyer authorizes seller withdrawal from a disputed state.
  AuthorizeWithdrawal
  // Buyer withdraws when no result was submitted before submit_result_time.
  WithdrawRefund
  // Anyone can settle a dispute with enough CIP-8 admin signatures.
  WithdrawDisputed {
    buyer_value: AssetValue,
    seller_value: AssetValue,
    admin_signatures: List<AdminSignature>,
  }
  // Seller submits the result hash, denying a simple refund path.
  SubmitResult
  // Seller authorizes a refund after a dispute.
  AuthorizeRefund
}

validator vested_pay(
  required_admins_multi_sig: Int,
  admin_vks: List<VerificationKeyHash>,
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
      buyer_return_address,
      seller,
      seller_return_address,
      reference_key,
      reference_signature,
      seller_nonce,
      buyer_nonce,
      agent_identifier,
      collateral_return_lovelace,
      input_hash,
      result_hash,
      pay_by_time,
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
    // New cooldown timestamps are derived from the validator parameter.
    let cooldown_time = current_time + cooldown_period

    expect Some(input) =
      self.inputs
        |> find_input(own_ref)

    let count_script_address = input.output.address

    // Multiple script inputs may be spent together, but each must carry a
    // distinct reference_signature to avoid duplicated state entries.
    let script_inputs =
      list.filter(
        self.inputs,
        fn(input) { input.output.address == count_script_address },
      )
    let input_datum_signatures =
      script_inputs
        |> list.map(
            fn(input) {
              expect InlineDatum(maybe_datum) = input.output.datum
              expect old_datum: Datum = maybe_datum
              old_datum.reference_signature
            },
          )

    expect
      list.length(list.unique(input_datum_signatures)) == list.length(
        script_inputs,
      )

    let script_output_with_datum =
      self.outputs
        |> list.filter(fn(output) { output.address == count_script_address })
        |> list.map(
            fn(output) {
              expect output.reference_script == None
              expect InlineDatum(maybe_new_datum) = output.datum
              expect new_datum: Datum = maybe_new_datum
              Pair(output, new_datum)
            },
          )

    let output_datum_signatures =
      script_output_with_datum
        |> list.map(
            fn(output_and_datum) {
              let Pair(_, new_datum) = output_and_datum
              new_datum.reference_signature
            },
          )

    expect
      list.length(list.unique(output_datum_signatures)) == list.length(
        script_output_with_datum,
      )

    when redeemer is {
      // Seller withdraws funds. Two valid paths:
      //   1. state == WithdrawAuthorized — the buyer has explicitly signed
      //      AuthorizeWithdrawal, so the seller may withdraw immediately. No
      //      time bound applies; buyer authorization is the sole gate and is
      //      intended to short-circuit unlock_time / cooldown windows.
      //   2. state == ResultSubmitted — the buyer has not authorized, so the
      //      seller must wait until validity_range starts at or after
      //      unlock_time. This is the only path that requires waiting.
      // Any other state (FundsLocked, RefundRequested, Disputed,
      // RefundAuthorized) is rejected.
      Withdraw -> {
        let continuation_utxo =
          output_datum_signatures
            |> list.find(fn(signature) { signature == reference_signature })
        expect continuation_utxo == None
        expect lovelace_of(input.output.value) >= collateral_return_lovelace
        expect Some(seller_vk) = address_to_verification_key(seller)
        expect must_be_signed_by(self, seller_vk)

        expect or {
            // Path 1: buyer-authorized instant withdrawal. Intentional bypass
            // of unlock_time / cooldown — see comment above.
            state == WithdrawAuthorized,
            // Path 2: result was submitted but not authorized, must wait.
            and {
              must_start_after(validity_range, unlock_time),
              state == ResultSubmitted,
            },
          }

        let collateral_return_outputs =
          outputs_with_reference_tag(
            self.outputs,
            own_ref,
            buyer,
            buyer_return_address,
          )

        let assets_returned =
          list.foldl(
            collateral_return_outputs,
            assets.zero,
            fn(n, acc) { assets.merge(n.value, acc) },
          )
        expect lovelace_of(assets_returned) >= collateral_return_lovelace

        // Optional tagged seller-return output for wallets that need a fixed payout address.
        expect
          when seller_return_address is {
            Some(seller_return_address) -> {
              let seller_value_to_return =
                value_minus_lovelace(
                  input.output.value,
                  collateral_return_lovelace,
                )
              let funding_outputs =
                outputs_with_reference_tag(
                  self.outputs,
                  own_ref,
                  seller,
                  Some(seller_return_address),
                )
              let value_returned =
                list.foldl(
                  funding_outputs,
                  assets.zero,
                  fn(n, acc) { assets.merge(n.value, acc) },
                )
              value_bigger_or_equal(value_returned, seller_value_to_return)
            }
            None -> True
          }

        bytearray.is_empty(result_hash) == False
      }

      SetRefundRequested -> {
        let new_state =
          if bytearray.is_empty(result_hash) {
            RefundRequested
          } else {
            Disputed
          }

        let output_and_datum =
          script_output_with_datum
            |> list.find(
                fn(output_and_datum) {
                  let Pair(_, new_datum) = output_and_datum
                  and {
                    new_datum.buyer == buyer,
                    new_datum.buyer_return_address == buyer_return_address,
                    new_datum.seller == seller,
                    new_datum.seller_return_address == seller_return_address,
                    new_datum.reference_key == reference_key,
                    new_datum.reference_signature == reference_signature,
                    new_datum.seller_nonce == seller_nonce,
                    new_datum.buyer_nonce == buyer_nonce,
                    new_datum.collateral_return_lovelace == collateral_return_lovelace,
                    new_datum.input_hash == input_hash,
                    new_datum.result_hash == result_hash,
                    new_datum.pay_by_time == pay_by_time,
                    new_datum.unlock_time == unlock_time,
                    new_datum.submit_result_time == submit_result_time,
                    new_datum.external_dispute_unlock_time == external_dispute_unlock_time,
                    new_datum.seller_cooldown_time == 0,
                    new_datum.buyer_cooldown_time >= cooldown_time,
                    new_datum.state == new_state,
                    new_datum.agent_identifier == agent_identifier,
                  }
                },
              )

        expect Some(output_and_datum) = output_and_datum
        let Pair(output, _) = output_and_datum

        expect output_value_is_preserved(input.output.value, output.value)

        expect Some(buyer_vk) = address_to_verification_key(buyer)
        expect must_be_signed_by(self, buyer_vk)

        expect must_end_before(validity_range, unlock_time)
        expect must_start_after(validity_range, buyer_cooldown_time)

        or {
          state == FundsLocked,
          state == ResultSubmitted,
          // Allow requesting a refund again to signal a dispute after result submission.
          state == Disputed,
        }
      }

      // Buyer withdraws a refund after the result submission deadline passed
      // without any result hash.
      WithdrawRefund -> {
        let continuation_utxo =
          output_datum_signatures
            |> list.find(fn(signature) { signature == reference_signature })
        expect continuation_utxo == None
        expect Some(buyer_vk) = address_to_verification_key(buyer)
        expect must_be_signed_by(self, buyer_vk)
        expect or {
            state == FundsLocked,
            state == RefundRequested,
            state == RefundAuthorized,
          }
        expect
          when buyer_return_address is {
            Some(buyer_return_address) -> {
              let funding_outputs =
                outputs_with_reference_tag(
                  self.outputs,
                  own_ref,
                  buyer,
                  Some(buyer_return_address),
                )
              let value_returned =
                list.foldl(
                  funding_outputs,
                  assets.zero,
                  fn(n, acc) { assets.merge(n.value, acc) },
                )
              value_bigger_or_equal(value_returned, input.output.value)
            }
            None -> True
          }

        expect or {
            must_start_after(validity_range, submit_result_time),
            state == RefundAuthorized,
          }
        bytearray.is_empty(result_hash)
      }
      // Buyer authorizes seller withdrawal from a disputed payment.
      AuthorizeWithdrawal -> {
        expect bytearray.is_empty(result_hash) == False

        let output_and_datum =
          script_output_with_datum
            |> list.find(
                fn(output_and_datum) {
                  let Pair(_, new_datum) = output_and_datum
                  and {
                    new_datum.buyer == buyer,
                    new_datum.buyer_return_address == buyer_return_address,
                    new_datum.seller == seller,
                    new_datum.seller_return_address == seller_return_address,
                    new_datum.reference_key == reference_key,
                    new_datum.reference_signature == reference_signature,
                    new_datum.seller_nonce == seller_nonce,
                    new_datum.buyer_nonce == buyer_nonce,
                    new_datum.collateral_return_lovelace == collateral_return_lovelace,
                    new_datum.input_hash == input_hash,
                    new_datum.result_hash == result_hash,
                    new_datum.pay_by_time == pay_by_time,
                    new_datum.submit_result_time == submit_result_time,
                    new_datum.unlock_time == unlock_time,
                    new_datum.external_dispute_unlock_time == external_dispute_unlock_time,
                    new_datum.seller_cooldown_time == 0,
                    new_datum.buyer_cooldown_time >= cooldown_time,
                    new_datum.state == WithdrawAuthorized,
                    new_datum.agent_identifier == agent_identifier,
                  }
                },
              )
        expect Some(output_and_datum) = output_and_datum
        let Pair(output, _) = output_and_datum

        expect Some(buyer_vk) = address_to_verification_key(buyer)
        expect must_be_signed_by(self, buyer_vk)

        // Preserve the locked value in the continuing output.
        expect output_value_is_preserved(input.output.value, output.value)
        expect must_start_after(validity_range, buyer_cooldown_time)

        state == Disputed
      }

      // Anyone can settle a dispute by providing enough wallet-compatible
      // admin signatures over the signed buyer/seller minimum payouts.
      WithdrawDisputed { buyer_value, seller_value, admin_signatures } -> {
        let continuation_utxo =
          output_datum_signatures
            |> list.find(fn(signature) { signature == reference_signature })
        expect continuation_utxo == None

        expect bytearray.is_empty(result_hash) == False

        // Admins must only collect signatures after this timestamp. Combined
        // with SubmitResult's own `must_end_before(external_dispute_unlock_time)`
        // guard (see SubmitResult below), this means once admins begin signing
        // the seller can no longer mutate the UTxO via SubmitResult, so the
        // own_ref captured in DisputeWithdrawal cannot be invalidated by a
        // racing seller transaction.
        expect must_start_after(validity_range, external_dispute_unlock_time)

        // INTENTIONAL: admin_vks may contain duplicates as a weighted-voting
        // mechanism. A vkey appearing N times counts as N votes when matched
        // against signatures, so a single physical admin signature can satisfy
        // multiple slots. This is by design — it is the deployer's
        // responsibility (off-chain) to construct admin_vks with the desired
        // weight distribution. The contract does NOT enforce distinctness.
        let countOfAdmins = list.length(admin_vks)
        // Require at least one configured admin.
        expect countOfAdmins >= 1
        // Prevent a zero-threshold configuration from authorizing everyone.
        expect required_admins_multi_sig > 0

        expect state == Disputed

        let buyer_value_to_pay = assets.from_asset_list(buyer_value)
        let seller_value_to_pay = assets.from_asset_list(seller_value)

        let buyer_value_returned =
          outputs_with_reference_tag(
            self.outputs,
            own_ref,
            buyer,
            buyer_return_address,
          )
            |> output_values()

        expect value_bigger_or_equal(buyer_value_returned, buyer_value_to_pay)

        let seller_value_returned =
          outputs_with_reference_tag(
            self.outputs,
            own_ref,
            seller,
            seller_return_address,
          )
            |> output_values()

        expect value_bigger_or_equal(seller_value_returned, seller_value_to_pay)

        // INTENTIONAL: the signed buyer_value / seller_value are MINIMUM
        // payouts, not exact amounts. Any escrow value above the sum of the
        // minimums is intentionally left unconstrained on-chain and accrues to
        // whichever wallet builds and submits this transaction (the dispute
        // settlement submitter). This is a deliberate economic incentive so
        // that a third party is motivated to land the settlement tx without
        // requiring buyer or seller to spend their own ADA on fees. Admins
        // sign with full knowledge of the residual amount.
        //
        // Replay binding: own_ref is part of the signed payload, so an admin
        // signature authorizes settlement of exactly one UTxO (uniquely
        // identified by (tx_id, output_index)) and cannot be reused against
        // any other UTxO — including other deployments of this validator,
        // since OutputReferences are globally unique per chain.
        let signed_message =
          cbor.serialise(
            DisputeWithdrawal { own_ref, buyer_value, seller_value },
          )
            |> blake2b_224()

        let signedBy =
          list.filter(
            admin_vks,
            fn(vk) {
              has_valid_admin_signature(vk, signed_message, admin_signatures)
            },
          )
        // Duplicate admin hashes in admin_vks count as weighted votes (see
        // weighted-voting note above where countOfAdmins is computed).
        list.length(signedBy) >= required_admins_multi_sig
      }
      SubmitResult -> {
        let new_state =
          if state == FundsLocked || state == ResultSubmitted {
            ResultSubmitted
          } else {
            Disputed
          }
        expect lovelace_of(input.output.value) >= collateral_return_lovelace
        expect or {
            state == FundsLocked,
            state == ResultSubmitted,
            state == Disputed,
            state == RefundRequested,
          }
        let output_and_datum =
          script_output_with_datum
            |> list.find(
                fn(output_and_datum) {
                  let Pair(_, new_datum) = output_and_datum
                  and {
                    new_datum.buyer == buyer,
                    new_datum.buyer_return_address == buyer_return_address,
                    new_datum.seller == seller,
                    new_datum.seller_return_address == seller_return_address,
                    new_datum.reference_key == reference_key,
                    new_datum.reference_signature == reference_signature,
                    new_datum.seller_nonce == seller_nonce,
                    new_datum.buyer_nonce == buyer_nonce,
                    new_datum.collateral_return_lovelace == collateral_return_lovelace,
                    new_datum.pay_by_time == pay_by_time,
                    new_datum.unlock_time == unlock_time,
                    new_datum.input_hash == input_hash,
                    bytearray.is_empty(new_datum.result_hash) == False,
                    new_datum.submit_result_time == submit_result_time,
                    new_datum.external_dispute_unlock_time == external_dispute_unlock_time,
                    new_datum.seller_cooldown_time >= cooldown_time,
                    new_datum.buyer_cooldown_time == 0,
                    new_datum.state == new_state,
                    new_datum.agent_identifier == agent_identifier,
                  }
                },
              )

        expect Some(output_and_datum) = output_and_datum
        let Pair(output, _) = output_and_datum
        expect Some(seller_vk) = address_to_verification_key(seller)
        expect must_be_signed_by(self, seller_vk)

        expect output_value_is_preserved(input.output.value, output.value)
        expect must_start_after(validity_range, seller_cooldown_time)
        or {
          must_end_before(validity_range, submit_result_time),
          and {
            must_end_before(validity_range, external_dispute_unlock_time),
            bytearray.is_empty(result_hash) == False,
          },
        }
      }

      AuthorizeRefund -> {
        let output_and_datum =
          script_output_with_datum
            |> list.find(
                fn(output_and_datum) {
                  let Pair(_, new_datum) = output_and_datum
                  and {
                    new_datum.buyer == buyer,
                    new_datum.buyer_return_address == buyer_return_address,
                    new_datum.seller == seller,
                    new_datum.seller_return_address == seller_return_address,
                    new_datum.reference_key == reference_key,
                    new_datum.reference_signature == reference_signature,
                    new_datum.seller_nonce == seller_nonce,
                    new_datum.buyer_nonce == buyer_nonce,
                    new_datum.collateral_return_lovelace == collateral_return_lovelace,
                    new_datum.pay_by_time == pay_by_time,
                    new_datum.submit_result_time == submit_result_time,
                    new_datum.input_hash == input_hash,
                    bytearray.is_empty(new_datum.result_hash),
                    new_datum.unlock_time == unlock_time,
                    new_datum.external_dispute_unlock_time == external_dispute_unlock_time,
                    new_datum.seller_cooldown_time >= cooldown_time,
                    new_datum.buyer_cooldown_time == 0,
                    new_datum.state == RefundAuthorized,
                    new_datum.agent_identifier == agent_identifier,
                  }
                },
              )
        expect Some(output_and_datum) = output_and_datum
        let Pair(output, _) = output_and_datum
        expect Some(seller_vk) = address_to_verification_key(seller)
        expect must_be_signed_by(self, seller_vk)
        expect output_value_is_preserved(input.output.value, output.value)

        expect must_start_after(validity_range, seller_cooldown_time)
        or {
          state == RefundRequested,
          state == Disputed,
          state == FundsLocked,
          state == ResultSubmitted,
        }
      }
    }
  }

  else(_) {
    fail
  }
}

fn output_value_is_preserved(input_value: Value, output_value: Value) {
  assets.match(output_value, input_value, >=)
}

fn outputs_with_reference_tag(
  outputs: List<Output>,
  own_ref: OutputReference,
  default_address: Address,
  return_address: Option<Address>,
) -> List<Output> {
  list.filter(
    outputs,
    fn(output) {
      when output.datum is {
        InlineDatum(output_datum) ->
          // Note that we use a soft-cast here and not an expect, because the transaction
          // might still contain other kind of outputs that we simply chose to ignore.
          // Using expect here would cause the entire transaction to be rejected for any
          // output that doesn't have a datum of that particular shape.
          if output_datum is OutputReference {
            let expected_address =
              when return_address is {
                Some(address) -> address
                None -> default_address
              }
            and {
              output.address == expected_address,
              own_ref == output_datum,
            }
          } else {
            False
          }
        _ -> False
      }
    },
  )
}

fn output_values(outputs: List<Output>) -> Value {
  list.foldl(
    outputs,
    assets.zero,
    fn(output, acc) { assets.merge(output.value, acc) },
  )
}

fn value_minus_lovelace(value: Value, lovelace: Int) -> Value {
  assets.merge(value, assets.negate(assets.from_lovelace(lovelace)))
}

test value_minus_lovelace_subtracts_only_lovelace() {
  let value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 42)
  let expected: Value =
    assets.from_lovelace(60)
      |> assets.add("foo", "bar", 42)
  value_minus_lovelace(value, 40) == expected
}

fn has_valid_admin_signature(
  admin_vk_hash: VerificationKeyHash,
  intent_hash: ByteArray,
  admin_signatures: List<AdminSignature>,
) {
  list.any(
    admin_signatures,
    fn(admin_signature) {
      let sig_structure =
        cip8_sig_structure(admin_signature.protected_headers, intent_hash)
      and {
        blake2b_224(admin_signature.verification_key) == admin_vk_hash,
        verify_ed25519_signature(
          admin_signature.verification_key,
          sig_structure,
          admin_signature.signature,
        ),
      }
    },
  )
}

fn cip8_sig_structure(protected_headers: ByteArray, payload: ByteArray) {
  #"846a5369676e617475726531"
    |> bytearray.concat(cbor_byte_string(protected_headers))
    |> bytearray.concat(#"40")
    |> bytearray.concat(cbor_byte_string(payload))
}

fn cbor_byte_string(bytes: ByteArray) {
  let length = bytearray.length(bytes)
  if length < 24 {
    bytearray.push(bytes, 64 + length)
  } else if length < 256 {
    #"58"
      |> bytearray.concat(bytearray.from_int_big_endian(length, 1))
      |> bytearray.concat(bytes)
  } else if length < 65536 {
    #"59"
      |> bytearray.concat(bytearray.from_int_big_endian(length, 2))
      |> bytearray.concat(bytes)
  } else {
    fail
  }
}

test cbor_byte_string_encodes_short_bytes() {
  cbor_byte_string(#"010203") == #"43010203"
}

test cbor_byte_string_encodes_24_bytes() {
  cbor_byte_string(#"000102030405060708090a0b0c0d0e0f1011121314151617") == #"5818000102030405060708090a0b0c0d0e0f1011121314151617"
}

test cip8_sig_structure_encodes_signature1_array() {
  cip8_sig_structure(#"a10126", #"0001") == #"846a5369676e61747572653143a1012640420001"
}

fn value_bigger_or_equal(
  expected_to_be_bigger_equal_value: Value,
  reference_value: Value,
) {
  let difference =
    assets.merge(
      expected_to_be_bigger_equal_value,
      assets.negate(reference_value),
    )
  assets.reduce(
    difference,
    0,
    fn(_, _, quantity, acc) {
      if quantity < 0 {
        acc + 1
      } else {
        acc
      }
    },
  ) == 0
}

test value_bigger_or_equal_succeeds_when_values_match() {
  let output_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 51)
      |> assets.add("foo2", "bar", 32)
      |> assets.add("foo2", "baz", 1)
  let expected_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 51)
      |> assets.add("foo2", "bar", 32)
      |> assets.add("foo2", "baz", 1)
  value_bigger_or_equal(output_value, expected_value)
}

test value_bigger_or_equal_fails_when_output_asset_is_smaller() {
  let expected_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 51)
      |> assets.add("foo2", "bar", 32)
      |> assets.add("foo2", "baz", 2)
  let output_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 51)
      |> assets.add("foo2", "bar", 32)
      |> assets.add("foo2", "baz", 1)
  value_bigger_or_equal(output_value, expected_value) == False
}

test value_bigger_or_equal_fails_when_output_lovelace_is_smaller() {
  let expected_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 51)
      |> assets.add("foo2", "bar", 32)
      |> assets.add("foo2", "baz", 2)
  let output_value: Value =
    assets.from_lovelace(99)
      |> assets.add("foo", "bar", 51)
      |> assets.add("foo2", "bar", 32)
      |> assets.add("foo2", "baz", 2)
  value_bigger_or_equal(output_value, expected_value) == False
}

test value_bigger_or_equal_succeeds_when_output_lovelace_is_bigger() {
  let output_value: Value =
    assets.from_lovelace(101)
      |> assets.add("foo", "bar", 51)
      |> assets.add("foo2", "bar", 32)
      |> assets.add("foo2", "baz", 2)
  let expected_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 51)
      |> assets.add("foo2", "bar", 32)
      |> assets.add("foo2", "baz", 2)
  value_bigger_or_equal(output_value, expected_value)
}

test value_bigger_or_equal_succeeds_when_output_asset_is_bigger() {
  let output_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 51)
      |> assets.add("foo2", "bar", 32)
      |> assets.add("foo2", "baz", 3)
  let expected_value: Value =
    assets.from_lovelace(100)
      |> assets.add("foo", "bar", 51)
      |> assets.add("foo2", "bar", 32)
      |> assets.add("foo2", "baz", 2)
  value_bigger_or_equal(output_value, expected_value)
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

fn address_to_verification_key(address: Address) -> Option<VerificationKeyHash> {
  when address.payment_credential is {
    VerificationKey(vkey) -> Some(vkey)
    _ -> None
  }
}
