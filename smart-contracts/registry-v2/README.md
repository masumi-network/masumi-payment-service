# Masumi Registry Contract V2

## Overview

The registry V2 contract is a stateless Aiken Plutus V3 minting policy for registry assets. It authorizes minting by deriving each asset name from a consumed UTxO reference, which gives each asset a globally unique prefix without a shared counter or singleton state UTxO.

V2 supports three redeemers:

```typescript
const Actions = {
  MintAction: 0,
  UpdateAction: 1,
  BurnAction: 2,
};
```

## Asset Name Rule

Every registry asset name must be exactly 32 bytes:

```text
nonce ++ root_hash ++ version
```

- `nonce`: 1 byte. This lets one consumed input authorize multiple mints in the same transaction. It must be in the range `10` through `ff`; `00` through `0f` are reserved so registry assets cannot be mistaken for CIP-67/CIP-68 asset-label prefixes. CIP-67 labels start with a leading zero nibble: `[0000 | 16 bits label_num | 8 bits checksum | 0000]` ([CIP-67](https://cips.cardano.org/cip/CIP-67)).
- `root_hash`: 28 bytes. For new mints this is `blake2b_224(input.transaction_id ++ input.output_index_be4)` for a consumed input.
- `version`: 3 bytes, big-endian. New mints must start at `000000`.

Updates keep the same `root_hash` and `nonce`, and increment the full 3-byte `version` by exactly one.

## Trust Model

V2 is intentionally permissionless. The minting policy has no payment-source parameter, admin signer, or registry owner check, so any wallet can mint a registry asset under this policy if it spends a UTxO that authorizes the asset-name prefix rule.

The on-chain policy only guarantees asset-name uniqueness and the mint/update/burn quantity rules. It does not certify that metadata was created by a Masumi operator, belongs to a specific payment source, or should be shown as trusted. Any payment-source scoping, allowlisting, moderation, metadata validation, or trust labeling must be handled off-chain by indexers and applications that consume the registry.

## Actions

### MintAction

Mints one or more registry assets.

Requirements:

- Every minted asset under the policy has quantity `1`.
- Every minted asset name follows the consumed-input root hash rule.
- Every minted asset version is exactly `000000`.

### UpdateAction

Updates one or more registry assets atomically by burning existing assets and minting matching replacement assets.

Requirements:

- The transaction has one or more burned assets and the same number of minted assets under the policy.
- Every burned entry has quantity `-1`; every minted entry has quantity `1`.
- For each burned asset, the matching minted asset has the same 28-byte root hash and 1-byte nonce.
- For each burned asset, the matching minted asset's full 3-byte version is incremented by exactly one.
- The old-to-new relationship is recorded and interpreted off-chain.

### BurnAction

Burns one or more registry assets.

Requirements:

- Every asset under the policy has quantity `-1`.
- Asset-name derivation is not checked for burns; possession of the token being burned is the authorization.

## Building

Install Aiken, then run:

```sh
aiken build
```

Run contract tests with:

```sh
aiken check
```

## Example Scripts

Install Node.js dependencies with:

```sh
pnpm install
```

Useful scripts:

```sh
pnpm run generate-wallet
pnpm run mint
pnpm run mint-three
pnpm run mint-limit
ASSET_NAMES=<asset-1>,<asset-2>,<asset-3> pnpm run update-three
ASSET_NAME=<asset-name-hex> pnpm run metadata
ASSET_NAME=<asset-name-hex> pnpm run burn
ASSET_NAMES=<asset-1>,<asset-2>,<asset-3> pnpm run burn-three
pnpm run defrag
```

The scripts use Koios by default and read these environment variables:

- `NETWORK`: Cardano network, default `preprod`.
- `WALLET_FILE`: Mnemonic file, default `wallet.sk`.
- `RECIPIENT_ADDRESS`: Optional mint recipient, default wallet address.
- `ASSET_NONCE`: Optional 1-byte hex nonce used when deriving a mint asset name, default `10`. Values `00` through `0f` are rejected.
- `ASSET_NONCES`: Optional comma/space separated 1-byte hex nonces for `mint-three`, default `10,11,12`.
- `MINT_LIMIT_COUNT`: Number of assets minted by `mint-limit` in one transaction, default `25`.
- `MINT_LIMIT_NONCE_START`: First nonce byte used by `mint-limit`, default `10`. The script increments it once per asset and rejects ranges past `ff`.
- `MINT_LIMIT_CHECK_KOIOS`: Set to `1` to poll Koios after `mint-limit` and print the full label `721` metadata plus asset summary.
- `ASSET_NAME`: Optional full 32-byte asset name for minting; required for metadata lookup and burn.
- `ASSET_NAMES`: Comma/space separated full 32-byte asset names for `update-three` and `burn-three`. `update-three-example.mjs` also has an `assetNamesInCode` array you can fill in directly; the environment variable takes precedence when set.
- `REGISTRY_OUTPUT_LOVELACE`: Lovelace sent with a newly minted NFT, default `5000000`.
- `TOTAL_COLLATERAL`: Collateral amount declared for mint/burn transactions, default `5000000`.
- `KOIOS_METADATA_ATTEMPTS`: Metadata polling attempts after `mint-three`, `update-three`, and `burn-three`, default `30`.
- `KOIOS_METADATA_DELAY_MS`: Delay between Koios metadata polling attempts, default `10000`.
- Metadata overrides: `AGENT_NAME`, `API_URL`, `IMAGE_URL`, `DESCRIPTION`, `COMPANY_NAME`, `CAPABILITY_NAME`, `CAPABILITY_VERSION`, `FIXED_PRICE_AMOUNT`, `FIXED_PRICE_UNIT`.

The V2 mint example derives the default asset name exactly as the policy does: `ASSET_NONCE ++ blake2b_224(seed_utxo.tx_id ++ seed_utxo.output_index_be4) ++ 000000`. The `mint-three` example mints three assets in one transaction, prints `ASSET_NAMES=...`, and that value can be passed to `update-three`; `update-three` updates all three assets in one transaction and prints the next `ASSET_NAMES=...` value for `burn-three`. The `mint-limit` example defaults to 25 assets; use `MINT_LIMIT_COUNT=<n> pnpm run mint-limit` to change the batch size. The mint/update examples poll Koios transaction metadata and print the actual label `721` CIP-25 payload keyed by raw hex asset names; they also print Koios' asset summary. The burn examples use the `BurnAction` redeemer (`2`); possession of the token UTxO plus transaction collateral is sufficient authorization.
