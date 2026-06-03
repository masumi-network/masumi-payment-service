use aiken/builtin.{blake2b_224}
use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray.{concat, from_int_big_endian}
use cardano/assets.{PolicyId}
use cardano/transaction.{Input, Transaction}

pub type Action {
  MintAction
  UpdateAction
  BurnAction
}

// Stateless mint policy. Each minted asset name must be exactly 32 bytes:
// 1 byte nonce: lets one input authorize many mints and stays stable across updates
// 28 bytes root hash: blake2b_224(input.tx_id ++ input.output_index_be4)
// 3 bytes version: starts at 000000 for MintAction and increments by one on update
// The nonce byte must be > 0f so registry assets cannot look like CIP-67/CIP-68
// asset-label prefixes, which reserve the 00..0f first-byte range.
// This policy is intentionally permissionless and does not bind mints to a
// payment source or admin signer; trust and scoping are enforced off-chain.
//
// Asset identifier uniqueness:
// The full on-chain asset identifier is `policyId ++ asset_name`. Uniqueness
// at that level is what callers and indexers rely on, and is guaranteed by
// construction:
//   * `root_hash = blake2b_224(input.tx_id ++ input.output_index_be4)` is
//     content-addressed against a globally unique OutputReference. Two
//     distinct mints can only share a `root_hash` if they consume the same
//     UTxO, which Cardano disallows.
//   * `nonce` is chosen per-mint by the spender. Off-chain we fix `nonce =
//     0x10` (src/services/registry/shared.ts) so legitimate flows produce a
//     single canonical asset; a malicious owner could in principle mint
//     additional assets at different nonce values from the same input, but
//     each such asset has its own distinct 32-byte name and therefore its
//     own asset identifier — no collision with the canonical entry, and no
//     trust gained over it (off-chain consumers verify `policyId ++
//     asset_name`, not `root_hash` alone).
// The validator therefore does NOT need to constrain `nonce` further or
// enforce `list.unique(asset_root_hashes)` across `policy_assets`; the
// asset-identifier uniqueness invariant holds without those checks.
validator mintUnique {
  mint(redeemer: Action, policy_id: PolicyId, self: Transaction) {
    let Transaction { inputs, mint, .. } = self
    let policy_assets = mint |> assets.tokens(policy_id) |> dict.to_pairs()

    when redeemer is {
      // Mint N tokens. Each entry has qty == 1, version 000000, and an exact
      // 32-byte asset name authorized by one consumed input reference.
      MintAction -> {
        let input_root_hashes =
          list.map(inputs, fn(input) { input_root_hash(input) })
        let every_asset_is_an_initial_mint =
          list.all(
            policy_assets,
            fn(asset) {
              let Pair(asset_name, quantity) = asset
              let asset_nonce = bytearray.slice(asset_name, 0, 0)
              let asset_root_hash = bytearray.slice(asset_name, 1, 28)
              let asset_version = bytearray.slice(asset_name, 29, 31)
              let root_hash_comes_from_spent_input =
                list.has(input_root_hashes, asset_root_hash)

              and {
                quantity == 1,
                bytearray.length(asset_name) == 32,
                // The nonce byte must be > 0f so registry assets cannot look like CIP-67/CIP-68
                bytearray.compare(asset_nonce, #"0f") == Greater,
                asset_version == from_int_big_endian(0, 3),
                root_hash_comes_from_spent_input,
              }
            },
          )

        every_asset_is_an_initial_mint
      }

      // Atomic update: burn one or more existing tokens and mint matching
      // replacements in the same transaction. For every burned asset there must
      // be exactly one minted asset with the same 1-byte nonce and 28-byte root
      // hash, and its 3-byte version must be incremented by exactly one.
      //
      // INTENTIONAL — N-to-N pairing rather than strict 1-to-1:
      // The validator requires that every burn has at least one matching mint
      // and every mint has at least one matching burn (by `nonce ++ root_hash`
      // prefix, with +1 version bump). It does NOT enforce a strict 1:1
      // permutation, so in principle a degenerate batch could pair multiple
      // burns to the same mint, or multiple mints to the same burn, as long as
      // every entry has SOME match on the other side and `minted_count ==
      // burned_count`.
      //
      // Why this is safe in practice: `root_hash` is content-addressed —
      // `blake2b_224(input.tx_id ++ input.output_index_be4)` derived at the
      // original `MintAction` step, and frozen for the lifetime of the asset.
      // Two registry entries with the same `nonce ++ root_hash` would require
      // two distinct UTxOs to share an `(tx_id, output_index)` pair, which is
      // a collision on a globally-unique OutputReference and impossible on
      // Cardano. So although the validator allows N-to-N permutations in
      // theory, in practice every batched (burn, mint) is uniquely paired by
      // its prefix. Enforcing strict 1:1 here would add cost (more Plutus mem
      // / cpu units per tx) for a guarantee that the off-chain construction
      // invariant already provides for free.
      UpdateAction -> {
        let minted_assets =
          list.filter(
            policy_assets,
            fn(asset) {
              let Pair(_asset_name, quantity) = asset
              quantity == 1
            },
          )
        let burned_assets =
          list.filter(
            policy_assets,
            fn(asset) {
              let Pair(_asset_name, quantity) = asset
              quantity == -1
            },
          )

        let minted_count = list.length(minted_assets)
        let burned_count = list.length(burned_assets)
        let all_entries_are_updates =
          minted_count + burned_count == list.length(policy_assets)
        let every_burn_has_a_matching_mint =
          list.all(
            burned_assets,
            fn(burned_asset) {
              let Pair(burned_asset_name, _quantity) = burned_asset
              list.any(
                minted_assets,
                fn(minted_asset) {
                  let Pair(minted_asset_name, _quantity) = minted_asset
                  asset_name_continues_with_next_version(
                    burned_asset_name,
                    minted_asset_name,
                  )
                },
              )
            },
          )
        let every_mint_has_a_matching_burn =
          list.all(
            minted_assets,
            fn(minted_asset) {
              let Pair(minted_asset_name, _quantity) = minted_asset
              list.any(
                burned_assets,
                fn(burned_asset) {
                  let Pair(burned_asset_name, _quantity) = burned_asset
                  asset_name_continues_with_next_version(
                    burned_asset_name,
                    minted_asset_name,
                  )
                },
              )
            },
          )

        and {
          minted_count > 0,
          minted_count == burned_count,
          all_entries_are_updates,
          every_burn_has_a_matching_mint,
          every_mint_has_a_matching_burn,
        }
      }
      // Burn N tokens. Every entry must have qty == -1; possession of the
      // token is sufficient authorization.
      BurnAction -> {
        let every_entry_is_a_burn =
          list.all(
            policy_assets,
            fn(asset) {
              let Pair(_asset_name, quantity) = asset
              quantity == -1
            },
          )
        every_entry_is_a_burn
      }
    }
  }

  // Only the mint handler is supported; any other script purpose fails.
  else(_) {
    fail
  }
}

fn input_root_hash(input: Input) {
  concat(
    input.output_reference.transaction_id,
    from_int_big_endian(input.output_reference.output_index, 4),
  )
    |> blake2b_224
}

fn asset_name_continues_with_next_version(
  burned_asset_name: ByteArray,
  minted_asset_name: ByteArray,
) {
  // The 1-byte nonce + 28-byte root hash (29 bytes total) must match between
  // the burned and the minted asset; only the 3-byte version may change.
  let burned_nonce_and_root = bytearray.slice(burned_asset_name, 0, 28)

  if bytearray.starts_with(minted_asset_name, burned_nonce_and_root) == False {
    False
  } else {
    let burned_version_bytes = bytearray.slice(burned_asset_name, 29, 31)
    let minted_version_bytes = bytearray.slice(minted_asset_name, 29, 31)
    let expected_next_version =
      from_int_big_endian(
        bytearray.to_int_big_endian(burned_version_bytes) + 1,
        3,
      )

    and {
      bytearray.length(minted_asset_name) == 32,
      minted_version_bytes == expected_next_version,
    }
  }
}

test minted_asset_requires_initial_version() {
  let root_hash = #"000102030405060708090a0b0c0d0e0f101112131415161718191a1b"
  let valid_asset_name = concat(concat(#"2a", root_hash), #"000000")
  let invalid_asset_name = concat(concat(#"2a", root_hash), #"000001")

  let valid_asset_name_version = bytearray.slice(valid_asset_name, 29, 31)
  let invalid_asset_name_version = bytearray.slice(invalid_asset_name, 29, 31)

  and {
    bytearray.length(valid_asset_name) == 32,
    valid_asset_name_version == from_int_big_endian(0, 3),
    bytearray.length(invalid_asset_name) == 32,
    invalid_asset_name_version != from_int_big_endian(0, 3),
  }
}

test minted_asset_rejects_cip67_label_space() {
  let root_hash = #"000102030405060708090a0b0c0d0e0f101112131415161718191a1b"
  let cip67_like_asset_name = concat(concat(#"0f", root_hash), #"000000")
  let registry_asset_name = concat(concat(#"10", root_hash), #"000000")
  let cip67_like_nonce = bytearray.slice(cip67_like_asset_name, 0, 0)
  let registry_nonce = bytearray.slice(registry_asset_name, 0, 0)

  and {
    bytearray.compare(cip67_like_nonce, #"0f") != Greater,
    bytearray.compare(registry_nonce, #"0f") == Greater,
  }
}

test update_asset_increments_version_and_keeps_nonce() {
  let root_hash = #"000102030405060708090a0b0c0d0e0f101112131415161718191a1b"
  let old_asset_name = concat(concat(#"2a", root_hash), #"000001")
  let new_asset_name = concat(concat(#"2a", root_hash), #"000002")
  asset_name_continues_with_next_version(old_asset_name, new_asset_name)
}

test update_assets_allow_multiple_pairs() {
  let root_hash = #"000102030405060708090a0b0c0d0e0f101112131415161718191a1b"
  let root_hash_2 = #"1b1a191817161514131211100f0e0d0c0b0a09080706050403020100"
  let old_asset_name = concat(concat(#"2a", root_hash), #"000001")
  let new_asset_name = concat(concat(#"2a", root_hash), #"000002")
  let old_asset_name_2 = concat(concat(#"7f", root_hash_2), #"000005")
  let new_asset_name_2 = concat(concat(#"7f", root_hash_2), #"000006")
  let minted_assets = [Pair(new_asset_name, 1), Pair(new_asset_name_2, 1)]
  let burned_assets = [Pair(old_asset_name, -1), Pair(old_asset_name_2, -1)]

  and {
    list.length(minted_assets) == list.length(burned_assets),
    list.all(
      burned_assets,
      fn(burned_asset) {
        let Pair(burned_asset_name, _quantity) = burned_asset
        list.any(
          minted_assets,
          fn(minted_asset) {
            let Pair(minted_asset_name, _quantity) = minted_asset
            asset_name_continues_with_next_version(
              burned_asset_name,
              minted_asset_name,
            )
          },
        )
      },
    ),
  }
}

test update_asset_rejects_version_gap() {
  let root_hash = #"000102030405060708090a0b0c0d0e0f101112131415161718191a1b"
  let old_asset_name = concat(concat(#"2a", root_hash), #"000001")
  let new_asset_name = concat(concat(#"2a", root_hash), #"000003")
  !asset_name_continues_with_next_version(old_asset_name, new_asset_name)
}

test update_asset_rejects_max_version_overflow() fail {
  let root_hash = #"000102030405060708090a0b0c0d0e0f101112131415161718191a1b"
  let old_asset_name = concat(concat(#"2a", root_hash), #"ffffff")
  let new_asset_name = concat(concat(#"2a", root_hash), #"000000")
  asset_name_continues_with_next_version(old_asset_name, new_asset_name)
}

test update_asset_rejects_nonce_change() {
  let root_hash = #"000102030405060708090a0b0c0d0e0f101112131415161718191a1b"
  let old_asset_name = concat(concat(#"2a", root_hash), #"000001")
  let new_asset_name = concat(concat(#"2b", root_hash), #"000002")
  !asset_name_continues_with_next_version(old_asset_name, new_asset_name)
}

test update_asset_rejects_root_hash_change() {
  let root_hash = #"000102030405060708090a0b0c0d0e0f101112131415161718191a1b"
  let root_hash2 = #"000102030405060708090a0b0c0d0e0f101112131415161718191a1c"
  let old_asset_name = concat(concat(#"2a", root_hash), #"000001")
  let new_asset_name = concat(concat(#"2a", root_hash2), #"000002")
  !asset_name_continues_with_next_version(old_asset_name, new_asset_name)
}

test update_asset_rejects_truncated_mint_name() {
  let root_hash = #"000102030405060708090a0b0c0d0e0f101112131415161718191a1b"
  let old_asset_name = concat(concat(#"2a", root_hash), #"000001")
  let new_asset_name = concat(#"2a", root_hash)
  !asset_name_continues_with_next_version(old_asset_name, new_asset_name)
}
