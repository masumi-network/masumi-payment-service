---
id: '01'
title: Purchase-side transaction shape inventory
type: research
status: closed
assignee: research-subagent
blocked_by: []
---

# Purchase-side transaction shape inventory

## Question

For every purchase-side and registry operation the V2 payment source builds
today — batch payments, collect refund, request refund, authorize withdrawal,
registry register / deregister / update, registry-inbox register / deregister,
and collateral preparation — what is the exact on-chain transaction shape?

Per operation: how many key-locked versus Plutus-script inputs, what the
outputs are and whether they carry inline datums, what is minted or burned and
who signs for it, how collateral is chosen, which key hashes end up in
`requiredSigners`, and how the validity range is derived.

And specifically:

- Which operations spend value **originating from the hot wallet's own
  balance**, versus merely unlocking value already sitting in a script?
- How many purchases share one batch transaction, and how are the wallet's own
  UTxOs selected and consumed?
- Does any operation require the wallet's own address to appear in an on-chain
  **datum** — an escrow buyer or return address — and what would later arrive
  back at that address, with or without a datum?

## Why this is first

Every structural decision on this map hangs off the real transaction shapes.
The prototype forbids a second script input, but purchase-side operations
plainly spend escrow UTxOs; until the inventory exists, the conflict is a
guess.

## Resolution

### The blocking finding

**The V2 escrow validator cannot accept a script address as buyer or seller.**
Every buyer-side redeemer runs `expect Some(buyer_vk) =
address_to_verification_key(buyer)` and then `must_be_signed_by` —
`smart-contracts/payment-v2/validators/vested_pay.ak:392, 413, 495` (seller
equivalents at `:261, 689, 750`), and `address_to_verification_key` returns
`Some` only for a `VerificationKey` credential (`:1213-1216`). A script buyer
bricks the UTxO permanently; there is no rescue redeemer.

The off-chain encoder refuses to build such a datum anyway:
`getPubKeyAddressDatum` throws unless the address is a base or enterprise
address with a payment **key** credential —
`packages/payment-source-v2/src/contract-generator.ts:132-139` — and that
covers `buyerAddress`, `sellerAddress` and both optional return-address fields.

The refund payout is bound the same way. `outputs_with_reference_tag` requires
`output.address == expected_address` byte-for-byte including the stake part,
and the tagging datum to equal the escrow UTxO's own `OutputReference`
(`vested_pay.ak:773-803`; builder side `builders/batch-interaction.ts:725-728`).
The expected address is the datum's `buyer_return_address` — a pubkey address by
construction.

So the wallet cannot *be* the buyer. It can at most be the **source of funds**
behind a buyer whose identity is a plain key.

### Where the wallet's own money actually goes

Only three operations spend wallet principal:

- **batch-payments** — the whole escrow amount plus a min-UTxO top-up
  (`services/purchases/batch-payments/service.ts:307-317`). Up to 10 purchases
  per transaction (`:644`).
- **registry register / registry-inbox register** — per-NFT funding lovelace
  (`builders/batch-registry.ts:286-297`).
- **registry update** — funding lovelace on the re-minted NFT (`:649-660`).

`collect-refund`, `request-refund` and `authorize-withdrawal` spend **no wallet
principal** — only fees, the 5 ADA splitter, and collateral risk. They unlock
value that already sits in the escrow.

### Script inputs, and where the prototype's rule actually bites

- **batch-payments has zero script inputs today** and declares no collateral at
  all (`batch-payments/service.ts:267`, confirmed by the absence of `txIn`,
  `txInCollateral`, `setTotalCollateral`, `requiredSignerHash`,
  `selectUtxosFrom` in that file). Funding it from a script wallet introduces
  the *first* script input into that transaction — and with it a collateral
  requirement it has never had.
- **The three escrow-spending operations carry 1..N escrow script inputs**
  (`builders/batch-interaction.ts:686-704`, `:425-443`) — but since they spend
  no wallet principal, the wallet need not be an input at all.
- **Registry operations spend no script inputs.** The registry policy is a
  minting script; the NFT UTxO is a plain key-locked input
  (`builders/batch-registry.ts:420-426, 593-599`).

### Collateral is a hard wall

Collateral must be key-locked and disjoint from script inputs, asserted in
three places: `builders/batch-interaction.ts:110-119` ("collateral must be
payment-key-locked"), `builders/batch-helpers.ts:403-415`,
`builders/batch-registry.ts:119-128`. A wallet whose whole balance is
script-locked has no collateral candidate; `pickBatchCollateral` returns `null`
and every service takes a defer branch. `ensureCollateralReady`'s repair
transaction is itself a plain key-signed self-send
(`services/wallet-collateral/ensure-collateral-ready.ts:277-293`) and can never
spend a script UTxO. Floor is 5 ADA per candidate with a 2-UTxO readiness gate
(`:29, :151-163`); `WALLET_SPLITTER_LOVELACE = 5_000_000n`
(`builders/batch-helpers.ts:69`) exists to keep that second UTxO alive.

Mesh's `collateral_return` goes back to the collateral input's own address with
**no datum** (`builders/batch-helpers.ts:456-473`) — script-locked collateral
would produce dead change even if it were legal.

### Registry NFTs are key-bound

`findRegistryTokenUtxo` searches only the signing wallet's own UTxOs and throws
otherwise (`src/services/registry/shared.ts:191-208`). Mint asset names are
`blake2b_224(firstUtxo.txId ++ index)` of a **spent input**
(`builders/batch-registry.ts:34-38`; `registry-v2/validators/mint.ak:190`), and
the mint validator requires no signature at all. The mint paths deliberately
rely on `firstUtxo == collateralUtxo` overlap being legal — which it is only for
key-locked UTxOs (`builders/batch-registry.ts:100-128, 184-189`).

### Other structural conflicts

- Every builder calls `requiredSignerHash(deserializeAddress(walletAddress)
  .pubKeyHash)`; a script address has no `pubKeyHash`
  (`batch-interaction.ts:551, 760`; `single-interaction.ts:305, 512`;
  `batch-registry.ts:311, 481, 673`).
- Wallet inputs are spent as bare key inputs via `selectUtxosFrom` with no
  redeemer; no builder emits a `spendingPlutusScript` for a wallet input.
- Change and splitter outputs to the wallet carry **no datum**, on every
  transaction — dead value for any datum-requiring wallet.
- `buildSpendBudgetMap` maps evaluateTx SPEND indices onto sorted escrow items
  by position (`batch-interaction.ts:149-174`); extra SPEND redeemers from
  wallet inputs shift those positions and break the mapping.
  `deriveTotalCollateral` likewise sums only escrow/registry budgets, so extra
  redeemers would under-declare collateral and yield `InsufficientCollateral`.
- `MAX_SAFE_TX_BYTES = 14_000` (`batch-helpers.ts:425`) is already enforced
  after every batch build, and registry register shrinks batches purely for
  size.
- Registry transactions set **no validity range at all**, so any time-gated
  wallet rule has no bounds to check on that path.
