---
label: wayfinder:map
title: Smart wallet capability spec
---

# Smart wallet capability spec

## Destination

A locked v1 capability spec for the Masumi smart wallet validator: the on-chain
rules under which the payment service's **purchase-side hot key**, co-authorized
by an **external M-of-N signer quorum**, may spend operator funds held under a
**cold owner key** — covering escrow locking, registry mint/burn, intra-transaction
batching, and collateral.

Reached when every rule is decided and nothing is left to settle before someone
sits down to write the validator. The prototype at
[`smart-contracts/smart-wallet`](../../../smart-contracts/smart-wallet) is
evidence that the shape works, not a constraint on the answer.

## Notes

**Domain.** Cardano eUTxO, Aiken pinned at v1.1.23 / Plutus V3, against the V2
payment source (`packages/payment-source-v2`). Money is lovelace and BigInt,
never Number.

**Consult per session.** `cardano-dev-skills` — `explain-eutxo`,
`write-validator`, `review-contract`, `optimize-validator`. `grill-with-docs`
for the conversation itself. `CONTEXT.md` for the project glossary,
`docs/adr/0005-meshsdk-version-pinning-v1-v2.md` before anything touches Mesh.

**Plan, don't do.** Tickets end in decisions. No validator code is written on
this map; the spec is the deliverable and implementation is a separate effort.

**Standing constraints** — already settled with the operator, not open tickets:

- **Purchase side first.** Locking funds into escrow, plus registry mint/burn.
  Selling-side operations are out of scope for this destination.
- **Serialized wallet spends.** One wallet UTxO is consumed per transaction and
  its continuing output becomes the next spendable one. Intra-transaction
  batching — many purchases in one transaction — must survive.
- **Cold owner, hot agent.** The owner key is operator-held and offline. The
  delegated agent key is the payment service's hot key, today an encrypted
  mnemonic in the database.
- **Quorum on the agent path.** Every agent spend additionally requires an
  external M-of-N co-signature, supplied by another service.
- **The prototype is open to redesign.** If the operator threat model wants a
  different core model, the map may replace it.

## Decisions so far

<!-- one line per closed ticket: gist plus link, detail stays in the ticket -->

- [Purchase-side transaction shape inventory](tickets/01-purchase-side-transaction-shape-inventory.md)
  — the V2 escrow cannot take a script buyer at all, so the wallet can only
  ever be a funding source behind a key-address buyer; only `batch-payments`
  and registry mint/update spend wallet principal, and collateral must stay
  key-locked outside the wallet.
- [Wallet UTxO serialization and chaining](tickets/02-wallet-utxo-serialization-and-chaining.md)
  — the service already allows exactly one in-flight transaction per wallet
  (`pendingTransactionId @unique`) and never chains, so a single stateful wallet
  UTxO costs nothing; the two-UTxO collateral floor applies to the key wallet,
  not the script wallet.
- [Treasury behind a key buyer, or a script buyer in escrow](tickets/11-treasury-behind-a-key-buyer-or-a-script-buyer.md)
  — the wallet is a funding source only, never an escrow participant; returning
  value follows existing infrastructure and withdrawal is out of the wallet's
  mandate; only `batch-payments` and registry mint/update carry a wallet input.
- [Anti-double-satisfaction with escrow inputs](tickets/05-anti-double-satisfaction-with-escrow-inputs.md)
  — determined by the treasury decision: keep the no-second-script-input rule
  as written, since the wallet's input is always the only script spend.
- [How the external quorum signs](tickets/03-how-the-external-quorum-signs.md)
  — plain transaction witnesses counted against a threshold, required on every
  agent spend and never on the owner path; a datum-carried daily ceiling the
  cold owner can change stays alongside the quorum.
- [Quorum signer set, threshold and rotation](tickets/04-quorum-signer-set-threshold-and-rotation.md)
  — signer set and threshold are immutable script parameters, weighted by
  repetition, with the agent's own key never counting toward the tally and no
  on-chain guard on the configuration; rotating a co-signer means a new address.
- [Control surface — does a budget still earn its place](tickets/09-control-surface-does-a-budget-still-earn-its-place.md)
  — hot key and quorum are always both required; the allow-list and the expiry
  are dropped; one rolling-window ceiling per wallet, shared by a list of agent
  keys and denominated in **assets** rather than lovelace, so stablecoins are
  budgeted and unlisted assets stay frozen.
- [Native assets and registry mint/burn](tickets/06-native-assets-and-registry-mint-burn.md)
  — unlisted assets are frozen in both directions as a consequence of the
  ceiling rule rather than a special case, and the wallet funds registry mints
  without ever holding an NFT, so the validator needs no mint awareness at all.
- [Collateral for a script-held treasury](tickets/08-collateral-for-a-script-held-treasury.md)
  — script collateral is a ledger-level rejection (`3129/CollateralLockedByScript`),
  so the agent key lends a static reserve that is untouched unless phase-2
  fails, the wallet pays the fee, and `batch-payments` inherits the collateral
  readiness gate it has never had.
- [Where refunds and change return](tickets/07-where-refunds-and-change-return.md)
  — deposits must need no datum, so datum-less UTxOs at the address are normal;
  a one-shot state token identifies the wallet and `OwnerSpend` skips checking
  it so recovery always works; the ceiling is per UTxO unless uniqueness is
  enforced, which forces the structural question below.
- [Epora wallet design](tickets/14-epora-wallet-design.md) — the split-state
  shape is real, built and documented (unaudited, preprod); its uniqueness
  trick beats a parameterized one-shot policy, its true cost is aggregate
  value accounting across datum-less treasury UTxOs, and its justification is
  datum-free deposits from unintegrated payers — which this wallet may not need.
- [Split state from treasury, or keep one stateful UTxO](tickets/13-split-state-from-treasury.md)
  — one state token in the value-holding UTxO with the dynamic config in its
  datum, nothing merged or spent alongside it on the agent path and the cold
  key exempt; the wallet validator is its own **derived-name** minting policy —
  owner-gated, seed consumed at mint, one token per wallet, wallets side by
  side at one shared address — with foreign script inputs permitted on spends
  but never a second wallet input; four actions — `AgentSpend`, `Deposit`,
  `UpdatePolicy`, `OwnerSpend` — with top-ups signed by the agent or the owner
  and needing no cold key.
- [Migrating a wallet when the quorum changes](tickets/12-migrating-a-wallet-when-the-quorum-changes.md)
  — there is no migration and no successor, only three ordinary operations:
  top up the existing wallet, stand up a new one when a static parameter
  changes, or mint an additional wallet for capacity; the validator gains
  nothing, and nothing is stranded in escrow because refunds already return to
  the agent key.
- [Freezing a compromised agent](tickets/10-freezing-a-compromised-agent.md)
  — no on-chain freeze: quorum refusal halts spending in seconds with no
  transaction, a cold-key `UpdatePolicy` swaps the agent without changing the
  address, and the gap between them is already bounded by the daily ceiling; a
  freezer role would buy a fractional-day saving at the price of a permanent
  denial-of-service surface.
- [Stake credential and rewards](tickets/15-stake-credential-and-rewards.md)
  — a base address whose stake key is held by the owner and nobody else;
  delegation is free to change at any time without touching the wallet, rewards
  are withdrawn by the owner to the owner, and the validator gains no staking
  handlers because the script never runs for a stake operation.

## Not yet specified

- **Failure and recovery drills.** Lost quorum signers, a continuing output
  stuck mid-batch, a partially applied batch. Shape depends on nearly every
  decision above.
- **Signature collection and the wallet lock.** Witness signing needs a final
  transaction body before collection starts, and the wallet stays locked
  throughout. How the build pipeline reaches a final body, what happens when a
  co-signer is slow, and whether the 5-minute lock timeout still fits. Mostly
  orchestration — in scope here only where it forces something into the
  validator.

## Out of scope

- **Selling-side operations** — submit result, collect, authorize refund.
  Purchase side first; revisiting this redraws the destination.
- **Funding, fund-transfer and defragmentation wallets.** Different key
  lifecycle, different threat model.
- **Payment-service integration** — Prisma model, endpoints, admin UI,
  automation wiring. The destination is a contract spec; integration is a
  separate effort that starts once the spec is locked.
- **Non-Cardano rails** — x402 / EVM — and Hydra L2 paths.
