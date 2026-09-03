---
id: '05'
title: Anti-double-satisfaction with escrow inputs
type: grilling
status: closed
assignee: sandro
blocked_by: ['11']
---

# Anti-double-satisfaction with escrow inputs

## Question

The prototype forbids any second script input on an agent spend. That is a
blunt defence against double satisfaction — two script inputs pointing at one
recipient output and both counting it. Purchase-side transactions break it
outright: they spend escrow UTxOs, sometimes several in one batch.

So what replaces the rule?

Candidates worth weighing:

- **Output tagging.** Require the outputs that count toward this wallet's
  accounting to carry a datum naming the wallet's own `OutputReference`. The V2
  builders already tag outputs this way for the escrow contract, so the pattern
  and its costs are known here.
- **Exact continuation accounting.** Constrain the continuing output's value
  precisely rather than counting recipient outputs at all, so no output has to
  be attributed.
- **A marker token.** Identify the wallet's own outputs by a token only this
  wallet can hold.

Each has a cost in transaction size, builder complexity, and how much the
off-chain code must know.

## What a resolution looks like

The chosen mechanism, plus the argument for why value cannot be counted twice
when a wallet input and N escrow inputs share a transaction.

## Update from the transaction inventory

The conflict is narrower than it looked. `batch-payments` — the only operation
that spends wallet principal into escrow — has **zero** script inputs today
(`batch-payments/service.ts:267`). The three operations that do carry 1..N
escrow script inputs spend no wallet principal at all, only fees.

So if **Treasury behind a key buyer, or a script buyer in escrow** keeps the
wallet out of the escrow-spending transactions, the lock transaction is the
only one with a wallet input — exactly one script input — and the prototype's
rule survives as written. This ticket may resolve to "keep the rule, and never
put the wallet in an escrow-spending transaction".

## Resolution

Determined by
[Treasury behind a key buyer, or a script buyer in escrow](11-treasury-behind-a-key-buyer-or-a-script-buyer.md),
which put the wallet only in `batch-payments` and the registry mint/update
paths and kept it out of every escrow-spending transaction.

**Amended during implementation (operator correction): the rule is
"exactly one input of OUR script", not "no other script input".** The wallet
must be spendable alongside foreign contracts — locking into the payment escrow
is the primary case — so foreign script inputs are permitted; what can never
happen is two wallet shards settling in one transaction. The original, stricter
phrasing below is retained as history.

**Keep the prototype's rule: no second script input on an agent spend.** In
every transaction the wallet appears in, its own input is the only script
spend — the lock transaction has none today, and registry transactions carry a
mint script but no script spend. Nothing has to be attributed across inputs, so
no output tagging, marker token, or per-output accounting is needed.

The rule now carries a second job beyond double-satisfaction: it is the
mechanism that keeps the wallet out of escrow-spending transactions. Anyone
later tempted to have the wallet pay escrow-side fees will hit this rule rather
than silently widening the design — which also protects the batch builders'
exUnits-to-redeemer index mapping (`batch-interaction.ts:149-174`) and the
14 KB size ceiling.

No decision was needed on the mechanism, so nothing here constrains the
validator beyond what the prototype already does.
