# V2 contract upgrade — CIP-30 admin signatures + Aiken v1.1.23

This upgrade replaces the pinned bare `{1: -8}` CIP-8 header check on
`WithdrawDisputed` with full CIP-30-compatible signature verification
(accepting both raw and CIP-8 hashed-mode payloads), adds an on-chain
threshold-reachability guard (`required_admins_multi_sig <= len(admin_vks)`,
matching the bound `getPaymentScriptV2` already enforces off-chain), and
bumps the V2 Aiken compiler pin from v1.1.21 to v1.1.23. **These changes
alter the compiled script hash**, so every derived address and registry
policy id changes even when validator parameters
(`required_admins_multi_sig`, `admin_vks`, `cooldown_period`) stay the same.

## What changed on-chain

| Artifact | v1.1.21 (previous) | v1.1.23 + CIP-30 fix (this release) |
| -------- | ------------------ | ------------------------------------ |
| Payment script hash | `bdbde1ee86893fdb8bdda96a4d7ca933de7850f8fe19bf2b16dd636f` | `2d6abca32e4b22b59e948ef22dfe682017de917a9ec088aa1bc3c64e` |
| Registry policy hash | `7890b485b808043ef80136a447a3a43c18893a309dc323d1f8b0a13d` | `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b` |

With the default seed admin wallets and `DEFAULT_ADMIN_SIGNATURES_V2 = 2`,
`COOLDOWN_TIME = 7 minutes`:

| Network | Payment script address (new) | Registry policy id (new) |
| ------- | ---------------------------- | ------------------------ |
| Preprod | `addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g` | `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b` |
| Mainnet | `addr1wxs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgge2j6d` | `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b` |

Previous preprod payment address (for reference when migrating UTxOs):
`addr_test1wqsztux7j6c23ukjj3328vvxe3yqug43fs9vufysg6ddxpg8xqev4`.

Canonical constants live in `packages/payment-core/src/config.ts`
(`PAYMENT_SMART_CONTRACT_ADDRESS_V2_*`, `REGISTRY_POLICY_ID_V2_*`). `prisma/seed.ts`
validates derived addresses against those defaults before inserting payment
sources.

## Funds locked under the old script

UTxOs locked at the **old** payment script address remain spendable only with
the **old** compiled validator (the v1.1.21 `plutus.json` artifact). They
cannot be moved by transactions built against the new blueprint. Plan one of:

1. **Drain before deploy** — settle or refund every open escrow at the old
   address, then deploy the new payment source.
2. **Parallel sources** — keep the old `PaymentSource` row (soft-deleted or
   marked inactive after drain) and create a new `Web3CardanoV2` row with the
   new `smartContractAddress` / `policyId`. New purchases use the new source;
   the tx-sync jobs for each source only watch their own address.
3. **Admin dispute on old UTxOs** — if disputes remain on the old contract,
   admins must sign with tooling that matches the **old** validator (bare
   `{1: -8}` headers only). After upgrade, browser-wallet `signData` works on
   the **new** validator only.

Registry assets minted under the old policy id remain valid NFTs; re-register
agents under the new policy when switching payment sources.

## Deploy sequence

1. **Build contracts locally with the pinned compiler**

   ```sh
   aikup install v1.1.23
   cd smart-contracts/payment-v2 && aiken build && aiken check
   cd ../registry-v2 && aiken build && aiken check
   cd ../.. && bash scripts/check-v2-contracts.sh
   ```

2. **Verify dispute settlement on preprod (recommended)**

   ```sh
   cd smart-contracts/payment-v2
   pnpm install
   pnpm run generate-wallet   # if local example wallets are missing
   pnpm run verify-onchain    # lock fake Disputed UTxO + evaluate/submit WithdrawDisputed
   ```

   Last verified 2026-07-02 against the current blueprint (raw + CIP-8
   hashed payload modes + threshold-reachability guard): a
   `WithdrawDisputed` settlement signed by one raw CIP-30
   `MeshWallet.signData` admin signature and one CIP-8 hashed-mode
   admin signature (payload = `blake2b_224(intent hash)`) was accepted on
   preprod —
   [lock tx `121a99dc…`](https://preprod.cardanoscan.io/transaction/121a99dcb108574b81c3ef5310d15fcb3e65ec51cca8df15fdb4e39b9e66ec9d),
   [settlement tx `2521fec4…`](https://preprod.cardanoscan.io/transaction/2521fec45ee81f43edde626e6341dc807df938fff70d36ec621eb9e3d7578c0c)
   (SPEND budget: mem 781,189 / steps 433,844,663 — the hashed-mode
   signature pays a second ed25519 verify after the raw branch fails). The
   example-run script address differs from the table above because the
   example admin wallets differ from the seed defaults; the compiled
   blueprint is identical.

3. **Deploy application code** with the updated `plutus.json` files committed.

4. **Create or re-seed payment sources** — either run `prisma/seed.ts` on a
   fresh database (with V2 mnemonics configured) or insert a new
   `PaymentSource` row via the admin API with addresses derived from
   `getPaymentScriptV2` / `getRegistryScriptV2` using your production admin
   wallet set. Do **not** assume the old row's address still matches.

5. **Re-register agents** — mint new registry assets under the new policy id
   and update `SupportedPaymentSource` metadata to point buyers at the new
   payment script address.

6. **Smoke-test** — open a V2 purchase, run submit-result / refund paths, and
   settle a test dispute with `wallet.signData` (CIP-30 headers) via admin
   tooling.

## Admin tooling note

`WithdrawDisputed` now accepts any CIP-8 `COSE_Sign1` protected header map up
to 256 bytes, as long as the ed25519 signature verifies over the reconstructed
`Sig_structure`. Standard CIP-30 `api.signData(addr, payload)` output from
Eternl, Lace, Mesh, etc. works without header rewriting. Raw-signing tools that
emit bare `{1: -8}` headers remain supported.

Both CIP-8 payload modes verify on-chain: raw payloads (software wallets, per
CIP-30) and hashed mode (`hashed: true`, common with hardware wallets), where
the signed `Sig_structure` carries `blake2b_224(payload)` instead of the raw
payload. Exactly one hash level is accepted. Non-hashed signing remains
recommended where the device allows it; see the runbook.

See `smart-contracts/payment-v2/README.md` (Admin signing runbook) for the
off-chain signing payload and timing rules.
