---
id: '03'
title: How the external quorum signs
type: grilling
status: closed
assignee: sandro
blocked_by: []
---

# How the external quorum signs

## Question

By what mechanism does the external co-signer quorum authorize an agent spend,
and what exactly does a co-signer put its name to?

The two candidates:

- **Transaction witnesses.** Co-signers appear in `extra_signatories`. The
  validator checks a threshold of them. Simple on-chain, but the unsigned
  transaction has to travel to each co-signing service and back before
  submission, and any rebuild invalidates the collected signatures.
- **Detached CIP-8 signatures in the redeemer.** Co-signers sign a canonical
  payload off-chain; the validator reconstructs the signature structure and
  verifies each one. The payment V2 contract already does this for
  `WithdrawDisputed` — see `smart-contracts/payment-v2/validators/vested_pay.ak`
  and its `AdminSignature` type. Co-signers never see the transaction, but the
  payload must bind tightly enough that a signature cannot be replayed.

If detached signatures win, the payload is the real decision: which of the
wallet UTxO reference, the recipients, the amount, a nonce and an expiry are
covered, and how a co-signer knows what it is approving without the
transaction in hand.

## What a resolution looks like

The mechanism, the exact signed payload, and the replay-protection argument —
stated well enough that someone can write the verification rule from it.

## Resolution

**Transaction witnesses.** Co-signers sign the transaction body; the validator
counts how many of the configured quorum keys appear in `extra_signatories` and
requires the threshold to be met. No CIP-8 machinery, no payload design, and no
replay question at all — a signature over a transaction body is usable for
exactly that transaction.

**Per-spend approval.** Every agent spend needs live quorum consent. The
exception is the owner path: recovery, sweep and policy updates run on the cold
key alone and never require quorum.

**A daily ceiling stays in the contract.** Alongside the quorum, the wallet
keeps a spend ceiling per period, carried in the datum of the wallet UTxO so it
travels with the wallet's state, and changeable by the cold owner. The quorum
governs *whether* a spend happens; the ceiling bounds *how much* can happen
between owner interventions, and the recipient allow-list bounds *where* it can
go. Three independent controls, not one.

### What this settles for the validator

- The quorum check is `count(quorum keys ∩ extra_signatories) >= threshold` —
  a few list operations, no ed25519 verification, negligible execution cost.
  The `AdminSignature` / `cip8_sig_structure` apparatus from `vested_pay.ak` is
  not needed here.
- Mutable accounting stays in the datum, because the ceiling needs it. The
  continuing output must therefore still reproduce the input datum exactly with
  only the addressed agent's counters advanced — the prototype's most expensive
  rule survives, and it survives for a reason the operator asked for.
- Nothing needs a nonce, a counter, or an expiry field for replay purposes.

### Costs accepted, stated plainly

- **The body must be final before signing.** A Cardano witness signs the body
  hash, so fee, inputs, outputs, collateral and script-data-hash are all frozen
  at signing time. Any rebuild after collection — `shrinkBatchToFit`, the
  collateral fallback retry (`batch-interaction.ts:200-216`), a re-evaluated
  exUnits budget — invalidates every signature already gathered. The build
  pipeline has to reach a final body *first*, then collect, then submit.
- **The wallet lock is held across collection.** The wallet stays locked from
  claim to submit (`HotWallet.pendingTransactionId`), so co-signer latency eats
  directly into the 5-minute `WALLET_LOCK_TIMEOUT_INTERVAL` and the 7-minute
  transaction timeout. A slow co-signer wedges the wallet rather than merely
  delaying a batch.
- **Availability is now a hard dependency.** With per-spend approval and no
  session grant, the co-signing service being down stops the wallet completely.
  That is the intended control, but it means quorum reachability is a
  production dependency of every payment batch.
- **Co-signers must interpret raw transaction bodies** to know what they are
  approving, or trust the requesting service's description of it. A co-signer
  that signs whatever it is handed adds no security over the hot key alone.
- **Extra witnesses cost bytes** on transactions already checked against
  `MAX_SAFE_TX_BYTES = 14_000` (`batch-helpers.ts:425`), and the builders will
  need the co-signer key hashes declared as required signers so fee estimation
  accounts for them.

One consolation: co-signers need keys but no funds. They never provide inputs,
collateral or fees, so onboarding a co-signing service does not mean funding a
Cardano wallet for it.
