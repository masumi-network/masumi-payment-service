---
id: '13'
title: Split state from treasury, or keep one stateful UTxO
type: grilling
status: closed
assignee: sandro
blocked_by: []
---

# Split state from treasury, or keep one stateful UTxO

## Question

Two requirements collided in
[Where refunds and change return](07-where-refunds-and-change-return.md):

- Anyone must be able to deposit into the wallet with no datum.
- The daily ceiling must cap the **wallet**, not each UTxO independently.

A single stateful UTxO cannot satisfy both — a plain deposit either lands
outside the accounted UTxO, giving a second ceiling, or has to be merged in by
the cold key. So how is the wallet actually structured?

The options, roughly cheapest-validator first.

### A. No on-chain ceiling — the quorum enforces it

Drop `spent_in_period` and the whole period apparatus. A spend is "an
authorized agent signed **and** the quorum threshold is met". No datum, no
counters, no continuing output, no state token, no minting policy. Any UTxO at
the address is spendable; deposits are trivial; multiple UTxOs are harmless.

The ceiling becomes a promise kept by the co-signing service, tracked
off-chain. Worth weighing honestly against the precedent already set: the
recipient allow-list was dropped on exactly this logic, so the quorum is
*already* the only destination control. The counter-argument is that the
ceiling defends against the quorum itself being compromised or buggy — a
defence that only means something if it does not depend on the quorum.

This is the option that would delete most of the contract.

### B. One stateful UTxO, uniqueness enforced by a state token

The shape assumed so far. All funds and all state on one UTxO carrying the
one-shot token. Cheapest transaction — one script input, one continuing output.
Top-ups need the cold key to merge, or must arrive with a correctly authored
datum. Plain deposits become junk UTxOs the cold key sweeps.

Fails the "anyone can deposit plainly" requirement unless that requirement is
relaxed.

### C. State UTxO plus datum-less treasury UTxOs at the same address

The operator's proposal. The state UTxO carries the token and the counters;
treasury UTxOs hold value with no datum. A spend consumes the state UTxO and
whichever treasury UTxOs it needs, and the state input does the accounting over
every input and output at the address.

Satisfies both requirements. Costs: several script inputs per transaction,
which reopens
[Anti-double-satisfaction with escrow inputs](05-anti-double-satisfaction-with-escrow-inputs.md);
a subordinate-input redeemer so non-state inputs defer to the state input; and
a validator that must total values across its own address rather than compare
one input to one output.

### D. Referenced configuration plus a spent counter

Immutable configuration — agents, limits, period length — in a UTxO that is
only ever *referenced*, authenticated by the state token. A small counter UTxO
is spent and re-created per transaction. Treasury UTxOs as in C.

Cheaper reads than C for the immutable half, and one configuration can serve a
fleet of wallets. Costs a third moving part and a rule proving the referenced
UTxO is the genuine one.

### E. Per-period wallets

A fresh wallet address per period, funded with exactly that period's budget.
The cap is physical — you cannot spend what was never deposited — so no
counters, no state, no token. Costs a funding ceremony every period and a new
address for the service to track each time.

## What a resolution looks like

The structure chosen, with the ceiling's enforcement point named explicitly —
chain or quorum — and, if state stays on-chain, which UTxOs a spend consumes
and which it merely references.

## Resolution

**Option B — one state token, in the UTxO that holds the value.** State and
funds live together; the dynamic configuration rides in that UTxO's datum. No
split, no separate treasury, no second script.

**Nothing may be merged or spent alongside it on the agent path.** An agent
spend requires exactly one input at the wallet's own address and produces
exactly one continuing output there. Junk UTxOs at the address, deposits, and
any second wallet UTxO are all excluded from normal operation by that single
rule — the same rule that already closed
[Anti-double-satisfaction with escrow inputs](05-anti-double-satisfaction-with-escrow-inputs.md).

**The cold key is exempt.** `OwnerSpend` places no restriction on how many
own-address inputs it consumes, so merging, sweeping, consolidating and
absorbing deposits are all owner operations. That exemption is what makes the
agent-path rule affordable.

### Shape

The wallet validator **is its own minting policy** — one script carrying both a
`mint` and a `spend` handler, parameterized. Its hash serves as the token's
policy id, the wallet address's payment credential, and the identity the spend
path checks, and it is available at runtime on both sides, so nothing is
circular.

| | Contents |
| --- | --- |
| **Script parameters** (immutable, in the address) | `owner`, `quorum_vks`, `quorum_threshold`, `seed` |
| **Datum** (dynamic, owner-updatable) | `agent`, `limit`, `period_length`, `period_start`, `spent_in_period`, `min_balance_lovelace` |
| **Value** | the treasury, plus exactly one state token |

The datum lives on the UTxO carrying the state token — which, in this design,
is the same UTxO that holds the treasury.

```aiken
/// Matches `vested_pay.ak`'s type for the same reason: see below.
pub type AssetValue =
  Pairs<ByteArray, Pairs<ByteArray, Int>>

pub type Datum {
  agent: VerificationKeyHash,
  limit: AssetValue,
  period_length: Int,
  period_start: POSIXTime,
  spent_in_period: AssetValue,
  min_balance_lovelace: Int,
}
```

### Actions

| Action | Who signs | What it does |
| --- | --- | --- |
| `AgentSpend` | agent **and** quorum | Moves value out, within the ceiling |
| `Deposit` | agent **or** owner | Moves value **in**; nothing may leave |
| `UpdatePolicy` | owner | Rewrites the dynamic config, wallet stays alive |
| `OwnerSpend` | owner | Unrestricted; sweep, retire, rescue |

**`Deposit` is how a wallet is topped up, and it needs no cold key.** Funds
arriving from an external key input are not a merge — the wallet still has
exactly one own-address input and one continuing output, so the single-own-input
rule is untouched. The action requires the datum byte-identical, every asset's
value non-decreasing, no new unlisted asset appearing, and a signature from
**either the agent or the owner**. No quorum: nothing leaves, so there is
nothing for co-signers to approve.

Accepting the owner here costs nothing — the cold key can already deposit via
`OwnerSpend` — and gains something: on this path it *cannot* remove value even
by mistake, because the action forbids it structurally.

The signature requirement is not ceremony. Without it, anyone could churn the
wallet UTxO with dust deposits and break in-flight transaction builds for the
cost of a fee.

This also relaxes one rule on the spend path: `outflow >= 0` becomes per-asset
`spent_in_period += max(0, outflow)`, so a value increase can never shrink a
counter. Unlisted assets stay pinned at exactly zero outflow in **both**
directions, so no stray token can be injected while topping up a budgeted one.

**One agent per wallet**, singular, rather than a list sharing one ceiling. A
second agent means a second wallet — a second state token, a second address,
holding its own agent key in its own datum. Wallets are never merged. The agent stays in the datum rather than the
parameters so a hot key can be rotated without changing the address — hot keys
rotate far more often than quorums do.

**Asset amounts use `Pairs`, not stdlib `Value`.** `Value` is
`Dict<PolicyId, Dict<AssetName, Int>>` whose canonical ordering is an invariant
maintained by its *constructors*; `expect limit: Value = raw` checks only the
structural shape, not the ordering. Since the funding transaction runs no
script, a datum can arrive with duplicate or misordered entries and `dict.get`
will return whichever its ordering assumption reaches first. `vested_pay.ak`
already declares `AssetValue` as `Pairs` for redeemer-supplied amounts for
exactly this reason; datum-supplied amounts deserve the same treatment.

The comparison stays sound because the two sides come from different places:

- **Outflow is computed from the transaction context**, where the ledger
  guarantees well-formed values, so `assets.merge`, `negate` and `flatten` are
  safe.
- **Limit and counter lookups read untrusted structure.** The rule there is to
  require **exactly one matching entry** per asset and fail otherwise, so a
  malformed limit becomes a rejection rather than an ambiguity.

**Amended during implementation (operator correction):** minting is
**derived-name**, not seed-parameterized. The seed is a runtime input consumed
by the mint; the token's name is `blake2b_256(seed_tx ++ index_be4)`, so each
*name* is mintable exactly once — still a ledger guarantee. One script and one
address serve every wallet under a configuration; **each token is one wallet**,
side by side at the shared address, each UTxO holding exactly one token. The
mint is owner-gated and pins the token's destination to the full wallet
address. A burn under the owner's signature retires one wallet cleanly,
avoiding the permanent state thread Epora documents. Script parameters are
`(owner, quorum_vks, quorum_threshold, stake)` — no seed.

Because the policy id *is* this script's hash, "carries a token of our policy"
is a complete identity check — only our own mint handler can ever have produced
one. The asset name is a constant, pinned only to enforce the single-name mint
guard that prevents the infinite-mint hole.

### What this forecloses — superseded
(The section below predates the derived-name amendment: sharding now needs no
new parameterization at all — an additional wallet is an additional mint at the
same address.)

### What the seed-parameterized draft would have foreclosed

One token means one UTxO **per wallet**, so several UTxOs cannot share a
wallet's ceiling or be spent in parallel under one address.

It does **not** foreclose sharding, as an earlier draft of this section
claimed. An additional wallet is a fresh parameterization with a fresh seed —
a new address, a new token, standing alongside the existing wallets. That is
routine creation, not a migration, and it touches nothing already deployed. See
[Migrating a wallet when the quorum changes](12-migrating-a-wallet-when-the-quorum-changes.md).

So parallelism is available by running K wallets rather than K UTxOs, and the
service already supports it: purchases are paired to purchasing wallets and
several wallets each run their own transaction in the same tick
(`batch-payments/service.ts:1275-1298`). The `pendingTransactionId @unique`
constraint serializes *a* wallet, not the service.

The trade is therefore K addresses and K ceilings against K min-UTxO reserves
and K collateral floats — an operational choice made at deployment time, with
no contract change and no migration.

### Consequences

- Refills use `Deposit` and need no cold key. The cold key is reserved for
  policy changes, retirement and rescue.
- Deposits sent *plainly to the address*, rather than through `Deposit`, are
  inert until the owner absorbs them.
  They cost an attacker roughly min-UTxO each, permanently, and never block
  anything: the hot path finds the wallet by its token, and the single-own-input
  rule means junk cannot even be dragged into a spend.
- Lookup is a single asset query. `policy_id` is the script hash, already
  computed to derive the address, so the asset id needs no bookkeeping.
- One script to write, audit and deploy — no separate policy, no co-firing
  invariant, no payout tagging, no aggregate value accounting.

## What the Epora research changed

[Epora wallet design](14-epora-wallet-design.md) is closed, and option C is no
longer hypothetical — it is a built, documented shape with its costs on the
record. Three things it moves:

- **The uniqueness mechanism improves.** One unparameterized global minting
  policy, with per-wallet identity in the asset name derived from a consumed
  input, beats a per-wallet parameterized policy: one policy id, one state
  address, nothing to deploy per wallet.
- **The real cost of C is aggregate accounting**, not the extra input. Because
  the treasury is datum-less, every cap must be evaluated against a total
  across all UTxOs matching the spent input's payment credential, and getting
  that wrong is a live exploit class rather than a bug.
- **The deciding question is narrower than it looked.** Epora's split exists to
  let arbitrary third parties deposit without integration. Here the depositor
  is the operator, and refunds were routed to the agent key rather than the
  wallet by
  [Treasury behind a key buyer, or a script buyer in escrow](11-treasury-behind-a-key-buyer-or-a-script-buyer.md).
  So the question to settle first is not "C or D" but **whether datum-free
  deposits from unintegrated payers are a requirement at all**. If they are
  not, the split's whole justification goes with them.

Note that Epora's size arithmetic does not transfer: its 13 KB state validator
carries beneficiaries, proof-of-life and streaming payments, where this wallet
needs a ceiling, an agent list and a quorum count.

## How "only one token" actually works

A recurring confusion worth settling in writing: the goal is **not** one token
in the whole contract. It is **one token per wallet**, and nothing has to
"reference" it. Two independent mechanisms do the work.

**The policy** makes a given asset name mintable exactly once, ever. The name
is derived from an `OutputReference` the minting transaction consumes, and a
UTxO can be spent only once — so the ledger enforces the uniqueness, with no
registry and no bookkeeping. One global policy serves every wallet.

**The wallet validator** is parameterized with `(policy_id, asset_name)`, so it
knows which token is its own. Every agent spend requires exactly one input
carrying that token and a continuing output carrying it forward. Other UTxOs at
the address reference nothing — they are just value, and the validator sees
them in the same transaction.

Because the token is unique, "per-UTxO ceiling" and "per-wallet ceiling" become
the same thing. That is the whole reason it earns its place.

### Lookup gets cheaper, not more expensive

The worry that many UTxOs at an address make finding the right one slow and
paginated is real *without* a token, and inverted *with* one: a state token is
asset-indexed, so the wallet UTxO is fetched by asset rather than by scanning
the address. Blockfrost exposes `/addresses/{address}/utxos/{asset}` and Koios
an asset-UTxO query; confirm the exact response shapes against whichever
provider a deployment uses. Without a token you must page the address and then
disambiguate by datum shape — which an attacker can imitate.

## How a value UTxO maps to its token

The mint side guarantees unique *names*; it says nothing about which token a
given wallet should accept. That is settled on the spend side, and the answer
is that **the address is the mapping**.

The wallet validator is parameterized by the token identity. Parameters are in
the script hash, the script hash is the payment credential, and the payment
credential is the address. So each wallet has its own address, and a UTxO
sitting at it — with a datum or without one — belongs to that wallet and no
other. Nothing is discovered at spend time; the validator was told its token at
compile time. It checks that one input at its own address carries that token
and that the continuing output carries it forward. No lookup, no per-UTxO
reference, no mapping table.

Per-script-instance uniqueness therefore holds in both minting schemes, but not
equally safely:

- **Seed-parameterized policy** — one token exists under that policy id, ever.
  The validator carries `policy_id`, and checking it is sufficient.
- **Global policy** — many tokens under one policy id, one per wallet. The
  validator must carry `(policy_id, asset_name)` and check both. Check only the
  policy id and any wallet's token satisfies it.

### Destination-pinning IS available — make the wallet its own policy

Superseding the section below. A single Aiken validator may carry both a `mint`
and a `spend` handler and still be parameterized; both compile to the same
script and therefore the same hash. Verified in the scratch project: `.mint`
and `.spend` emit identical 977-byte code under identical parameters.

That hash then serves three roles at once — the token's policy id, the wallet
address's payment credential, and the identity the spend path checks. It is
available at runtime on both sides: handed to `mint` as `policy_id`, and
recovered in `spend` from the own input's address via
`expect Script(own_hash) = own_input.output.address.payment_credential`. Neither
handler needs the other's identity as a parameter, so nothing is circular.

```aiken
validator smart_wallet(owner, quorum, threshold, seed: OutputReference) {
  mint(_redeemer: Data, policy_id: PolicyId, self: Transaction) {
    expect [Pair(asset_name, quantity)] =
      self.mint |> tokens(policy_id) |> dict.to_pairs()
    expect asset_name == state_token
    expect list.any(self.inputs, fn(i) { i.output_reference == seed })

    // Script(policy_id) IS this validator's own address — destination pinned.
    expect Some(Output { value, .. }) =
      list.find(
        self.outputs,
        fn(o) {
          o.address == Address {
            payment_credential: Script(policy_id),
            stake_credential: None,
          }
        },
      )
    quantity_of(value, policy_id, state_token) == 1
  }

  spend(_datum, _redeemer, own_ref, self) {
    expect Some(own_input) = find_input(self.inputs, own_ref)
    expect Script(own_hash) = own_input.output.address.payment_credential
    quantity_of(own_input.output.value, own_hash, state_token) == 1 && ..
  }
}
```

What it delivers together, which the two-script arrangement could not:

- **The token cannot be minted anywhere but into the wallet.**
- **Configuration stays in immutable script parameters**, preserving
  [Quorum signer set, threshold and rotation](04-quorum-signer-set-threshold-and-rotation.md).
- **The spend path verifies the token with no parameter at all.**
- **Lookup is free.** `policy_id == script hash`, already computed to derive the
  address, so the asset id needs no bookkeeping — and the asset name can be a
  constant, retiring the derived-name scheme and its 4-byte endianness footgun.
- **One script instead of two.** The separate one-shot policy is retired.

This is the real reason Epora's `stt.ak` handles both `mint` and `spend` —
self-reference, not reference-script sharing. Epora is unparameterized, so all
its wallets share one address and configuration must live in the datum;
parameterizing keeps per-wallet addresses *and* self-reference, which dominates
here because the quorum was already placed in parameters.

Cost: the wallet script also executes as a minting policy, twice in a wallet's
lifetime. Negligible.

### Superseded: why destination-pinning looked unavailable

The storage template referenced below pins the minted token's destination with
a `validator_hash` parameter on the policy. That is not copyable. Our wallet
address depends on the policy id because it is a parameter; if the policy also
depended on the wallet address, that is a cycle. The storage template escapes
it only because its `storage` validator is unparameterized — one address for
every snapshot — and because it forbids spending entirely, so it never faces a
spend-time mapping question at all. A policy also cannot compute a script hash
on-chain, so there is no way around the cycle in either variant.

Consequence: nothing on-chain guarantees the minted token lands in the wallet.
That is deployment tooling's job, and it is recoverable if fumbled — the token
is still held, and the funding transaction runs no script, so it can be placed
correctly later.

## Correction: parameterize the policy, do not globalize it

The global-policy outline below was imported from Epora without checking
whether Epora's reason for it applies here. It does not.

**Both schemes give a token that can be minted exactly once.** The global one
derives the asset name from a consumed UTxO reference, so that *name* is
unmintable twice. The parameterized one bakes the seed reference into the
script, so that *policy id* can never mint again. Neither is unsound.

**But only the parameterized one makes the policy id an identity.** Under a
global policy, a stranger seeds from their own UTxO and mints a perfectly
valid token under the very same policy id — by design, since one policy serves
every wallet. Any validator that checks only `policy_id` is therefore
exploitable, and must carry and compare a 32-byte asset name as well. Under a
parameterized policy, checking `policy_id` alone is sufficient and safe: there
is no success path under our policy id for anyone else. That removes a whole
class of implementation mistake rather than documenting it.

Demonstrated in a scratch project — 13 tests, all passing on Aiken v1.1.23:

- `global_lets_a_stranger_mint_under_the_same_policy` **succeeds**
- `parameterized_stranger_cannot_reuse_the_policy` **fails**, as intended

**Why Epora chose the global policy, and why it does not transfer.** Epora's
`stt.ak` is a single validator handling both `mint` and `spend`, so the policy
id *is* the state address, and the script is 13 KB — parameterizing it per
wallet would mean a distinct 13 KB script and its own reference-script
deployment for every wallet. Here the policy is separate from the wallet
validator, roughly twenty lines, and executes exactly twice in a wallet's
lifetime: once to mint, once to burn. Sharing a reference script is worth
almost nothing against that.

### External references

All three are in the bundled `cardano-dev-skills` docs under `docs/sources/`:

- `cardano-use-case-templates/storage/onchain/aiken/validators/mint.ak` — a
  canonical parameterized one-shot policy. Its own comment states the property:
  "The seed UTxO parameter makes the script hash unique per-snapshot — once
  that UTxO is spent, the policy can never run again."
- `cardano-use-case-templates/auction/fullstack/scalus/README.md` — "Each
  auction instance is parameterized by a one-shot UTxO, giving it a unique
  policy ID."
- `mesh-sdk-packages/packages/mesh-contract/src/giftcard/infinite-mint/README.md`
  — the **infinite mint** vulnerability, where guarding only the token you care
  about lets a caller mint extra names under the same policy id. The fix is the
  `expect [Pair(asset_name, amount)] = ...` single-name pattern used in both
  outlines here. Also covered in a Gimbalabs AikenPBL lecture linked from that
  README.

### Toolchain finding

**Two validators in one module makes `aiken check` exit 1 with no diagnostic** —
no error, no warning, no output beyond "Compiling". Splitting them into
separate files under `validators/` fixes it. Together with the
leading-underscore filename being silently skipped, that is two distinct silent
failures in one sitting on v1.1.23, and the same class as the Aiken issue #361
that Epora documents.

## Rejected outline — the global one-shot policy

Compiles clean and passes its tests on the pinned Aiken v1.1.23 against stdlib
v2.1.0. Reproduced here rather than committed, since this map does not ship
validator code.

```aiken
use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{blake2b_256}
use aiken/primitive/bytearray
use cardano/assets.{PolicyId, tokens}
use cardano/transaction.{OutputReference, Transaction}

/// Asset name of the state token for the wallet seeded by `ref`:
/// `blake2b_256(transaction_id ++ output_index as 4-byte big-endian)`.
///
/// The fixed 4-byte width matters. A variable-width index would let two
/// distinct `(transaction_id, index)` pairs serialise to the same bytes.
pub fn state_token_name(ref: OutputReference) -> ByteArray {
  blake2b_256(
    bytearray.concat(
      ref.transaction_id,
      bytearray.from_int_big_endian(ref.output_index, 4),
    ),
  )
}

/// One global policy for every smart wallet's state token. Not parameterized:
/// per-wallet uniqueness lives in the asset name, not in the policy id.
validator wallet_state_token {
  mint(_redeemer: Data, policy_id: PolicyId, self: Transaction) {
    // Exactly one asset name under this policy may move in a transaction.
    expect [Pair(asset_name, quantity)] =
      self.mint |> tokens(policy_id) |> dict.to_pairs()

    if quantity == 1 {
      // The name must be derived from an input this transaction spends. A UTxO
      // can be spent exactly once, so this name can be minted exactly once —
      // ever, by anyone, with no registry and no bookkeeping.
      list.any(
        self.inputs,
        fn(input) { asset_name == state_token_name(input.output_reference) },
      )
    } else {
      // Burn, to retire a wallet. Reaching the token at all means satisfying
      // the wallet validator that guards the UTxO holding it, so the policy
      // needs no further check of its own.
      quantity == -1
    }
  }

  else(_) {
    fail
  }
}
```

Two implementation notes learned while checking it:

- A module under `validators/` whose filename starts with an underscore is
  **silently skipped** by `aiken check` — no error, no warning, no tests
  collected. Easy to lose an hour to.
- Unlike Epora, this outline permits a burn. Retiring a wallet cleanly avoids
  the permanent state thread and the terminal-state scars Epora documents, and
  costs nothing: reaching the token already requires satisfying the wallet
  validator.
