use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets.{Value, from_asset, from_lovelace, merge}
use cardano/transaction.{
  Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}
use smart_wallet/mint.{mint_is_valid, state_token_name}

const owner_key: ByteArray =
  #"00000000000000000000000000000000000000000000000000000001"

const stranger_key: ByteArray =
  #"00000000000000000000000000000000000000000000000000000003"

const owner_stake: ByteArray =
  #"00000000000000000000000000000000000000000000000000000004"

/// Script hash and policy id at once — the validator is its own policy.
const wallet_hash: ByteArray =
  #"000000000000000000000000000000000000000000000000000000aa"

fn wallet_address() -> Address {
  Address {
    payment_credential: Script(wallet_hash),
    stake_credential: Some(Inline(VerificationKey(owner_stake))),
  }
}

fn elsewhere() -> Address {
  Address {
    payment_credential: VerificationKey(stranger_key),
    stake_credential: None,
  }
}

fn seed() -> OutputReference {
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000001",
    output_index: 0,
  }
}

fn other_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000009",
    output_index: 0,
  }
}

fn input_of(ref: OutputReference) -> Input {
  Input {
    output_reference: ref,
    output: Output {
      address: elsewhere(),
      value: from_lovelace(100_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

fn output_at(address: Address, value: Value) -> Output {
  Output {
    address: address,
    value: value,
    datum: NoDatum,
    reference_script: None,
  }
}

fn tx(
  inputs: List<Input>,
  outputs: List<Output>,
  minted: Value,
  signatories: List<ByteArray>,
) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: inputs,
    outputs: outputs,
    mint: minted,
    extra_signatories: signatories,
  }
}

fn valid(self: Transaction) -> Bool {
  mint_is_valid(owner_key, Some(VerificationKey(owner_stake)), wallet_hash, self)
}

/// A freshly minted wallet: funds plus its one derived-name state token.
fn funded_wallet(lovelace: Int, name: ByteArray) -> Value {
  merge(from_lovelace(lovelace), from_asset(wallet_hash, name, 1))
}

// ## Minting

test mint_with_a_name_derived_from_a_consumed_seed() {
  let name = state_token_name(seed())
  let self =
    tx(
      [input_of(seed())],
      [output_at(wallet_address(), funded_wallet(50_000_000, name))],
      from_asset(wallet_hash, name, 1),
      [owner_key],
    )
  valid(self)
}

test mint_whose_name_derives_from_nothing_consumed_fails() fail {
  // The one-shot-per-name guarantee: the seed the name derives from must be an
  // input, and the ledger will never let that input be spent again.
  let name = state_token_name(other_ref())
  let self =
    tx(
      [input_of(seed())],
      [output_at(wallet_address(), funded_wallet(50_000_000, name))],
      from_asset(wallet_hash, name, 1),
      [owner_key],
    )
  valid(self)
}

test mint_without_the_owner_fails() fail {
  // Owner-gated: nobody else creates wallets at this address.
  let name = state_token_name(seed())
  let self =
    tx(
      [input_of(seed())],
      [output_at(wallet_address(), funded_wallet(50_000_000, name))],
      from_asset(wallet_hash, name, 1),
      [stranger_key],
    )
  valid(self)
}

test mint_of_two_of_the_same_token_fails() fail {
  let name = state_token_name(seed())
  let self =
    tx(
      [input_of(seed())],
      [
        output_at(
          wallet_address(),
          merge(from_lovelace(50_000_000), from_asset(wallet_hash, name, 2)),
        ),
      ],
      from_asset(wallet_hash, name, 2),
      [owner_key],
    )
  valid(self)
}

test mint_of_a_second_asset_name_fails() fail {
  // The "infinite mint" hole: guarding only the token you care about lets a
  // caller mint arbitrary extra names under the same policy id.
  let name = state_token_name(seed())
  let self =
    tx(
      [input_of(seed())],
      [output_at(wallet_address(), funded_wallet(50_000_000, name))],
      merge(from_asset(wallet_hash, name, 1), from_asset(wallet_hash, "evil", 1)),
      [owner_key],
    )
  valid(self)
}

test mint_landing_outside_the_wallet_fails() fail {
  let name = state_token_name(seed())
  let self =
    tx(
      [input_of(seed())],
      [output_at(elsewhere(), funded_wallet(50_000_000, name))],
      from_asset(wallet_hash, name, 1),
      [owner_key],
    )
  valid(self)
}

test mint_into_a_lookalike_address_fails() fail {
  // The mint pins the FULL address. A payment-credential-only match would let
  // the creating transaction choose any stake credential — and the spend path
  // then freezes it for the wallet's whole life.
  let name = state_token_name(seed())
  let bare =
    Address { payment_credential: Script(wallet_hash), stake_credential: None }
  let self =
    tx(
      [input_of(seed())],
      [output_at(bare, funded_wallet(50_000_000, name))],
      from_asset(wallet_hash, name, 1),
      [owner_key],
    )
  valid(self)
}

test mint_into_a_utxo_already_holding_a_token_fails() fail {
  // The per-UTxO invariant starts at the mint: the receiving UTxO holds
  // exactly ONE token of this policy. Two wallets can share an address, never
  // a UTxO.
  let name = state_token_name(seed())
  let existing = state_token_name(other_ref())
  let doubled =
    merge(funded_wallet(50_000_000, name), from_asset(wallet_hash, existing, 1))
  let self =
    tx(
      [input_of(seed())],
      [output_at(wallet_address(), doubled)],
      from_asset(wallet_hash, name, 1),
      [owner_key],
    )
  valid(self)
}

// ## Burning

test burn_by_the_owner_retires_one_wallet() {
  let name = state_token_name(seed())
  let self =
    tx([input_of(other_ref())], [], from_asset(wallet_hash, name, -1), [
      owner_key,
    ])
  valid(self)
}

test burn_without_the_owner_fails() fail {
  let name = state_token_name(seed())
  let self =
    tx([input_of(other_ref())], [], from_asset(wallet_hash, name, -1), [
      stranger_key,
    ])
  valid(self)
}

test burn_of_more_than_one_fails() fail {
  let name = state_token_name(seed())
  let self =
    tx([input_of(other_ref())], [], from_asset(wallet_hash, name, -2), [
      owner_key,
    ])
  valid(self)
}

// ## Name derivation

test derived_names_are_index_sensitive() {
  let tx_id =
    #"0000000000000000000000000000000000000000000000000000000000000001"
  state_token_name(OutputReference { transaction_id: tx_id, output_index: 1 }) != state_token_name(
    OutputReference { transaction_id: tx_id, output_index: 2 },
  )
}

test derived_name_matches_offchain_vector() {
  // Shared vector with example-helpers.mjs (`stateTokenName`): pins the JS and
  // Aiken derivations to each other, so an endianness or width slip on either
  // side of the boundary fails a test instead of minting an unspendable name.
  let zero_tx =
    #"0000000000000000000000000000000000000000000000000000000000000000"
  and {
    state_token_name(OutputReference { transaction_id: zero_tx, output_index: 0 }) == #"9f0e444c69f77a49bd0be89db92c38fe713e0963165cca12faf5712d7657120f",
    state_token_name(OutputReference { transaction_id: zero_tx, output_index: 7 }) == #"88de608df497d407fc453b33cfed169095e6de10cc6a37a8ce8d4be9313574c2",
  }
}
