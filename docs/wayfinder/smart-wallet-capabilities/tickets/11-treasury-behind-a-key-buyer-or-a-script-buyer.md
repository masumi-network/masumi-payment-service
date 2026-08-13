---
id: '11'
title: Treasury behind a key buyer, or a script buyer in escrow
type: grilling
status: closed
assignee: sandro
blocked_by: []
---

# Treasury behind a key buyer, or a script buyer in escrow

## Question

The transaction inventory found that the deployed V2 escrow **cannot accept a
script address as buyer** — every buyer-side redeemer does
`expect Some(buyer_vk) = address_to_verification_key(buyer)` and a script
credential returns `None`, bricking the UTxO
(`vested_pay.ak:392, 413, 495, 1213-1216`). The off-chain encoder refuses to
build the datum too (`contract-generator.ts:132-139`). So the smart wallet
cannot be the buyer. What is it instead?

**A. Treasury behind a key buyer.** The wallet is a script input that *funds*
the lock transaction, while the escrow datum still names the agent's plain key
as buyer and return address. The escrow never learns the money came from a
script. Refunds land on the agent key and are swept back into the wallet on a
separate transaction.

- Keeps V2 escrow untouched and every deployed UTxO valid.
- The wallet's allow-list has to permit paying the escrow script address, and
  has to tolerate refunds arriving on a key it does not control the spending of.
- Between lock and sweep, refunded funds sit outside the mandate — a window the
  threat model has to accept.

**B. Escrow that accepts script participants.** A new escrow version whose
buyer may be a script, authorized by something other than `extra_signatories`.

- New contract, new address, migration for live locked funds, and a break with
  every deployed V2 UTxO and indexer assumption.
- Almost certainly a separate effort, not a ticket on this map.

**C. Wallet-funded purchases bypass escrow.** Only viable if some purchase path
does not need escrow at all; the inventory does not suggest one exists.

Under A there is a follow-on worth settling in the same sitting: the three
escrow-spending operations — collect refund, request refund, authorize
withdrawal — spend **no wallet principal**, only fees and collateral. If the
wallet stays out of those transactions entirely, the prototype's
single-script-input rule survives untouched and only the lock transaction ever
carries a wallet input.

## Why this blocks so much

Whether the wallet is a funding source or a participant decides what the
allow-list points at, where refunds go, whether registry NFTs can live in the
wallet, and how much of the escrow-side complexity the wallet ever meets.

## What a resolution looks like

The wallet's role stated in one sentence, the accepted exposure window for
funds sitting outside the mandate, and an explicit list of which transaction
types will carry a wallet script input.

## Resolution

**Option A — funding source only.** The wallet is a script input that pays for
transactions; the escrow datum keeps naming a plain key as buyer and return
address. V2 escrow is untouched and every deployed UTxO stays valid. A
script-accepting escrow is not pursued.

**Returning value follows existing infrastructure.** Refunds go where they go
today — the agent wallet's own address, or the configured collection address
(`buyerReturnAddress ?? collectionAddress`,
`collect-refund/service.ts:153-157`). **Withdrawal and collection are not
covered by the smart wallet.** Once value leaves the wallet it is outside the
mandate, and no on-chain sweep obligation is designed for it. The wallet is a
one-way spending gate, not a custody boundary around the whole payment cycle.

**Only the funding transactions carry a wallet script input.** Collect-refund,
request-refund and authorize-withdrawal spend no wallet principal, so the
wallet stays out of them entirely and their fees come from the agent key's own
float. The transactions that will carry a wallet input are `batch-payments`
and the registry mint/update paths.

### Consequences

- The wallet input is the **only** script spend in any transaction it appears
  in — the lock transaction has zero script inputs today, and registry
  transactions have a mint script but no script spend. The prototype's
  no-second-script-input rule therefore holds as written, which closes
  [Anti-double-satisfaction with escrow inputs](05-anti-double-satisfaction-with-escrow-inputs.md).
- `batch-payments` gains its first collateral requirement, because it gains its
  first script input. That lands on
  [Collateral for a script-held treasury](08-collateral-for-a-script-held-treasury.md).
- The agent key needs a permanent key-locked float for fees and collateral that
  the mandate does not cover, and it is also where refunds accumulate.
- The wallet is refilled deliberately, not by recycled refunds. What that means
  for value arriving at the wallet address is the residue of
  [Where refunds and change return](07-where-refunds-and-change-return.md).
- The exposure accepted: funds are protected while parked in the wallet and
  while locked in escrow, and unprotected from the moment they return. The
  wallet bounds what the hot key can *commit*, not what it can *keep*.
