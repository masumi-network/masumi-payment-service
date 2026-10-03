---
id: '14'
title: Epora wallet design
type: research
status: closed
assignee: research-subagent
blocked_by: []
---

# Epora wallet design

## Question

The operator pointed at Epora's wallet design as prior art for a smart wallet
built from two interlocking contracts, where a state thread token carries the
wallet's configuration and the treasury holds plain, datum-less value.

What is that design, concretely?

- How are state and treasury separated, and which UTxOs does a spend consume
  versus reference?
- How is the state thread token minted, forwarded and protected, and what
  happens if it is lost?
- How does the design stop the same authorization being counted twice when a
  transaction carries several inputs from the same script?
- What spending controls does it enforce — limits, allow-lists, multisig — and
  where does each live?
- What does it cost per transaction, in script inputs, redeemers and size?
- What does it deliberately *not* do, and what have its authors said about the
  trade-offs?

If the design is not publicly documented in enough detail, say so plainly
rather than reconstructing a plausible-sounding version of it.

## Why it matters

It is the closest named prior art to options C and D in
[Split state from treasury, or keep one stateful UTxO](13-split-state-from-treasury.md).
Reading it before choosing could save inventing a shape someone has already
built and debugged — or reveal why they did not.

## Resolution

Publicly documented, in detail, at
[`github.com/schaier-io/epora-wallet`](https://github.com/schaier-io/epora-wallet)
— MIT, Aiken plus TypeScript, with a whitepaper, an interaction map and a
security evidence map. It is the operator's own project rather than third-party
prior art, and the repo states plainly that it is **unaudited and preprod
only**. It grew out of a Catalyst Fund 11 proposal for a dead-man-switch
permission wallet, so its feature set — beneficiaries, proof-of-life, streaming
payments — is much wider than a payment-service treasury needs.

### Structure

Three validators:

| Script | Role | Parameterized by |
| --- | --- | --- |
| `validators/stt.ak` | mint + spend; owns every state transition; holds all config in its datum | nothing — one global policy for all wallets |
| `validators/wallet.ak` | treasury custody only | `(stt_policy_id, asset_name)`, so each wallet gets its own treasury address |
| `validators/stt_reference_store.ak` | always-fail address hosting the STT reference script | nothing |

A spend consumes exactly one STT UTxO plus zero or more treasury UTxOs, and
references the STT reference script. The wallet script is attached inline
rather than referenced, because it is parameterized per wallet.

**Treasury UTxOs carry no datum at all.** The whitepaper makes this the central
argument for splitting: a deposit is an ordinary payment, and "there is no
datum to get wrong".

### Uniqueness — a better variant than the one I described

The STT minting policy is **not** parameterized by an `OutputReference`.
It is a single unparameterized global policy, and per-wallet uniqueness lives
in the **asset name**: `blake2b_256(tx_id ++ output_index as 4-byte
big-endian)` of a consumed input. The fixed 4-byte width is deliberate — a
variable-width encoding could collide two `(tx_id, index)` pairs.

Same uniqueness source as a parameterized one-shot policy (a UTxO can be spent
only once), but one policy id and one STT address serve every wallet, so there
is no per-wallet policy to deploy. The derivation is pinned on both sides of
the boundary by a shared test vector.

### How it holds together

- **Co-firing invariant.** The STT spend redeemer is the single source of
  truth; the wallet validator reads it via `tx.redeemers[Spend(stt_ref)]`. A
  wallet spend without a co-firing STT spend is impossible; an STT spend alone
  is allowed, so every STT branch must be self-contained.
- **Aggregate accounting.** Because the treasury is many datum-less UTxOs, the
  wallet validator totals input value, output value and payout value across
  every UTxO in the transaction matching the spent input's **payment
  credential** — not its full address. Every per-invocation cap is checked
  against that same aggregate, so N executions in one transaction agree.

### Three separate anti-double-satisfaction defences

1. **STT singleton** — exactly one input and one output at the STT address,
   with the enterprise-address pin at mint making it a per-policy singleton.
2. **Credential aggregation** — matching by payment credential stops a
   beneficiary multiplying its share across stake-credential variants of the
   same script hash.
3. **Payout routing** — for each payout asset, no output may carry it except a
   wallet self-return, the full-address STT continuation, or a payee output
   tagged with an `OutputId` referencing the consumed STT input, which makes
   the tag replay-proof per spend. There is a named regression test for the
   external-funds-satisfy-the-tag attack.

### Costs and scars

- **Sizes:** STT 13,180 bytes (~12.9 KiB against a 16 KiB limit), wallet 6,036,
  reference store 93.
- **Per treasury input:** one execution of the wallet script and one redeemer,
  each re-running the aggregate snapshot.
- **No burn path, by design** — "exactly one STT, always" is kept
  unconditional. Consequences the project documents: a permanent state-token
  deposit; a terminal recovery state where a beneficiary-only wallet ends with
  no access path at all; and tokenless outputs at the shared STT address being
  permanently unspendable, so indexers must filter by token.
- **Multisig power is summed per record, not per key.** Config validation
  enforces unique user ids, not unique keys, so one key in two powered records
  counts twice — the same footgun as duplicate `admin_vks`.
- **Aiken toolchain constraint:** adding a sixth script purpose to `wallet.ak`
  makes `aiken check` exit non-zero with no diagnostic, upstream Aiken
  issue #361, re-verified on the pinned v1.1.23.

### The finding that matters most here

The split buys **unrestricted datum-free receiving** and **audit
separability**, and pays for it with aggregate value accounting, per-input
script cost, and a permanent state thread. Whether that trade is right for a
payment-service treasury turns on a question this map has already half
answered: our depositor set is the operator, and refunds were routed to the
agent key rather than the wallet, so arbitrary third parties paying in without
integration is not currently a requirement.

Do not import Epora's size arithmetic. Its 13 KB STT carries beneficiaries,
proof-of-life and streaming payments; the equivalent here is a ceiling, an
agent list and a quorum count.
