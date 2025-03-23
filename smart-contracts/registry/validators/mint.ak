use aiken/builtin.{blake2b_256}
use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray.{concat, from_int_big_endian}
use cardano/assets.{PolicyId}
use cardano/transaction.{Input, OutputReference, Transaction}

pub type Action {
  MintAction
  BurnAction
}

//this validator ensures that the minted asset is unique and can be parallelized better than with a counter
validator mintUnique(_paymentContractAddress: ByteArray) {
  // This validator expects a minting transaction
  mint(redeemer: Action, policy_id: PolicyId, self: Transaction) {
    let Transaction { inputs, mint, .. } = self
    //implicit asset count is 1 (only one asset can be minted)
    expect [Pair(asset_name, quantity)] =
      mint |> assets.tokens(policy_id) |> dict.to_pairs()

    when redeemer is {
      MintAction ->
        // Select the first input and concatenate its output reference and index to
        // generate the expected token name
        // this ensures that the minted asset is unique and we can parallelize it better than with a counter
        and {
          list.any(
            inputs,
            fn(input) {
              let expected_asset_name =
                concat(
                  input.output_reference.transaction_id,
                  from_int_big_endian(input.output_reference.output_index, 4),
                )
                  |> blake2b_256
              asset_name == expected_asset_name
            },
          ),
          quantity == 1,
        }
      BurnAction ->
        //burn action is only valid if there is only one asset in the transaction
        quantity == -1
    }
  }

  // The validator will fail if the transaction is not for minting.
  else(_) {
    fail
  }
}

// Function to convert data to blake2b_256 hash
fn to_blake2b_256(data: ByteArray) -> ByteArray {
  let x = concat(data, from_int_big_endian(1, 4))
  let y = x |> blake2b_256
  y
}

// Test function for to_blake2b_256
test to_blake2b_256_test() {
  let test_data =
    #"b9b1c0beac59bf30494c4d7e02d4eca37e902f4f5394568fa2b676575a58f506"
  let result = to_blake2b_256(test_data)
  trace result

  let expected =
    #"bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319"

  result == expected
}
