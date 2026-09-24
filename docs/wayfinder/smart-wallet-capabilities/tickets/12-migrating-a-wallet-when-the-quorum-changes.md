---
id: '12'
title: Migrating a wallet when the quorum changes
type: grilling
status: closed
assignee: sandro
blocked_by: []
---

# Migrating a wallet when the quorum changes

## Question

With the quorum fixed in the script parameters, every co-signer change — adding
one, removing one, replacing a lost key, adjusting the threshold — produces a
new script hash and therefore a new wallet address. Migration stops being an
incident and becomes a routine operation.

What does that procedure look like, and does the contract need to help?

- Who executes it, and how many cold-key interactions does one rotation cost?
- What happens to funds mid-flight — a batch already locked into escrow whose
  refund will return to the agent key, or a wallet UTxO in a transaction that
  is still unconfirmed?
- Does the service need to hold two wallet addresses live during a cutover, and
  for how long?
- Does the wallet need **on-chain support** for this — a successor-address hint
  in the datum, a migration action distinct from `OwnerSpend`, or a marker that
  a wallet is retired — or is a plain sweep-and-refund entirely sufficient?

That last point is the part that belongs to this map. The rest is procedure,
and only in scope where it forces something into the validator.

## Why it exists

Graduated from the fog once
[Quorum signer set, threshold and rotation](04-quorum-signer-set-threshold-and-rotation.md)
put the quorum in immutable parameters. Under a datum-stored quorum this would
have been a rare event; under parameters it is the standard response to a lost
or rotated co-signer key.

## What a resolution looks like

A verdict on whether the validator gains anything for migration, and if not, an
explicit statement that sweep-and-refund under the cold key is the whole
mechanism.

## Resolution

**There is no migration, and no successor. There are three ordinary
operations**, and the validator gains nothing for any of them:

1. **Top up an existing wallet** — the `Deposit` action, signed by the agent or
   the owner, no cold key required. Same wallet, same state token, same
   address; only the balance changes.
2. **Stand up a new wallet** when a static parameter changes, and move the funds
   across. The old wallet is retired; the new one is created exactly as any
   wallet is created.
3. **Mint an additional wallet** alongside the existing ones, for capacity
   rather than replacement.

Nothing links the old wallet to the new one. Case 2 is not a distinct
mechanism — it is case 3 followed by a sweep, and creating a wallet is the same
operation either way.

**Sweep, burn, remint is the whole of case 2**, and it fits in one transaction.

`OwnerSpend` stays unconstrained — the cold key spends the wallet UTxO with no
continuing-output requirement, which is also what keeps it the rescue path for
malformed and datum-less UTxOs. The same transaction burns the old state token
through the mint handler's burn branch, which requires the owner's signature,
and mints the new wallet's token from a fresh seed, paying the swept funds to
the new address. Two scripts run, three redeemers, one transaction.

**No dedicated `Retire` action.** The cold key already has unrestricted spend
authority, so a fourth redeemer variant would only be restating what
`OwnerSpend` permits.

**No successor pointer in the datum.** A successor field would let an indexer
follow V1 → V2 on-chain rather than trusting off-chain records — but
burn-and-sweep consumes the wallet UTxO entirely and leaves no continuing
output to carry one. Writing it would mean deliberately creating a marker UTxO,
which is machinery for a moment that happens once per wallet, and the service
already tracks the address in its own wallet record.

### Accepted risk

A migration that sweeps but forgets to burn leaves a live state token. Whoever
holds it can send it back to the old address and recreate a spendable wallet
UTxO there — under the old quorum, which is exactly the quorum a co-signer
rotation was migrating away from.

The mitigation is that the token lands in the owner's own custody during the
sweep, so realizing the hazard needs both a fumbled runbook *and* loss of that
custody. If the cold key is compromised the wallet is lost regardless. Accepted,
with the burn recorded as a required runbook step rather than an on-chain
guard — consistent with the no-on-chain-guard stance taken for the quorum
configuration.

### What triggers a migration

Every script parameter: adding, removing or replacing a co-signer, changing the
threshold, rotating the owner key, or upgrading the validator. All cost the
same, because all are baked into the address. Only the **agent** is cheap to
rotate, because it lives in the datum.

### What migration does not disturb

Nothing is stranded in escrow. Refunds were routed to the agent key rather than
the wallet by
[Treasury behind a key buyer, or a script buyer in escrow](11-treasury-behind-a-key-buyer-or-a-script-buyer.md),
so payments already locked settle to the agent key regardless of which wallet
funded them, and a migration mid-flight loses nothing.

The only in-flight concern is an unconfirmed wallet spend at sweep time, which
the service's one-in-flight-transaction-per-wallet rule and the wallet lock
already prevent.
