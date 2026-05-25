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

// Minimum length of `reference_signature` in bytes. The field is used as a
// per-UTxO deduplication key both for script inputs and outputs, so a very
// short value would make accidental collisions far more likely.
const min_reference_signature_bytes: Int = 16

// CIP-8 protected headers value pinned to EdDSA (`{1: -8}` = `a10127`). The
// admin signature payload is a CIP-8 Sig_structure, so accepting only the
// standard EdDSA headers prevents header divergence between signers.
const cip8_eddsa_protected_headers: ByteArray = #"a10127"

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
    // Reject malformed datums where the collateral floor is negative; a
    // negative value would invert the `>= collateral_return_lovelace`
    // comparisons used in `Withdraw` / `SubmitResult` and could let the
    // seller withdraw funds without returning the buyer's collateral.
    expect collateral_return_lovelace >= 0
    // L5: a short reference_signature would make the per-UTxO dedupe key in
    // input / output checks below trivially collide; require at least
    // min_reference_signature_bytes bytes.
    expect
      bytearray.length(reference_signature) >= min_reference_signature_bytes
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
    //
    // Malformed-datum handling (intentional): a script input that does not
    // carry an InlineDatum, or whose inline datum does not parse as `Datum`,
    // is filtered out of the dedupe set rather than aborting the whole
    // transaction. The rationale is that anyone can send a UTxO with an
    // arbitrary datum (or no datum) to a script address (dust attack /
    // griefing), and a contract spend that happens to include such an input
    // alongside a legitimate one would otherwise be permanently un-spendable
    // through this validator. Skipping un-parseable inputs treats them as
    // "not part of this batch" — the validator still enforces all of its
    // checks on the parseable inputs, and the un-parseable input must
    // separately satisfy SOME validator path of its own (which it cannot, so
    // including it as a script input is itself a tx-builder mistake and the
    // mistake's blast radius is limited to that one builder).
    //
    // O(n²) note on list.unique below: the unique check is quadratic in the
    // number of parseable script inputs but bounded in practice by Cardano's
    // ledger-enforced limits on script inputs per tx (currently ~30 effective
    // for typical Plutus scripts due to CPU / mem units). No explicit
    // application-level cap is added here — we rely on the ledger-level cap.
    // If ledger limits are ever raised significantly, revisit this loop.
    let script_inputs =
      list.filter(
        self.inputs,
        fn(input) { input.output.address == count_script_address },
      )
    let input_datum_signatures =
      script_inputs
        |> list.filter_map(
            fn(input) {
              when input.output.datum is {
                InlineDatum(maybe_datum) ->
                  if maybe_datum is parsed_datum: Datum {
                    Some(parsed_datum.reference_signature)
                  } else {
                    None
                  }
                _ -> None
              }
            },
          )

    expect
      list.length(list.unique(input_datum_signatures)) == list.length(
        input_datum_signatures,
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

    // L5: every script-output datum carrying a reference_signature must meet
    // the minimum length; the dedupe check above only ensures uniqueness, not
    // sufficient entropy.
    expect
      list.all(
        output_datum_signatures,
        fn(signature) {
          bytearray.length(signature) >= min_reference_signature_bytes
        },
      )

    when redeemer is {
      // Seller withdraws funds. Two valid paths:
      //   1. state == WithdrawAuthorized — the buyer has explicitly signed
      //      AuthorizeWithdrawal, so the seller may withdraw immediately. No
      //      time bound applies; buyer authorization is the sole gate and is
      //      intended to short-circuit unlock_time / cooldown windows.
      //      INTENTIONAL: `buyer_cooldown_time` (written by the preceding
      //      AuthorizeWithdrawal transition) is NOT consulted on this path.
      //      The buyer's signature on AuthorizeWithdrawal is "final" — once
      //      authorized, the seller can withdraw in the very next block. The
      //      cooldown field on a WithdrawAuthorized continuation is therefore
      //      informational only (off-chain UIs may surface it as a "buyer
      //      may revoke before T" hint, but the contract does not gate on it).
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

        // INTENTIONAL — "double-satisfaction" when buyer == seller (or
        // buyer_return_address == seller_return_address): a single tx output
        // tagged with `own_ref` and addressed to the shared target satisfies
        // BOTH the collateral-return filter (below) AND the seller-residual
        // filter (further below) simultaneously. This is acceptable because
        // it is not exploitable cross-party — the "victim" and the "winner"
        // of any aggregated payout are the same on-chain identity (the locked
        // datum is what binds both legs to the same return address, and the
        // datum is set by the buyer at lock time). No third party can drain
        // anyone else's funds via this aggregation; at worst, the tx builder
        // accounts for a single output as covering two roles. Off-chain tx
        // builders that want separate accounting MUST split the outputs
        // explicitly — the validator only enforces economic safety, not
        // bookkeeping clarity.
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

        // Optional tagged seller-return output. The presence of
        // `seller_return_address` in the datum IS the on-chain payout-binding
        // contract: when set, this branch enforces that at least the
        // (input.value - collateral_return_lovelace) lands at that address,
        // tagged with `own_ref`. When NOT set, the seller's signature is the
        // sole gate — the seller may route the residual to any address they
        // choose. This is intentional: omitting the return address is the
        // explicit opt-in to "I will sign the destination myself, no on-chain
        // payout binding." Off-chain tooling that wants address-bound payouts
        // MUST populate `seller_return_address` at lock time.
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
            // INTENTIONAL: with no return address, the seller's signature is
            // the only gate. The seller signs and chooses the destination —
            // any address, any asset. This is by design: the datum field
            // doubles as the on-chain payout-binding opt-in. Callers that
            // need address enforcement (including non-ADA token routing) MUST
            // populate `seller_return_address` at lock time.
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
        // The presence of `buyer_return_address` in the datum IS the on-chain
        // payout-binding contract — symmetric to `seller_return_address` in
        // the Withdraw branch above. When set, this branch enforces that the
        // full input value lands at that address, tagged with `own_ref`.
        // When NOT set, the buyer's signature is the sole gate — the buyer
        // may route the entire refund (lovelace + any tokens in escrow) to
        // any address they choose. This is intentional: omitting the return
        // address is the explicit opt-in to "I will sign the destination
        // myself." Callers that want address-bound refunds (including
        // non-ADA token routing) MUST populate `buyer_return_address` at
        // lock time.
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
            // INTENTIONAL: see comment above. Buyer signature gates the tx
            // and the buyer chooses the destination.
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
        //
        // Worked example: a 5-of-7 weighted multisig where the CEO holds 2
        // weight slots and each of 5 board members holds 1 slot can be
        // expressed as `admin_vks = [ceo, ceo, b1, b2, b3, b4, b5]` with
        // `required_admins_multi_sig = 5`. A single physical signature from
        // the CEO counts twice, so the CEO + any three board members can
        // settle. This contrasts with a naive multisig design where duplicate
        // keys would be a deployment bug. Off-chain tooling MUST construct
        // `admin_vks` with the correct duplication when modeling weighted
        // authorities and MUST surface the weights to deployers.
        let countOfAdmins = list.length(admin_vks)
        // Require at least one configured admin.
        expect countOfAdmins >= 1
        // Prevent a zero-threshold configuration from authorizing everyone.
        expect required_admins_multi_sig > 0

        expect state == Disputed

        let buyer_value_to_pay = assets.from_asset_list(buyer_value)
        let seller_value_to_pay = assets.from_asset_list(seller_value)

        // INTENTIONAL — "double-satisfaction" symmetry with the Withdraw
        // branch above: when buyer == seller (or
        // buyer_return_address == seller_return_address), a single tx output
        // tagged with `own_ref` and addressed to the shared target satisfies
        // BOTH `buyer_value_returned` and `seller_value_returned` filters
        // simultaneously. This is safe because the two return addresses are
        // pulled from the locked datum (not the redeemer), and when they are
        // equal the only "victim" of any aggregation is the same party — no
        // third party can manipulate this. Admins signing buyer_value /
        // seller_value with full knowledge of the datum should treat any
        // observed equal-address case as the deployer's intent. Off-chain
        // builders that need two separate outputs for accounting MUST emit
        // them explicitly; the validator only enforces value-sufficiency.
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

        // INTENTIONAL: NO on-chain cap on the submitter's finder reward.
        // The signed buyer_value / seller_value are MINIMUM payouts, not
        // exact amounts. Any escrow value above the sum of the minimums is
        // intentionally unconstrained on-chain and accrues to whichever
        // wallet builds and submits this transaction (the dispute settlement
        // submitter). This is a deliberate economic incentive so that a
        // third party is motivated to land the settlement tx without
        // requiring buyer or seller to spend their own ADA on fees. Admins
        // sign with FULL knowledge of the residual amount — they review the
        // exact input UTxO they are settling (replay binding via own_ref,
        // below) and choose minimum payouts that reflect the residual they
        // are willing to award the submitter. No on-chain permille cap is
        // applied: the contract trusts the admin signature set entirely.
        //
        // Dust caveat (intentional, operational): anyone can send dust ADA
        // (or arbitrary tokens) to a script address, so the disputed UTxO's
        // value at settlement time may exceed the value originally locked.
        // The validator does not distinguish "original lock" from "later
        // dust accretion" — the submitter sweeps whatever residual exists
        // above the signed minimums. This is acceptable economic behavior,
        // not a bug. Operational note: admins should sign settlements
        // promptly to avoid dust-pump scenarios if "winner takes the
        // surplus" is undesirable for a specific deployment.
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

        // H3: bound the work performed per admin vk by the number of admins;
        // otherwise an attacker could pad `admin_signatures` to force quadratic
        // ed25519 verification cost (admin_vks × admin_signatures) and DoS the
        // script.
        expect list.length(admin_signatures) <= list.length(admin_vks)
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

// Sum the lovelace component of a raw `AssetValue` (the redeemer-supplied
// Pairs payload, before it is promoted into a `Value`). The lovelace policy is
// the empty policy id with the empty asset name.
fn lovelace_of_value(v: AssetValue) -> Int {
  list.foldl(
    v,
    0,
    fn(policy_entry, acc) {
      let Pair(policy_id, assets_under_policy) = policy_entry
      if policy_id == #"" {
        list.foldl(
          assets_under_policy,
          acc,
          fn(asset_entry, inner_acc) {
            let Pair(asset_name, quantity) = asset_entry
            if asset_name == #"" {
              inner_acc + quantity
            } else {
              inner_acc
            }
          },
        )
      } else {
        acc
      }
    },
  )
}

test lovelace_of_value_sums_only_ada() {
  let v: AssetValue =
    [
      Pair(#"", [Pair(#"", 1_500)]),
      Pair(#"aabbcc", [Pair(#"deadbeef", 7)]),
    ]
  lovelace_of_value(v) == 1_500
}

test lovelace_of_value_returns_zero_when_no_ada_entry() {
  let v: AssetValue = [Pair(#"aabbcc", [Pair(#"deadbeef", 7)])]
  lovelace_of_value(v) == 0
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
      // L2: pin the CIP-8 protected headers to the standard EdDSA value
      // (`{1: -8}` = `a10127`). Letting submitters choose `protected_headers`
      // would let two admins sign syntactically distinct Sig_structures that
      // an off-chain attacker could splice; enforcing a single canonical
      // header eliminates that divergence and matches what every standard
      // Cardano wallet emits.
      expect admin_signature.protected_headers == cip8_eddsa_protected_headers
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

// ===========================================================================
// End-to-end validator tests
// ===========================================================================
//
// These tests construct a full `Transaction` and invoke
// `vested_pay.spend(...)` directly to exercise every redeemer/state path.
//
// Convention used throughout: validity_range upper_bound = `now` (tx_latest_time)
// drives the `cooldown_time` derivation; validity_range lower_bound is used
// for `must_start_after` checks; cooldown_period = 100 ms in all happy paths.

const buyer_vk_hash: ByteArray =
  #"00000000000000000000000000000000000000000000000000000001"

const seller_vk_hash: ByteArray =
  #"00000000000000000000000000000000000000000000000000000002"

const other_vk_hash: ByteArray =
  #"00000000000000000000000000000000000000000000000000000003"

const admin_vk_hash: ByteArray =
  #"00000000000000000000000000000000000000000000000000000099"

const script_vk_hash: ByteArray =
  #"000000000000000000000000000000000000000000000000000000aa"

const ref_sig_default: ByteArray =
  #"deadbeefdeadbeefdeadbeefdeadbeef"

const ref_sig_other: ByteArray =
  #"cafebabecafebabecafebabecafebabe"

const result_hash_default: ByteArray = #"aabbccdd"

const test_tx_id: ByteArray =
  #"1111111111111111111111111111111111111111111111111111111111111111"

// Build a verification-key address for a given key hash.
fn stub_address(vk_hash: ByteArray) -> Address {
  Address { payment_credential: VerificationKey(vk_hash), stake_credential: None }
}

// The (single) script address shared by inputs/outputs throughout the tests.
// It also uses VerificationKey so the datum's buyer/seller addresses match a
// well-formed Cardano credential; the validator only cares that
// `input.output.address` is consistent across the script inputs/outputs.
fn script_address() -> Address {
  stub_address(script_vk_hash)
}

fn stub_own_ref(output_index: Int) -> OutputReference {
  OutputReference { transaction_id: test_tx_id, output_index }
}

// Build a Datum with sensible defaults that any test can override field-by-field.
fn stub_datum(
  state: State,
  result_hash: ByteArray,
  reference_signature: ByteArray,
  submit_result_time: POSIXTime,
  unlock_time: POSIXTime,
  external_dispute_unlock_time: POSIXTime,
  seller_cooldown_time: POSIXTime,
  buyer_cooldown_time: POSIXTime,
) -> Datum {
  Datum {
    buyer: stub_address(buyer_vk_hash),
    buyer_return_address: None,
    seller: stub_address(seller_vk_hash),
    seller_return_address: None,
    reference_key: #"01",
    reference_signature,
    seller_nonce: #"02",
    buyer_nonce: #"03",
    agent_identifier: #"04",
    collateral_return_lovelace: 0,
    input_hash: #"05",
    result_hash,
    pay_by_time: 0,
    submit_result_time,
    unlock_time,
    external_dispute_unlock_time,
    seller_cooldown_time,
    buyer_cooldown_time,
    state,
  }
}

fn stub_input(
  addr: Address,
  value: Value,
  datum: Datum,
  own_ref: OutputReference,
) -> Input {
  Input {
    output_reference: own_ref,
    output: Output {
      address: addr,
      value,
      datum: InlineDatum(datum),
      reference_script: None,
    },
  }
}

fn stub_script_output(addr: Address, value: Value, datum: Datum) -> Output {
  Output {
    address: addr,
    value,
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

// Output of the buyer/seller payout return type (data = OutputReference tag).
fn stub_payout_output(
  addr: Address,
  value: Value,
  own_ref: OutputReference,
) -> Output {
  Output {
    address: addr,
    value,
    datum: InlineDatum(own_ref),
    reference_script: None,
  }
}

fn stub_tx(
  inputs: List<Input>,
  outputs: List<Output>,
  validity_range: ValidityRange,
  extra_signatories: List<VerificationKeyHash>,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: inputs,
    outputs: outputs,
    validity_range: validity_range,
    extra_signatories: extra_signatories,
  }
}

// ---------------------------------------------------------------------------
// 1. Happy paths
// ---------------------------------------------------------------------------

test setrefund_funds_locked_to_refund_requested() {
  // current_time (upper bound) = 100; cooldown_period = 100; cooldown_time = 200.
  // unlock_time must be > 100 (must_end_before).
  // buyer_cooldown_time (old) must be <= validity lower bound = 50.
  // new buyer_cooldown_time must be >= 200.
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(
      FundsLocked,
      #"",
      ref_sig_default,
      // submit_result_time
      500,
      // unlock_time
      1000,
      // external_dispute_unlock_time
      2000,
      // seller_cooldown_time
      0,
      // buyer_cooldown_time
      50,
    )
  // For SetRefundRequested, the new datum copies all fields except state &
  // cooldown timers: new seller_cooldown_time == 0, new buyer_cooldown_time >= cooldown_time = 200.
  let out_datum =
    Datum { ..in_datum, state: RefundRequested, seller_cooldown_time: 0, buyer_cooldown_time: 200 }
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  let out = stub_script_output(script_address(), val, out_datum)
  let tx =
    stub_tx([inp], [out], interval.between(50, 100), [buyer_vk_hash])

  vested_pay.spend(1, [admin_vk_hash], 100, Some(in_datum), SetRefundRequested, own_ref, tx)
}

test setrefund_result_submitted_to_disputed() {
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(
      ResultSubmitted,
      result_hash_default,
      ref_sig_default,
      500,
      1000,
      2000,
      0,
      50,
    )
  let out_datum =
    Datum { ..in_datum, state: Disputed, seller_cooldown_time: 0, buyer_cooldown_time: 200 }
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  let out = stub_script_output(script_address(), val, out_datum)
  let tx =
    stub_tx([inp], [out], interval.between(50, 100), [buyer_vk_hash])

  vested_pay.spend(1, [admin_vk_hash], 100, Some(in_datum), SetRefundRequested, own_ref, tx)
}

test submit_result_funds_locked_to_result_submitted() {
  // SubmitResult: seller signs, must_start_after(seller_cooldown_time),
  // must_end_before(submit_result_time) -- or end before external_dispute_unlock_time
  // when result_hash is already non-empty. From FundsLocked the result_hash is empty,
  // so the first OR branch is what matters: tx_latest_time < submit_result_time.
  // new seller_cooldown_time >= cooldown_time, new buyer_cooldown_time == 0,
  // new result_hash non-empty.
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(
      FundsLocked,
      #"",
      ref_sig_default,
      // submit_result_time
      1000,
      // unlock_time
      2000,
      // external_dispute_unlock_time
      3000,
      // seller_cooldown_time
      50,
      // buyer_cooldown_time
      0,
    )
  let out_datum =
    Datum {
      ..in_datum,
      state: ResultSubmitted,
      result_hash: result_hash_default,
      seller_cooldown_time: 200,
      buyer_cooldown_time: 0,
    }
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  let out = stub_script_output(script_address(), val, out_datum)
  let tx =
    stub_tx([inp], [out], interval.between(50, 100), [seller_vk_hash])

  vested_pay.spend(1, [admin_vk_hash], 100, Some(in_datum), SubmitResult, own_ref, tx)
}

test submit_result_disputed_rotation_allowed_before_external_unlock() {
  // From Disputed, the new_state remains Disputed; second OR branch
  // (must_end_before external_dispute_unlock_time && result_hash non-empty)
  // is the one that lets us bypass submit_result_time.
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(
      Disputed,
      result_hash_default,
      ref_sig_default,
      // submit_result_time -- already passed
      50,
      // unlock_time
      1000,
      // external_dispute_unlock_time
      3000,
      // seller_cooldown_time
      50,
      // buyer_cooldown_time
      0,
    )
  let out_datum =
    Datum {
      ..in_datum,
      state: Disputed,
      // a different hash to simulate rotation
      result_hash: #"99887766",
      seller_cooldown_time: 1100,
      buyer_cooldown_time: 0,
    }
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  let out = stub_script_output(script_address(), val, out_datum)
  // upper bound = 1000 → cooldown_time = 1100, must_end_before(external_dispute_unlock_time = 3000) holds
  let tx =
    stub_tx([inp], [out], interval.between(60, 1000), [seller_vk_hash])

  vested_pay.spend(1, [admin_vk_hash], 100, Some(in_datum), SubmitResult, own_ref, tx)
}

test authorize_withdrawal_disputed_to_withdraw_authorized() {
  // AuthorizeWithdrawal: buyer signs, result_hash non-empty, state==Disputed,
  // continuation has state==WithdrawAuthorized, seller_cooldown_time == 0,
  // buyer_cooldown_time >= cooldown_time, value preserved.
  // must_start_after(buyer_cooldown_time) -> old buyer_cooldown_time <= lower bound.
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(
      Disputed,
      result_hash_default,
      ref_sig_default,
      500,
      1000,
      2000,
      0,
      // buyer_cooldown_time -- old must be <= validity lower bound
      40,
    )
  let out_datum =
    Datum {
      ..in_datum,
      state: WithdrawAuthorized,
      seller_cooldown_time: 0,
      buyer_cooldown_time: 200,
    }
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  let out = stub_script_output(script_address(), val, out_datum)
  let tx =
    stub_tx([inp], [out], interval.between(50, 100), [buyer_vk_hash])

  vested_pay.spend(1, [admin_vk_hash], 100, Some(in_datum), AuthorizeWithdrawal, own_ref, tx)
}

test authorize_refund_funds_locked_to_refund_authorized_clears_result_hash() {
  // AuthorizeRefund: seller signs, continuation has new state RefundAuthorized,
  // result_hash cleared (empty), seller_cooldown_time >= cooldown_time,
  // buyer_cooldown_time == 0. From FundsLocked the input result_hash is already
  // empty -- still acceptable because the rule is on the *output* datum.
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(
      FundsLocked,
      // input result_hash already empty
      #"",
      ref_sig_default,
      1000,
      2000,
      3000,
      50,
      50,
    )
  let out_datum =
    Datum {
      ..in_datum,
      state: RefundAuthorized,
      result_hash: #"",
      seller_cooldown_time: 200,
      buyer_cooldown_time: 0,
    }
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  let out = stub_script_output(script_address(), val, out_datum)
  let tx =
    stub_tx([inp], [out], interval.between(60, 100), [seller_vk_hash])

  vested_pay.spend(1, [admin_vk_hash], 100, Some(in_datum), AuthorizeRefund, own_ref, tx)
}

test withdraw_result_submitted_after_unlock_time() {
  // Withdraw path 2: state==ResultSubmitted, must_start_after(unlock_time).
  // No continuation output (terminal). result_hash must be non-empty.
  // Seller signs. There is no collateral here (collateral_return_lovelace==0)
  // so no return outputs are required.
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(
      ResultSubmitted,
      result_hash_default,
      ref_sig_default,
      500,
      // unlock_time
      1000,
      2000,
      0,
      0,
    )
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  // validity_range lower_bound >= unlock_time = 1000
  let tx = stub_tx([inp], [], interval.between(1000, 1500), [seller_vk_hash])

  vested_pay.spend(1, [admin_vk_hash], 100, Some(in_datum), Withdraw, own_ref, tx)
}

test withdraw_withdraw_authorized_no_time_wait() {
  // Withdraw path 1: state==WithdrawAuthorized. No unlock_time wait required.
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(
      WithdrawAuthorized,
      result_hash_default,
      ref_sig_default,
      500,
      // unlock_time -- still in the far future, must NOT matter on this path
      9999,
      // external_dispute_unlock_time -- same
      99999,
      0,
      0,
    )
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  // validity range nowhere near unlock_time
  let tx = stub_tx([inp], [], interval.between(10, 20), [seller_vk_hash])

  vested_pay.spend(1, [admin_vk_hash], 100, Some(in_datum), Withdraw, own_ref, tx)
}

test withdraw_refund_funds_locked_after_submit_result_time() {
  // WithdrawRefund: buyer signs, must_start_after(submit_result_time),
  // state == FundsLocked, result_hash empty.
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(
      FundsLocked,
      #"",
      ref_sig_default,
      // submit_result_time -- already passed
      100,
      1000,
      2000,
      0,
      0,
    )
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  let tx = stub_tx([inp], [], interval.between(200, 500), [buyer_vk_hash])

  vested_pay.spend(1, [admin_vk_hash], 100, Some(in_datum), WithdrawRefund, own_ref, tx)
}

test withdraw_refund_refund_authorized_no_time_wait() {
  // WithdrawRefund: state == RefundAuthorized bypasses submit_result_time check.
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(
      RefundAuthorized,
      #"",
      ref_sig_default,
      // submit_result_time -- still far in the future, must not matter
      9999,
      // unlock_time
      9999,
      99999,
      0,
      0,
    )
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  let tx = stub_tx([inp], [], interval.between(10, 20), [buyer_vk_hash])

  vested_pay.spend(1, [admin_vk_hash], 100, Some(in_datum), WithdrawRefund, own_ref, tx)
}

// ---------------------------------------------------------------------------
// 2. Negative tests -- each must fail
// ---------------------------------------------------------------------------

test submit_result_from_withdraw_authorized_rejected() fail {
  // SubmitResult only allows states {FundsLocked, ResultSubmitted, Disputed, RefundRequested}.
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(WithdrawAuthorized, result_hash_default, ref_sig_default, 1000, 2000, 3000, 50, 0)
  let out_datum =
    Datum {
      ..in_datum,
      state: ResultSubmitted,
      result_hash: result_hash_default,
      seller_cooldown_time: 200,
      buyer_cooldown_time: 0,
    }
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  let out = stub_script_output(script_address(), val, out_datum)
  let tx = stub_tx([inp], [out], interval.between(50, 100), [seller_vk_hash])

  vested_pay.spend(1, [admin_vk_hash], 100, Some(in_datum), SubmitResult, own_ref, tx)
}

test submit_result_from_refund_authorized_rejected() fail {
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(RefundAuthorized, #"", ref_sig_default, 1000, 2000, 3000, 50, 0)
  let out_datum =
    Datum {
      ..in_datum,
      state: ResultSubmitted,
      result_hash: result_hash_default,
      seller_cooldown_time: 200,
      buyer_cooldown_time: 0,
    }
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  let out = stub_script_output(script_address(), val, out_datum)
  let tx = stub_tx([inp], [out], interval.between(50, 100), [seller_vk_hash])

  vested_pay.spend(1, [admin_vk_hash], 100, Some(in_datum), SubmitResult, own_ref, tx)
}

test withdraw_from_funds_locked_rejected() fail {
  // Withdraw requires state==ResultSubmitted (with time) or WithdrawAuthorized.
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(FundsLocked, result_hash_default, ref_sig_default, 500, 1000, 2000, 0, 0)
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  let tx = stub_tx([inp], [], interval.between(2000, 2500), [seller_vk_hash])

  vested_pay.spend(1, [admin_vk_hash], 100, Some(in_datum), Withdraw, own_ref, tx)
}

test withdraw_result_submitted_before_unlock_time_rejected() fail {
  // Withdraw path 2 requires must_start_after(unlock_time): validity.lower >= unlock_time.
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(ResultSubmitted, result_hash_default, ref_sig_default, 500, 1000, 2000, 0, 0)
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  // lower_bound < unlock_time
  let tx = stub_tx([inp], [], interval.between(500, 800), [seller_vk_hash])

  vested_pay.spend(1, [admin_vk_hash], 100, Some(in_datum), Withdraw, own_ref, tx)
}

test setrefund_after_unlock_time_rejected() fail {
  // must_end_before(validity_range, unlock_time): tx_latest_time < unlock_time.
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(FundsLocked, #"", ref_sig_default, 500, 1000, 2000, 0, 50)
  let out_datum =
    Datum { ..in_datum, state: RefundRequested, seller_cooldown_time: 0, buyer_cooldown_time: 1200 }
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  let out = stub_script_output(script_address(), val, out_datum)
  // upper_bound 1000 == unlock_time → must_end_before fails (strict <)
  let tx = stub_tx([inp], [out], interval.between(50, 1000), [buyer_vk_hash])

  vested_pay.spend(1, [admin_vk_hash], 100, Some(in_datum), SetRefundRequested, own_ref, tx)
}

test setrefund_without_buyer_signature_rejected() fail {
  // Buyer signature missing.
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(FundsLocked, #"", ref_sig_default, 500, 1000, 2000, 0, 50)
  let out_datum =
    Datum { ..in_datum, state: RefundRequested, seller_cooldown_time: 0, buyer_cooldown_time: 200 }
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  let out = stub_script_output(script_address(), val, out_datum)
  // signed by seller, NOT buyer
  let tx = stub_tx([inp], [out], interval.between(50, 100), [seller_vk_hash])

  vested_pay.spend(1, [admin_vk_hash], 100, Some(in_datum), SetRefundRequested, own_ref, tx)
}

test submit_result_with_empty_new_result_hash_rejected() fail {
  // The new datum must have a non-empty result_hash.
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(FundsLocked, #"", ref_sig_default, 1000, 2000, 3000, 50, 0)
  let out_datum =
    Datum {
      ..in_datum,
      state: ResultSubmitted,
      // empty new result_hash -- should fail
      result_hash: #"",
      seller_cooldown_time: 200,
      buyer_cooldown_time: 0,
    }
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  let out = stub_script_output(script_address(), val, out_datum)
  let tx = stub_tx([inp], [out], interval.between(50, 100), [seller_vk_hash])

  vested_pay.spend(1, [admin_vk_hash], 100, Some(in_datum), SubmitResult, own_ref, tx)
}

test authorize_refund_that_doesnt_clear_result_hash_rejected() fail {
  // AuthorizeRefund requires the new datum's result_hash to be empty.
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(ResultSubmitted, result_hash_default, ref_sig_default, 1000, 2000, 3000, 50, 50)
  let out_datum =
    Datum {
      ..in_datum,
      state: RefundAuthorized,
      // not cleared -- should fail
      result_hash: result_hash_default,
      seller_cooldown_time: 200,
      buyer_cooldown_time: 0,
    }
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  let out = stub_script_output(script_address(), val, out_datum)
  let tx = stub_tx([inp], [out], interval.between(60, 100), [seller_vk_hash])

  vested_pay.spend(1, [admin_vk_hash], 100, Some(in_datum), AuthorizeRefund, own_ref, tx)
}

// ---------------------------------------------------------------------------
// 3. Multi-UTxO guards
// ---------------------------------------------------------------------------

test two_script_inputs_with_identical_reference_signature_rejected() fail {
  // Two inputs at the same script address share the same reference_signature →
  // input dedupe check fails.
  let own_ref_a = stub_own_ref(0)
  let own_ref_b = stub_own_ref(1)
  let in_datum_a =
    stub_datum(FundsLocked, #"", ref_sig_default, 500, 1000, 2000, 0, 50)
  let in_datum_b =
    stub_datum(FundsLocked, #"", ref_sig_default, 500, 1000, 2000, 0, 50)
  let out_datum =
    Datum { ..in_datum_a, state: RefundRequested, seller_cooldown_time: 0, buyer_cooldown_time: 200 }
  let val = assets.from_lovelace(1_000_000)
  let inp_a = stub_input(script_address(), val, in_datum_a, own_ref_a)
  let inp_b = stub_input(script_address(), val, in_datum_b, own_ref_b)
  let out = stub_script_output(script_address(), val, out_datum)
  let tx =
    stub_tx([inp_a, inp_b], [out], interval.between(50, 100), [buyer_vk_hash])

  vested_pay.spend(1, [admin_vk_hash], 100, Some(in_datum_a), SetRefundRequested, own_ref_a, tx)
}

test two_script_outputs_with_identical_reference_signature_rejected() fail {
  // Two script outputs both carry the same reference_signature → output dedupe fails.
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(FundsLocked, #"", ref_sig_default, 500, 1000, 2000, 0, 50)
  let out_datum_1 =
    Datum { ..in_datum, state: RefundRequested, seller_cooldown_time: 0, buyer_cooldown_time: 200 }
  let out_datum_2 =
    Datum { ..in_datum, state: RefundRequested, seller_cooldown_time: 0, buyer_cooldown_time: 200 }
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  let out_1 = stub_script_output(script_address(), val, out_datum_1)
  let out_2 = stub_script_output(script_address(), val, out_datum_2)
  let tx =
    stub_tx([inp], [out_1, out_2], interval.between(50, 100), [buyer_vk_hash])

  vested_pay.spend(1, [admin_vk_hash], 100, Some(in_datum), SetRefundRequested, own_ref, tx)
}

// ---------------------------------------------------------------------------
// 4. WithdrawDisputed guards (cryptographic signature path NOT exercised).
//    We verify the time guard and the state guard; the actual ed25519 CIP-8
//    signature path is too complex to mock here -- see TODO at end.
// ---------------------------------------------------------------------------

test withdraw_disputed_before_external_unlock_rejected() fail {
  // must_start_after(external_dispute_unlock_time) requires lower >= it.
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(Disputed, result_hash_default, ref_sig_default, 500, 1000, 2000, 0, 0)
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  // lower_bound 100 < external_dispute_unlock_time 2000
  let tx = stub_tx([inp], [], interval.between(100, 200), [other_vk_hash])

  vested_pay.spend(
    1,
    [admin_vk_hash],
    100,
    Some(in_datum),
    WithdrawDisputed {
      buyer_value: [],
      seller_value: [],
      admin_signatures: [],
    },
    own_ref,
    tx,
  )
}

test withdraw_disputed_not_disputed_state_rejected() fail {
  // state must be Disputed for WithdrawDisputed.
  let own_ref = stub_own_ref(0)
  let in_datum =
    stub_datum(ResultSubmitted, result_hash_default, ref_sig_default, 500, 1000, 2000, 0, 0)
  let val = assets.from_lovelace(1_000_000)
  let inp = stub_input(script_address(), val, in_datum, own_ref)
  // even after external_dispute_unlock_time, wrong state must reject
  let tx = stub_tx([inp], [], interval.between(2500, 3000), [other_vk_hash])

  vested_pay.spend(
    1,
    [admin_vk_hash],
    100,
    Some(in_datum),
    WithdrawDisputed {
      buyer_value: [],
      seller_value: [],
      admin_signatures: [],
    },
    own_ref,
    tx,
  )
}
// TODO: WithdrawDisputed happy-path test that exercises the CIP-8 ed25519
// signature verification is intentionally omitted -- it requires generating
// a real ed25519 keypair and signing the CBOR-encoded DisputeWithdrawal
// payload off-chain, which is non-trivial in pure Aiken test land.
