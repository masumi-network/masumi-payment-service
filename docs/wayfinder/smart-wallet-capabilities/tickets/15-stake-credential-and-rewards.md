---
id: '15'
title: Stake credential and rewards
type: grilling
status: closed
assignee: sandro
blocked_by: []
---

# Stake credential and rewards

## Question

Does the wallet address carry a stake credential, and if so, whose?

This is now sharp because the design pins the continuing output to the **same
full address**, stake part included — the rule that stops a spend silently
re-delegating the treasury. The consequence is that a wallet's delegation is
fixed at creation and can never change without standing up a new wallet.

The candidates:

- **Enterprise address, no stake part.** Simplest, and it matches the pin Epora
  applies to its state token so that every instance shares one address shape. A
  treasury that may hold meaningful balances earns no staking rewards at all.
- **Key stake credential, operator-held.** Rewards accrue and can be delegated
  and withdrawn by the stake key alone, without the spending validator being
  involved. Costs another key in the model, and gives its holder control over
  delegation independent of the owner, quorum and agent.
- **Script stake credential.** Delegation and withdrawal come under the
  validator's own rules. Requires additional handlers, and the Epora research
  flagged an upstream Aiken bug where adding script purposes to a validator can
  make `aiken check` fail silently on the pinned v1.1.23.

Then the follow-on: **where do withdrawn rewards go?** They arrive as
transaction value rather than in the wallet UTxO, so folding them into the
treasury would be a `Deposit`. Rewards are lovelace, which is a budgeted asset,
so nothing structural blocks it.

## What a resolution looks like

The stake credential's kind and holder, an explicit acceptance that delegation
is immutable per wallet, and the path rewards take back into the treasury — or
a statement that rewards are deliberately forgone.

## Correction to the question

The premise above was wrong. The full-address pin fixes **which stake
credential the address uses**, not where that credential delegates. Delegation
is changed by a certificate signed by the stake credential itself — the address
is untouched and the wallet UTxO is never spent. Re-delegating is free at any
time; only swapping the credential requires a new wallet.

## Resolution

**A base address: script payment credential plus a stake key held by the
owner.** Not a separate operator role — the same cold custody that holds the
owner key. Everything about staking is owner-only.

- **Delegation** is the owner's alone, changeable at any time by certificate,
  with no effect on the address, the token or the balance.
- **Rewards** are withdrawn by the owner, to the owner. They do not
  automatically re-enter the treasury; if they should fund payments, that is a
  deliberate `Deposit`.
- **The validator gains nothing.** Reward withdrawal needs only the stake key,
  so the script never runs for a staking operation. No `withdraw` handler, no
  `publish` handler — which also keeps the script at three purposes, well clear
  of the upstream Aiken bug where added purposes make `aiken check` fail
  silently on the pinned v1.1.23.
- **The stake credential can never move principal.** It governs delegation and
  the reward account only. Its blast radius is a redelegation and a reward
  balance, never the treasury.

### Consequences

- All wallets may share the owner's stake credential, so one reward account and
  one delegation choice covers a fleet while payment credentials stay unique per
  wallet.
- That shared stake part links the wallets on-chain — they resolve to one
  reward account. For an operator's own infrastructure that linkage is not a
  concern; distinct stake keys per wallet would break it at the cost of managing
  more keys and more reward accounts.
- The treasury earns rewards while idle, which matters for a float that sits
  across epoch snapshots between batches.
