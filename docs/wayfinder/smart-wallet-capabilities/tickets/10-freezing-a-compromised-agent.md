---
id: '10'
title: Freezing a compromised agent
type: grilling
status: closed
assignee: sandro
blocked_by: ['04']
---

# Freezing a compromised agent

## Question

The owner key is cold by design, which is exactly what makes it slow. When the
hot key is known to be compromised at 02:00, who can stop the wallet spending
before someone reaches the cold key?

- Can a single quorum member **refuse**, and is refusal enough? With an M-of-N
  threshold, N − M + 1 refusals already halt spending — so the real question may
  be whether the quorum is reachable and disciplined enough for that to count as
  a control.
- Is a **warm freeze role** worth its complexity — a key that can only ever
  stop spending, never move value?
- Does a freeze need to be **on-chain** at all, or does it live in the
  co-signing service, with the chain as backstop?
- Once frozen, what un-freezes it, and does that need the cold key?

## What a resolution looks like

The revocation story end to end, with the time from detection to funds-safe
stated honestly, and any new role justified against simply refusing to
co-sign.

## Narrowed by the quorum decisions

Two constraints now fix most of the answer:

- **Refusal is already a freeze.** Every agent spend needs live quorum
  witnesses, so co-signers stopping is sufficient to halt the wallet
  immediately, with no transaction and no cold-key access. The question is no
  longer whether a freeze mechanism is needed but whether the *chain* needs to
  know about it.
- **Removing a co-signer is a migration, not a config change**
  ([Quorum signer set, threshold and rotation](04-quorum-signer-set-threshold-and-rotation.md)),
  so the on-chain response to a compromised co-signer is slow by construction.
  A compromised *agent* is different — agents live in the datum and the cold
  key can revoke one with `UpdatePolicy`, no address change.

So the residue is: is an on-chain freeze worth anything the co-signers refusing
does not already provide, and what is the honest detection-to-safe time when
the remedy is a cold-key `UpdatePolicy`?

## Resolution

**No on-chain freeze.** No freeze action, no freeze flag in the datum, no
freezer role.

The freeze is **quorum refusal**: co-signers stop signing and nothing moves.
Instant, no transaction, no chain interaction, no cold key. It covers the case
that actually happens — the hot key compromised while the quorum is honest.

The revocation is a **cold-key `UpdatePolicy`**. The agent is a datum field, so
a new agent key can be installed without changing the address, the token or the
balance, and the wallet resumes operating. A compromised **co-signer** is the
expensive case instead, because the quorum is a script parameter — that is a
new wallet, per
[Migrating a wallet when the quorum changes](12-migrating-a-wallet-when-the-quorum-changes.md).

### Honest timings

| | Elapsed |
| --- | --- |
| Detection → spending halted | seconds, a flag in the co-signing service |
| Detection → provably safe on-chain | time to reach the cold key, likely hours |

The gap between those two only matters when the quorum is itself compromised or
malfunctioning, since an honest quorum simply stops. And in that case the loss
is already bounded by the daily ceiling: roughly `(elapsed / 24h) × ceiling`,
not the balance.

### Why no freezer role

A dedicated freezer key, or letting any single co-signer set a flag, would close
that gap. It would also add a key to the operational model, a datum field, an
action, and — the real objection — a **liveness attack surface**: whoever holds
that power can halt every payment until the cold key intervenes. Paying a
permanent denial-of-service risk to reduce a bounded, fractional-day loss is a
bad trade at this threat level.

### One thing the compromise does not widen

A compromised agent can still sign `Deposit`, since that action accepts the
agent or the owner. This is harmless by construction: `Deposit` cannot remove
value. An attacker holding the hot key can put money **into** the wallet and
nothing else.
