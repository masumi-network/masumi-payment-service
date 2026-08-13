# Masumi Smart Wallet Contract

## Overview

An Aiken Plutus V3 treasury wallet. Each wallet is one UTxO carrying a state
token, the funds, and the configuration in its datum. A **cold owner key** can
always move everything. A **hot agent key** — in production, the payment
service's purchasing key — can move value only within a per-period ceiling, and
only with an **external quorum's co-signature**.

One deployment serves many wallets: the token's name is derived from the seed
UTxO consumed at mint (`blake2b_256(seed_tx ++ index_be4)`), so wallets sit
side by side at the same address, each with its own agent, ceiling and
counters. **Each token is one wallet.**

The point is to let automation spend operator funds without holding them: the
mandate lives on-chain, is enforced by the ledger, and can be revoked by the
owner in one transaction that does not even change the address.

The design was worked out ticket by ticket in
[`docs/wayfinder/smart-wallet-capabilities/`](../../docs/wayfinder/smart-wallet-capabilities/map.md),
which records why each rule exists and what was deliberately left out.

## Shape

The validator **is its own minting policy**. One script hash serves as the state
token's policy id, the wallet address's payment credential, and the identity the
spend path checks — available at runtime on both sides, so neither handler needs
the other's identity as a parameter.

|                       | Contents                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------- |
| **Script parameters** | `owner`, `quorum_vks`, `quorum_threshold`, `stake` — immutable, part of the address          |
| **Datum**             | `agent`, `limit`, `period_length`, `period_start`, `spent_in_period`, `min_balance_lovelace` |
| **Value**             | the treasury, plus exactly one state token                                                   |

The seed is **not** a parameter — it is consumed at mint and determines only
the token name. Changing any parameter means a different address; a new wallet
at the *same* address is just a new mint. Only the datum is rewritable in
place, by the owner. The mint is owner-gated, pins the token's destination to
the full wallet address, and requires the receiving UTxO to hold exactly one
token of the policy — so no UTxO can ever hold zero or two.

## Actions

| Action         | Who signs                | What it does                                  |
| -------------- | ------------------------ | --------------------------------------------- |
| `AgentSpend`   | agent **and** quorum     | Moves value out, within the ceiling           |
| `Deposit`      | agent **or** owner       | Moves value **in**; nothing may leave         |
| `UpdatePolicy` | owner                    | Rewrites the datum, wallet stays alive        |
| `OwnerSpend`   | owner                    | Unrestricted: sweep, retire, or rescue        |

## Rules

Every agent spend must satisfy all of these:

1. **Exactly one input of OUR script, one continuing output at the same full
   address.** Foreign script inputs are permitted — the wallet funds
   transactions that interact with other contracts, locking into the payment
   escrow being the primary case. What can never happen is two wallet shards
   settling in one transaction, which is what keeps each ceiling independent.
   Matching the full address, stake part included, also stops a spend
   re-delegating the treasury.
2. **The input carries exactly one state token, and the continuing output
   carries the same one** — identity is the token name, so a sibling wallet's
   token cannot be swapped in.
3. **Agent signature, plus weighted quorum.** A key listed twice carries two
   votes; the agent's own key never counts, even if listed.
4. **Both validity bounds finite.**
5. **Per asset**: `spent += max(0, outflow)`, every moved asset must have a
   limit entry, and `spent + outflow <= limit`.
6. **Unlisted assets are frozen in both directions** — they can neither leave
   nor be added. This is what pins the state token in place, with no rule
   written for it.
7. **The lovelace floor holds** on the continuing output.
8. **Rolling window**: the counter resets when `lower >= period_start +
   period_length`, and on roll-over the validity range must fit inside the new
   window, so an agent cannot back-date to accrue budget.
9. **The output datum equals the input datum** with only `period_start` and
   `spent_in_period` advanced.

Deliberately absent: recipient allow-list, expiry, on-chain freeze, successor
pointer, `Retire` action, mint awareness, aggregate accounting, second script.
Each was considered and dropped for a reason recorded on the map.

## Building

```sh
aikup install v1.1.23
```

```sh
aiken build
```

The compiled hash — and therefore every wallet address — depends on the exact
compiler version.

```sh
aiken check
```

62 tests — unit and property (fuzzed, 100 runs each): the happy paths, and one per rule above from the attacker's side.

### Toolchain warning

Aiken v1.1.23 fails **silently** on at least six mistakes — `aiken check`
exits non-zero printing only `Compiling`, with no diagnostic:

- a module under `validators/` whose filename starts with an underscore is
  skipped entirely
- two validators declared in one module
- an arity mismatch at a call site
- an arithmetic expression as a `via` fuzzer bound (literals only)
- a test with more than one `via` argument (pack pairs with `fuzz.both`)
- duplicate top-level definitions in a module

Each costs a bisect. If `aiken check` exits 1 with no error, suspect one of
these before doubting the code. Mesh has a sibling trap: `MeshTxBuilder`
without an `evaluator` stamps default execution budgets instead of running the
script — transactions overpay ~0.6 ADA and invalid ones "build" fine, only
dying at submission.

## Security notes

- **`limit` must list lovelace** (policy `#""`, name `#""`), or the wallet can
  neither spend nor receive ADA — a spend moves lovelace even when it only pays
  the fee. Nothing on-chain checks this.
- **`quorum_threshold <= 0` disables the quorum permanently** at that address,
  leaving the hot key bounded only by the ceiling, unrecoverable short of a new
  wallet. A threshold above the achievable weight is the milder mistake: the
  agent path is dead but `OwnerSpend` still sweeps. Deploy tooling owns both.
- **At most 16 budgeted assets.** A spend costs roughly (assets moved x assets
  listed); the bound is checked on the spend path, so a malformed funding datum
  cannot dodge it.
- **`limit` and `spent_in_period` must list the same assets in the same order.**
  A mismatch written by `UpdatePolicy` silently brings down every later agent
  spend. `OwnerSpend` always recovers the funds.
- **Datum-supplied asset values are untrusted.** Lookups fail closed on a
  duplicate policy or asset name rather than picking a resolution an attacker
  chose.
- **The mint does not validate the initial datum.** A wallet can be born with
  a malformed or missing datum; the agent path is then dead on arrival. Only
  the owner can mint, and a cold-key `UpdatePolicy` repairs it in place — the
  same no-on-chain-config-guard stance as the quorum threshold.
- **Owner key compromise is total loss.** No recovery, no guardians, no
  timelock.
- **Freezing is off-chain**: co-signers refusing to sign halts spending in
  seconds, with no transaction. Revoking the agent is a cold-key `UpdatePolicy`
  that keeps the address. Replacing a *co-signer* means a new wallet.

## Demo

```sh
pnpm install --ignore-workspace
```

`--ignore-workspace` is required: the repo root is a pnpm workspace that does
not include `smart-contracts/*`, and this package pins its own Mesh release. The
`@harmoniclabs/crypto` peer warning is expected — see
`docs/adr/0005-meshsdk-version-pinning-v1-v2.md`.

```sh
pnpm run verify
```

An offline self-test — datum encoding, blueprint agreement, address derivation,
and the budget arithmetic that must mirror the validator. No network, no
wallets.

```sh
pnpm run generate-wallet
```

Six wallets: owner, agent, recipient, and three co-signers. `*.sk` files are
git-ignored.

**Fund only two of them.** Co-signers need keys but never funds — they only
sign.

| Wallet                 | Fund       | Why                                              |
| ---------------------- | ---------- | ------------------------------------------------ |
| `wallet_1` owner       | ~100 tADA  | Seeds and funds the wallet; pays for update/sweep |
| `wallet_2` agent       | ~30 tADA   | Fees and collateral for spends and deposits       |
| `wallet_3` recipient   | —          | Only receives                                     |
| `wallet_4/5/6`         | —          | Sign only                                         |

Then, in order:

| Command                 | Who            | What happens                                        |
| ----------------------- | -------------- | --------------------------------------------------- |
| `pnpm run init`         | owner          | Mints the state token and funds the wallet          |
| `pnpm run inspect`      | –              | Balance, budget used, window, frozen assets         |
| `pnpm run agent-spend`  | agent + quorum | Pays `wallet_3` within the ceiling                  |
| `pnpm run deposit`      | agent or owner | Tops the wallet up; no quorum needed                |
| `pnpm run update-policy`| owner          | Rotates the agent or re-budgets, address unchanged  |
| `pnpm run sweep`        | owner          | Sweeps the funds and burns the token                |
| `pnpm run e2e-negative` | –              | 12 attack txs vs the live wallet; all must fail evaluation |
| `pnpm run fuzz-e2e`     | –              | Differential fuzz: off-chain mirror vs live validator |

`init` writes `wallet-seed.json`. The seed determines the **token name** — the
wallet's identity among its siblings at the shared address. **Keep that file**:
without it you can no longer tell which shard is yours except by elimination.
It is git-ignored as local deployment state.

Useful environment variables: `NETWORK` (`preprod`), `FUND_LOVELACE`,
`DAILY_LIMIT_LOVELACE`, `PERIOD_MS`, `MIN_BALANCE_LOVELACE`, `PAYOUT_LOVELACE`,
`DEPOSIT_LOVELACE`, `AS_OWNER=1` (deposit as owner), `ROTATE_AGENT_TO=<index>`,
`QUORUM_THRESHOLD`, `SWEEP_ADDRESS`.

## Files

| Path                                | Contents                                          |
| ----------------------------------- | ------------------------------------------------- |
| `validators/smart_wallet.ak`        | Both handlers and redeemer dispatch               |
| `lib/smart_wallet/types.ak`         | Datum, actions, `AssetValue`                      |
| `lib/smart_wallet/spend.ak`         | Spending rules                                    |
| `lib/smart_wallet/mint.ak`          | One-shot mint, destination pin, burn              |
| `lib/smart_wallet/asset_value.ak`   | Datum-safe asset arithmetic                       |
| `lib/smart_wallet/*_test.ak`        | Test suite                                        |
| `wallet_lifecycle_diagram.md`       | Lifecycle, budget window, transaction shapes      |
| `example-helpers.mjs`               | Encoding, address derivation, budget mirror       |
