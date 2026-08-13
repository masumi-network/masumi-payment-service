---
id: '09'
title: Control surface — does a budget still earn its place
type: grilling
status: closed
assignee: sandro
blocked_by: ['04']
---

# Control surface — does a budget still earn its place

## Question

The prototype defends with three controls at once: a per-period lovelace
budget, a recipient allow-list, and an expiry. The quorum requirement arrived
afterwards and is strictly stronger than all of them — nothing moves without M
external approvals.

So which controls does v1 actually keep, and what does each one defend against
that the others do not?

- The **budget** costs the most: it is the only reason the datum carries mutable
  accounting, which is the reason every spend must reproduce a continuing output
  exactly, which is the source of most of the validator's complexity. If the
  quorum is trustworthy, the budget defends only against a quorum that
  rubber-stamps.
- The **allow-list** is cheap and defends against a compromised agent plus a
  compromised quorum agreeing to pay an attacker.
- The **expiry** is nearly free and bounds the damage from a forgotten
  delegation.

Also worth asking: does dropping the budget make the wallet stateless enough to
relax the serialization constraint entirely?

## What a resolution looks like

The v1 control set, each control justified by a threat the others miss, and an
explicit note of what was dropped and why.

## Partly answered already

[How the external quorum signs](03-how-the-external-quorum-signs.md) settled
the headline: **the ceiling stays.** The operator asked for a daily ceiling
enforced by the contract, carried per wallet UTxO in the datum and changeable
by the cold owner. So the budget is not dropped, mutable accounting stays, and
the continuing-output equality rule stays with it.

What is left for this ticket is narrower:

- The **allow-list** — kept, dropped, or folded into the quorum's judgement?
  With per-spend approval a co-signer could refuse a bad destination, but that
  makes the control a matter of co-signer diligence rather than a rule.
- The **expiry** — still worth its field now that no spend happens without live
  quorum consent?
- The **period shape** — "daily" as a fixed 24-hour window, or the prototype's
  rolling `period_length` with roll-over? The prototype's anti-back-dating rule
  exists only because roll-over does; a fixed calendar day would need a
  different argument.
- Whether the ceiling is **per agent** or **per wallet**, given the datum
  already carries a list of agents.

## Resolution

**Both signatures are always required.** An agent spend needs the hot key *and*
the quorum threshold — they are conjunctive, never alternatives. The quorum
cannot move funds on its own, and neither can the hot key. This is what makes
the rest of the answers safe.

**The recipient allow-list is dropped**, along with the `RecipientPolicy` type,
the per-output recipient scan, and the `paid_to_allowed + fee >= outflow`
accounting. Destination control now rests with the quorum's judgement rather
than an on-chain rule.

**The expiry is dropped.** Its only remaining scenario was a compromised or
negligent quorum draining the ceiling indefinitely — and since the quorum
cannot act without the hot key, that scenario requires both to be compromised
at once, with the compromise going unnoticed past the expiry date. Not worth a
recurring cold-key ceremony and a field that can silently stop payments.

**The ceiling is per wallet, shared by a list of authorized agent keys.** The
operator's point was that per-agent and per-wallet are near-equivalent in
practice: either the same address is reused, or more wallets are generated —
the difference being on-chain lookup and indexing cost. Given the equivalence,
the simpler datum wins. A second hot key can still share one address by joining
the list; a second *budget* means a second wallet via `wallet_id`.

**The period stays the rolling window as built** — `period_start` plus
`period_length`, resetting when elapsed, with the anti-back-dating rule
requiring the validity range to fit inside the new window. "Daily" is
`period_length = 86_400_000`. Already implemented and covered by tests.

### What the datum becomes

```aiken
pub type Datum {
  agents: List<VerificationKeyHash>,
  limit: Value,
  period_length: Int,
  period_start: POSIXTime,
  spent_in_period: Value,
  min_balance_lovelace: Int,
}
```

A list of key hashes, not a list of policy records. `AgentSpend` loses its
`agent_index` — the validator checks that *some* listed agent signed. The
continuing-output check no longer performs per-entry surgery with `indexed_map`
against an attacker-supplied index; it compares against a datum with only
`period_start` and `spent_in_period` advanced, which was the single most
intricate rule in the prototype.

### The ceiling is denominated in assets, not lovelace

**Amended after the first resolution.** The ceiling is not lovelace-only. A
wallet holds lovelace *and* stablecoins — USDM, USDC — and the budget has to
cover them, so both `limit` and `spent_in_period` are asset values rather than
integers.

Using stdlib `Value` for both is the idiomatic choice and, more importantly,
gives a canonical ordering for free — which matters because the continuing
output is checked by datum equality, and a hand-rolled list of asset records
would need its own ordering rule to make that comparison sound.

The spend rule generalizes per asset:

- `outflow = input value − continuing output value`, computed with
  `assets.merge` and `assets.negate`.
- Every asset's outflow must be **non-negative**, mirroring the existing
  lovelace rule — an agent must not be able to shrink a counter by depositing.
- Every asset with a positive outflow must have a **limit entry**, and
  `spent_in_period + outflow <= limit` must hold for it.
- Assets with no limit entry are therefore **frozen** — they cannot leave under
  an agent spend at all. This is the working assumption that preserves the
  prototype's NFT protection while letting stablecoins move, and it is exactly
  what [Native assets and registry mint/burn](06-native-assets-and-registry-mint-burn.md)
  must confirm along with the mint/burn case.
- `min_balance_lovelace` stays lovelace-only. It exists so the wallet UTxO
  remains viable above the min-UTxO floor, which is a lovelace property; a
  stablecoin reserve would be a different control with a different purpose.

### Superseded by the structural decision

[Split state from treasury, or keep one stateful UTxO](13-split-state-from-treasury.md)
revised two details of the sketch above. The agent list became **singular** —
one agent per wallet, a second agent means a second wallet — and the asset
amounts use `Pairs` rather than stdlib `Value`, because a datum-supplied
`Value` carries no ordering guarantee. See that ticket for the authoritative
datum.

Honest cost: this re-inflates part of what dropping the allow-list and the
per-agent records deflated. Per-asset arithmetic and a `Value`-shaped datum are
more expensive than two scalars. The result is still simpler than the prototype
— no per-agent policy records, no allow-list, no expiry, no attacker-supplied
index — but "the datum is just scalars" no longer holds.

Quorum tallying excludes **every** key in the datum's `agents` list, not just
whoever signed — hot keys never count as approvers under any arrangement.

### The security consequence, stated plainly

With the allow-list gone, **nothing on-chain constrains where wallet funds go.**
A hot key and a quorum acting together can send up to the daily ceiling
anywhere. The wallet now bounds *how much* leaves and *who must agree*, not
*where it lands*. Every co-signer that approves without independently checking
destinations reduces the wallet to a rate limiter.

One thing this buys back: registry funding pays lovelace to the signing
wallet's own key address, which an allow-list would have had to permit — and
permitting the agent's own address would have gutted the list anyway. Dropping
it removes that contradiction rather than papering over it.
