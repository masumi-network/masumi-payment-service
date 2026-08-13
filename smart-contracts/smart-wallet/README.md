# Masumi Smart Wallet Contract

## Overview

This is an Aiken Plutus V3 treasury wallet. Each wallet is one UTxO. The UTxO
holds the funds, a state token, and the configuration in its datum.

The wallet gives three parties three different powers:

- The **owner key** is cold. It can always move everything.
- The **agent key** is hot. In production it is the purchasing key of the
  payment service. It can move value only inside a per-period ceiling.
- The **co-signers** are external services. Every agent spend needs their
  approval. They hold keys but never funds.

The goal: automation can spend operator funds without holding them. The ledger
enforces the mandate. The owner can revoke the agent key in one transaction,
and the address does not change.

The design record is in
[`docs/wayfinder/smart-wallet-capabilities/`](../../docs/wayfinder/smart-wallet-capabilities/map.md).
It contains 16 tickets. Each ticket records why a rule exists or why a feature
was dropped.

## How the contract works

### One script, three roles

The validator is also its own minting policy. One script hash is, at the same
time:

1. The policy id of the state token.
2. The payment credential of the wallet address.
3. The identity that the spend rules check.

The hash is available on both sides at run time. The mint handler receives it
as `policy_id`. The spend handler reads it from the address of its own input.
Because of this, no handler needs the identity of the other as a parameter.

### The state token is the wallet

The mint consumes a seed UTxO and derives the token name from it:
`blake2b_256(seed_tx_hash ++ seed_index_as_4_bytes)`. The ledger permits each
UTxO to be spent once. Therefore each token name can exist once, forever.

One deployment serves many wallets. All wallets under one configuration share
one address. Each wallet is one token, one UTxO, one datum, one agent, one
ceiling. No transaction can spend two wallets together. To add capacity, the
owner mints one more token.

The mint applies five checks:

1. The owner signed the transaction.
2. The token name matches a consumed seed UTxO.
3. The token goes to the full wallet address, and to no other place.
4. The receiving UTxO holds exactly one token of the policy and a datum that
   parses. It holds no reference script.
5. The transaction moves exactly one token name of the policy.

The burn branch needs the owner signature and a quantity of exactly minus one.
A burn retires one wallet. Other wallets at the address keep their tokens.

### Script parameters and datum

| Location | Fields | Who can change them |
| --- | --- | --- |
| Script parameters | `owner`, `quorum_vks`, `quorum_threshold`, `stake` | Nobody. A change makes a new address. |
| Datum | `agent`, `limit`, `period_length`, `period_start`, `spent_in_period`, `min_balance_lovelace` | The owner, in place. |

The seed is not a parameter. It only selects the token name.

`limit` and `spent_in_period` are per-asset lists (`Pairs`, not `Value`). A
datum comes from an unvalidated transaction, so the validator does not trust
its order. Lookups fail when a policy or an asset name appears twice.

### Actions

| Action | Signers | Effect |
| --- | --- | --- |
| `AgentSpend` | agent **and** co-signer quorum | Value moves out, inside the ceiling |
| `Deposit` | agent **or** owner | Value moves in, nothing moves out |
| `UpdatePolicy` | owner | The datum changes, the wallet stays alive |
| `OwnerSpend` | owner | No restrictions: sweep, retire, rescue |

### Rules of an agent spend

1. The transaction spends exactly one input of this script. Foreign script
   inputs are permitted. The wallet can fund an escrow lock in the same
   transaction. Two wallets can never settle together.
2. Exactly one output returns to the same full address, stake part included.
   This stops a change of the stake delegation.
3. The input holds exactly one state token. The output holds the same token.
4. The agent signed, and the co-signer quorum is met. A key that appears twice
   in `quorum_vks` counts twice. The agent key and the owner key never count.
5. Both ends of the validity range are finite.
6. For each asset: the spent counter increases by the outflow when the outflow
   is positive. Each moved asset must have a limit entry. The counter must stay
   at or below the limit.
7. Assets without a limit entry are frozen in both directions. This rule also
   keeps the state token in place.
8. The lovelace on the continuing output stays at or above
   `min_balance_lovelace`.
9. The datum lists at most 16 assets.
10. The budget window rolls: when the lower bound of the validity range passes
    `period_start + period_length`, the counters reset and the window moves to
    the lower bound. On a roll-over, the validity range must fit inside one
    window. This stops back-dated windows.
11. The output datum equals the input datum, with only `period_start` and
    `spent_in_period` changed.

### Deposits

A deposit adds value and removes nothing. The datum must stay byte-identical.
Each added asset must have a limit entry. At least one asset must move. The
agent or the owner must sign. No quorum is needed, because nothing leaves.

The signature requirement has a purpose. Without it, anyone could spend and
re-create the wallet UTxO for the cost of a fee. Each such churn invalidates
every transaction that was built against the previous UTxO.

### Retire

The owner spends the wallet with `OwnerSpend` and burns the token in the same
transaction. The address stays valid for other wallets. A swept but unburned
token is a risk: its holder can re-create a spendable wallet UTxO at the old
address. The demo sweep script burns in the same transaction for this reason.

### What the contract does not do

These items were dropped on purpose. The design record holds the reasons.

- No recipient allow-list. The co-signers control destinations.
- No expiry on the delegation. The co-signers can stop at any time.
- No on-chain freeze. Co-signer refusal stops spending in seconds.
- No datum-value checks at mint or update. Deploy tooling owns the values.
  The mint checks only that the datum parses.

## Build and test the contract

Install the pinned compiler, then build and test:

```sh
aikup install v1.1.23
```

```sh
aiken build
```

```sh
aiken check
```

The compiled hash depends on the exact compiler version. A different version
produces a different address.

`aiken check` runs 65 tests. The suite contains one test per rule above, from
the attacker's side, plus four property tests with 100 random runs each. The
property tests cover the counter arithmetic, the shape functions, and the
collision resistance of the token-name derivation.

### Toolchain warnings

Aiken v1.1.23 fails without a diagnostic in at least six cases. `aiken check`
exits non-zero and prints only `Compiling`:

- A module under `validators/` with a filename that starts with an underscore.
  Aiken skips the module.
- Two validators in one module.
- An arity mismatch at a call site.
- An arithmetic expression as a `via` fuzzer bound. Use literals.
- A test with more than one `via` argument. Pack pairs with `fuzz.both`.
- Duplicate top-level definitions in a module.

When `aiken check` exits 1 with no error text, look for these first.

Mesh has a related trap. A `MeshTxBuilder` without an `evaluator` does not run
the script. It stamps default execution budgets. Transactions then overpay
about 0.6 ADA, and invalid transactions build without error and die at
submission. Every script in this directory passes `evaluator`.

## Run the demo scripts

The demo scripts run the full wallet lifecycle on the preprod test network.

### 1. Install

```sh
pnpm install --ignore-workspace
```

`--ignore-workspace` is required. The repository root is a pnpm workspace that
does not include `smart-contracts/*`, and this package pins its own Mesh
version. The `@harmoniclabs/crypto` peer warning is expected. See
`docs/adr/0005-meshsdk-version-pinning-v1-v2.md`.

### 2. Check the toolchain offline

```sh
pnpm run verify
```

This runs 15 checks without a network and without keys: datum encoding, field
order against `plutus.json`, address derivation, token-name derivation, and
the budget arithmetic that mirrors the validator.

### 3. Create the keys

```sh
pnpm run generate-wallet
```

This writes six key files. Git ignores the `.sk` files.

| File | Role |
| --- | --- |
| `wallet_1` | owner key |
| `wallet_2` | agent key |
| `wallet_3` | recipient |
| `wallet_4`–`wallet_6` | co-signers |

### 4. Fund two wallets

Fund only the owner and the agent from the
[preprod faucet](https://docs.cardano.org/cardano-testnets/tools/faucet).
Co-signers sign but never pay.

| Wallet | Amount | Purpose |
| --- | --- | --- |
| `wallet_1` owner | about 100 tADA | Seed, initial funds, policy updates, sweep |
| `wallet_2` agent | about 30 tADA | Fees and collateral for spends and deposits |

### 5. Run the lifecycle

Run the steps in order. Wait for confirmation between steps, because each
transaction spends the output of the previous one. Confirmation takes about
one to two minutes on preprod. `pnpm run inspect` shows the current state.

1. `pnpm run init` — the owner mints the state token and funds the wallet.
   The script writes `wallet-seed.json`. Keep this file. It names your wallet
   among its siblings at the shared address. Git ignores it.
2. `pnpm run inspect` — shows balance, budget, window, and frozen assets.
3. `pnpm run agent-spend` — the agent and two co-signers pay the recipient.
4. `pnpm run deposit` — the agent adds funds. No quorum is needed.
   Set `AS_OWNER=1` to deposit with the owner key instead.
5. `pnpm run update-policy` — the owner changes the datum in place.
   Set `ROTATE_AGENT_TO=<index>` to replace the agent key.
   Set `DAILY_LIMIT_LOVELACE=<n>` to change the ceiling and reset the counter.
6. `pnpm run sweep` — the owner sweeps the funds and burns the token.

## Test against the live network

Two suites exercise the deployed script against a live wallet. Both build
transactions and let the provider evaluate them. Neither submits. No funds
move and no collateral is at risk. Run them after `pnpm run init` confirmed.

### Negative suite

```sh
pnpm run e2e-negative
```

The suite builds 12 forbidden transactions and expects the validator to reject
each one: over-budget payout, understated counter, missing quorum, missing
agent signature, token theft, agent self-rotation, limit increase, wallet
split, value-removing deposit, unlisted-asset deposit, non-owner update, and
non-owner sweep.

Each PASS line states the rejection stage. `rejected on evaluation` means the
script itself refused. `REJECTED PRE-EVALUATION` means the transaction did not
build, and the case did not reach the script. Inspect such a case, because it
no longer tests the validator. Set `VERBOSE=1` to print the error text.

### Differential fuzz

```sh
pnpm run fuzz-e2e
```

Each round draws a random payout and sometimes a forged counter. The off-chain
mirror predicts the verdict. The provider evaluates the real script. The two
verdicts must agree on every round. A disagreement means the mirror and the
validator drifted apart.

The run is reproducible. `FUZZ_SEED=<n>` fixes the random sequence, and
`FUZZ_ROUNDS=<n>` sets the round count (default 12).

## Configuration reference

All variables are optional.

| Variable | Default | Used by |
| --- | --- | --- |
| `NETWORK` | `preprod` | all scripts |
| `FUND_LOVELACE` | `60000000` | init |
| `DAILY_LIMIT_LOVELACE` | `20000000` | init, update-policy |
| `PERIOD_MS` | `86400000` | init |
| `MIN_BALANCE_LOVELACE` | `5000000` | init, update-policy |
| `QUORUM_THRESHOLD` | `2` | all scripts |
| `QUORUM_KEY_HASHES` | co-signer wallets | all scripts |
| `PAYOUT_LOVELACE` | `3000000` | agent-spend |
| `RECIPIENT_ADDRESS` | `wallet_3` | agent-spend |
| `DEPOSIT_LOVELACE` | `10000000` | deposit |
| `AS_OWNER` | unset | deposit |
| `ROTATE_AGENT_TO` / `NEW_AGENT_KEY_HASH` | unset | update-policy |
| `SWEEP_ADDRESS` | owner address | sweep |
| `FORCE_NEW` | unset | init (overwrite an old seed) |
| `INVALID_BEFORE_MS` / `INVALID_AFTER_MS` | now−5min / now+5min | spend paths |
| `FUZZ_SEED` / `FUZZ_ROUNDS` | time / `12` | fuzz-e2e |
| `VERBOSE` | unset | e2e-negative |

## Security notes

- `limit` must list lovelace (policy `#""`, name `#""`). Without it the wallet
  can neither spend nor receive ADA, because every spend moves lovelace. No
  on-chain check exists for this.
- `quorum_threshold <= 0` disables the quorum forever at that address. The
  agent key is then bounded only by the ceiling. Recovery needs a new wallet.
  A threshold above the reachable weight is the milder mistake: the agent path
  is dead, but `OwnerSpend` still sweeps. Deploy tooling must check both.
- The datum can list at most 16 assets. The spend path enforces the bound, so
  a malformed funding datum cannot avoid it.
- `limit` and `spent_in_period` must list the same assets in the same order.
  A mismatch written by `UpdatePolicy` stops all later agent spends.
  `OwnerSpend` always recovers the funds.
- The mint checks the datum shape, not the values. A zero threshold or a
  missing lovelace entry still passes. Deploy tooling owns the values.
- Loss of the owner key is total loss. There is no recovery path, no guardian
  set, and no timelock.
- The freeze mechanism is off-chain. Co-signers stop signatures, and spending
  stops in seconds without a transaction. The owner replaces the agent key
  with `UpdatePolicy`, and the address stays. To replace a co-signer, create a
  new wallet.

## Files

| Path | Content |
| --- | --- |
| `validators/smart_wallet.ak` | Both handlers and the redeemer dispatch |
| `lib/smart_wallet/types.ak` | Datum, actions, `AssetValue` |
| `lib/smart_wallet/spend.ak` | Spend rules |
| `lib/smart_wallet/mint.ak` | Mint, destination pin, burn |
| `lib/smart_wallet/asset_value.ak` | Datum-safe asset arithmetic |
| `lib/smart_wallet/*_test.ak` | Unit tests |
| `lib/smart_wallet/property_test.ak` | Property tests |
| `wallet_lifecycle_diagram.md` | Lifecycle and transaction shapes |
| `example-helpers.mjs` | Encoding, derivation, budget mirror |
| `e2e-negative-tests.mjs` | 12 attack transactions against the live wallet |
| `fuzz-e2e.mjs` | Differential fuzz against the live wallet |
