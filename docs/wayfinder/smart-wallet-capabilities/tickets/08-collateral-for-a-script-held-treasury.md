---
id: '08'
title: Collateral for a script-held treasury
type: grilling
status: closed
assignee: sandro
blocked_by: ['02', '11']
---

# Collateral for a script-held treasury

## Question

Every Plutus transaction needs a collateral input that is key-locked and
disjoint from the script inputs it is collateralizing. Move the treasury behind
a script and the wallet itself can never supply it — the agent key must hold
plain ADA of its own, permanently, outside the mandate.

Decide:

- Who funds that collateral float, and how it is replenished when phase-2
  failures burn it.
- Whether the wallet may pay **out to its own agent key** for a collateral
  top-up — an explicit hole in the recipient allow-list, and the obvious way to
  drain a wallet one top-up at a time if it is not bounded.
- What the agent's float has to be, given the collateral floor the V2 code
  already enforces and the per-script-input scaling it applies.
- What happens when the float runs dry mid-batch: fail closed, or is there a
  recovery path that does not need the cold key?

## What a resolution looks like

The collateral sourcing model, any allow-list exemption written as a bounded
rule rather than an exception, and the failure behaviour when the float is
exhausted.

## Update from the transaction inventory

Confirmed, and harder than assumed. Key-locked disjoint collateral is asserted
in three separate places (`batch-interaction.ts:110-119`,
`batch-helpers.ts:403-415`, `batch-registry.ts:119-128`). The readiness gate
wants **two** UTxOs and a 5 ADA floor
(`wallet-collateral/ensure-collateral-ready.ts:29, 151-163`), and its repair
transaction is a plain key-signed self-send (`:277-293`) that can never spend a
script UTxO. `WALLET_SPLITTER_LOVELACE = 5_000_000n`
(`batch-helpers.ts:69`) exists solely to keep that second UTxO alive.

Two consequences to settle here: the agent key needs a permanent key-locked
float that the wallet's mandate does not cover, and `batch-payments` — which
declares no collateral at all today — would need collateral for the first time
the moment a wallet script input enters it.

## Resolution

### Verified: collateral can never be script-locked

Confirmed against the ledger, not just this codebase. Transaction submission
has a dedicated phase-1 rejection for it — `3129/CollateralLockedByScript` in
the submission-failure set (Ogmios local-tx-submission reference, alongside
`3128/InsufficientCollateral` and `3131/TooManyCollateralInputs`). The three
in-repo assertions (`batch-interaction.ts:110-119`,
`batch-helpers.ts:403-415`, `batch-registry.ts:119-128`) are guardrails in
front of a ledger rule, not a local policy choice. The wallet can never supply
its own collateral under any design.

### The shape

**Direct funding.** The wallet is an input to `batch-payments` and to the
registry mint/update paths, so funds move from the wallet into escrow without
ever resting on the hot key.

**Collateral comes from the agent key, and is not consumed.** Collateral inputs
are only collected when phase-2 validation fails; on the happy path they are
untouched and remain spendable. So the agent's float is a **static reserve, not
a per-transaction cost** — it is provisioned once and only drains when a script
actually fails. The service already detects those cases through Blockfrost's
`valid_contract` flag (`wallet-timeouts/service.ts:804-884`).

**The fee comes out of the wallet.** This needs no new rule: a fee paid from
wallet funds already shows up in `input − continuing output` and is charged to
the lovelace budget. The agent key's balance is therefore whole in the happy
path, which is the stated requirement — its UTxOs are lent as collateral, not
spent. The builder has to be arranged so the wallet input covers the outputs
and the fee, leaving the key's UTxOs serving only as collateral.

**Float requirement**: at least one UTxO of 5 ADA or more to satisfy
`hasGoodCollateral`, and at least two UTxOs total for the readiness gate
(`ensure-collateral-ready.ts:29, 151-163`); 7 ADA total to run a prep
transaction at all (`PREP_TX_MIN_LOVELACE`). Replenishment is needed only after
a phase-2 failure.

### The cost of direct funding, stated plainly

- **`batch-payments` gains a collateral requirement and the readiness gate it
  has never had.** Today the lock path is the one that always works — no
  script inputs, no collateral, no `ensureCollateralReady` call. After this it
  can defer exactly like the escrow-spending paths, so a degraded key float
  stops payments where previously it only stopped collections.
- **The quorum must co-sign every payment batch**, after the body is final and
  before any rebuild — the cost already accepted in
  [How the external quorum signs](03-how-the-external-quorum-signs.md), now
  applying to the highest-volume transaction in the system.
- **Transaction size grows** on a path already checked against
  `MAX_SAFE_TX_BYTES = 14_000`, by the wallet script, its redeemer, and the
  quorum witnesses.
- **`deriveTotalCollateral` must account for the wallet's redeemer.** It
  currently sums only escrow and registry budgets; an unaccounted wallet spend
  redeemer raises the ledger's phase-1 requirement above what is declared and
  yields `InsufficientCollateral`.

### One risk reduced

The research flagged that `getSpendableWalletUtxos` falls back to the
unfiltered list, and `buildWithCollateralFallback` deliberately retries with
the collateral offered to coin selection — both spending the reserve when it is
scarcest. Paying the fee from the wallet rather than the key reduces the
pressure that triggers them: the key's UTxOs are no longer competing as fee
inputs, so coin selection has less reason to reach for the reserve.

What happens when the float is dry is fail-closed and defer, matching the
existing behaviour. Alerting and automated replenishment are service
integration, and out of scope for this map.
