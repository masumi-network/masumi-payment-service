---
id: '07'
title: Where refunds and change return
type: grilling
status: closed
assignee: sandro
blocked_by: ['11']
---

# Where refunds and change return

## Question

A purchase locks funds into escrow with a buyer return address in the datum. If
that address is the smart wallet's, the refund eventually lands at a script
address — and on Cardano it lands with whatever datum the payer chose, quite
possibly none. In the prototype, a datum-less UTxO at the wallet address is
movable only by the cold owner key, which strands automated refunds behind a
manual step.

So where does returning value go?

- **Back to the wallet**, which then needs a rule for absorbing arrivals it did
  not author — including the question of whether an agent may spend a
  datum-less UTxO, and what budget that spend counts against.
- **To the agent's own key**, keeping the wallet write-only from the escrow's
  point of view, at the cost of returned funds sitting outside the mandate.
- **To a third address** under separate control, with a sweep back in.

The same question covers transaction change and any collateral return.

## What a resolution looks like

The return-address policy for each purchase-side operation, and the wallet's
rule for value arriving from outside — stated so that no refund path requires
the cold key.

## Update from the transaction inventory

"Back to the wallet" is not on the table for escrow refunds. The datum's
`buyer_return_address` must be a pubkey address — the encoder throws otherwise
(`contract-generator.ts:132-139`) — and the payout output is matched
byte-for-byte against it, stake part included, with an `OutputReference` tag as
its datum (`vested_pay.ak:773-803`, `batch-interaction.ts:725-728`).

So escrow refunds land on a key address by construction, and the real question
becomes the **sweep**: who moves them back into the wallet, how promptly, and
how much value is allowed to sit outside the mandate in the meantime. Change and
splitter outputs are a separate case — they are emitted with no datum on every
transaction (`batch-interaction.ts:538, 554, 750, 763`), so a wallet that
insists on inline datums would collect dead change continuously.

## What is left after the treasury decision

[Treasury behind a key buyer, or a script buyer in escrow](11-treasury-behind-a-key-buyer-or-a-script-buyer.md)
settled the refund half: returning value follows existing infrastructure — the
agent wallet's own address or the configured collection address — and
withdrawal is explicitly not covered by the smart wallet. Change goes to the
agent key too, since the agent is the transaction initiator and the wallet's
continuation is an explicit output rather than change.

So the residue is narrower, and it is about **value arriving at the wallet**
rather than leaving it:

- The wallet is refilled deliberately by the operator, not by recycled refunds.
  What does a funding deposit have to look like — who authors the datum, and
  what happens when someone deposits with the wrong one?
- Does the wallet tolerate a UTxO it did not author, or does it require every
  arrival to be swept and re-deposited before it is spendable?
- Is the prototype's `OwnerSpend` rescue for datum-less UTxOs enough, given the
  owner key is cold and a stuck deposit would wait on it?

## Resolution

**Refunds** were settled by
[Treasury behind a key buyer, or a script buyer in escrow](11-treasury-behind-a-key-buyer-or-a-script-buyer.md):
they follow existing infrastructure to the agent wallet or the collection
address, and withdrawal is outside the wallet's mandate.

**Deposits must not require a datum.** Anyone should be able to send funds to
the wallet address plainly, with no knowledge of the wallet's internal state.
Datum-less UTxOs at the address are therefore the normal case, not an error to
be rescued.

**A one-shot state token identifies the wallet**, minted once and forwarded by
every agent spend. **`OwnerSpend` skips the token check**, so a wallet whose
token was lost, never minted, or misconfigured is always recoverable with the
cold key.

**The ceiling is per UTxO unless something enforces uniqueness.** Each UTxO
carries its own counter, so two funded UTxOs mean two ceilings. Combined with
"deposits need no datum", this is what forces the structural question handed to
[Split state from treasury, or keep one stateful UTxO](13-split-state-from-treasury.md).
The state-token decision above is conditional on the wallet keeping on-chain
state at all — one of the options in that ticket removes the need for both.

### Two mechanics, answered

**Can a mint-once-per-contract be implemented?** Yes, and it is a standard
pattern. Parameterize the minting policy by a specific `OutputReference` that
the owner controls. The policy requires that exact UTxO to be among the
transaction's inputs and that exactly one token of the expected name is minted.
A UTxO can be spent only once, so the policy can succeed only once — uniqueness
comes from the ledger, not from any counter or registry. There is in-house
precedent: `registry-v2/validators/mint.ak` derives asset names from
`blake2b_224(tx_id ++ index)` of a spent input, the same uniqueness trick.
Burning should be permitted under the owner's signature so a wallet can be
retired.

**Can the token be referenced instead of spent, to save cost?** Partly, and the
dividing line is mutability. Reference inputs (CIP-31) let a transaction read a
UTxO without consuming it — no redeemer, no script execution to unlock it, no
continuing output to rebuild, and no serialization of access. But they are
strictly read-only:

- **Immutable configuration** — the agent list, the limits, the period length —
  can live in a referenced UTxO. Cheap to read, and one configuration UTxO
  could serve a fleet of wallets.
- **Mutable counters** — `spent_in_period`, `period_start` — cannot. Anything
  that must change has to live in a UTxO the transaction spends.

So referencing saves real cost, but only for the immutable half. Whether that
split is worth two interlocking contracts is exactly what the next ticket
weighs. Note also that a reference input's authenticity has to be proven
on-chain: the validator must check the referenced UTxO carries the state token,
otherwise anyone could point it at a configuration of their own making.
