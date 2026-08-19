# 12. Hydra snapshot verification, and what an upgrade must check

Date: 2026-08-06

## Status

Accepted.

## Context

The payment service does not take its Hydra node's word for the state of a
head. It verifies every signed snapshot the node reports: an Ed25519 signature
per party against the on-chain party keys, a recomputed KZG accumulator, and a
check that each signed state is reachable from the one before it
(`doesHydraTransactionTransitionReachSnapshot`).

That last check is the subject of this ADR, because it is the one that can take
a head down.

### Why verify at all

The node is a separate process. It binds loopback and is reached through the
Host, which authenticates both HTTP and the WebSocket upgrade, so this is not
compensating for an exposed port. What it addresses is a compromised or buggy
node lying to *this service* about in-head state.

The bound is narrow and worth stating plainly, because it is easy to overclaim:

- A compromised node holds the Hydra snapshot-signing key and the node's own
  small Cardano key. It does **not** hold the settling wallet — in-head
  transactions are signed by the payment service from an encrypted mnemonic —
  so it cannot construct a state that moves the head's funds. That needs an L2
  transaction it cannot sign, plus the counterparty's signature on the result.
- It can still close at a stale snapshot, refuse to sign, and lie to us.
  Verification addresses only the last of those.
- The lie that matters is "this payment settled". Acting on it means telling a
  seller they have been paid when they have not. That is a business loss, not
  chain-level theft, and it is what these checks prevent.

### Why the transition check is the fragile part

Hydra 2.3 signs the TxOut multiset — `utxo` together with `utxoToCommit` and
`utxoToDecommit` — but **not** transaction ids and **not** the `confirmed`
list. The service needs both to attribute in-head escrows, so it opts into
trusting them (`trustLocalNodeSnapshotMetadata`). The transition check is the
compensating control: it ties that untrusted list back to the signed state.

Its failure mode is severe and was, until recently, silent. A rejected history
means no verified session, therefore no head clock, therefore every L2 escrow
operation fails closed — while the connection retries forever and the head goes
on reporting itself Open.

Two legitimate protocol behaviours were missed that way:

1. **A decommit carries its own L1 fee.** The withdrawal transaction is reported
   in `DecommitRequested` and in the `utxoToDecommit` partition, never in
   `confirmed`, so a walk that reads only `confirmed` sees a 5,000,000 output
   replaced by a 4,829,879 one with nothing accounting for the difference. Found
   only after it took a head offline for hours.
2. **A deposit can be recovered instead of absorbed.** It sits in a signed
   snapshot's `utxoToCommit`; if the increment never lands the depositor takes
   it back on L1 with a `recoverTx`, so the next snapshot drops it having never
   reached `utxo`. Found by enumeration, before it hit anyone — but latent
   behind a recovery flow this service already ships.

Both were signed by every party. Both were the check being wrong, not the head.

## Decision

Keep the verification, and make an unmodelled shape a reviewable event rather
than a discovery made in production.

1. **Enumerate the shapes.** A snapshot carries exactly three pieces of state
   plus its transaction list, so the combinations are finite and are enumerated
   in `transition-shapes.spec.ts` — including the cases that must still be
   refused. Every fix here widens what is accepted; without the negatives the
   check could be widened until it asserts nothing.
2. **Test against recorded output, not hand-written shapes.**
   `recorded-history.spec.ts` replays a real preprod head captured verbatim.
   Both bugs above were consistent with what we believed Hydra emits, which is
   exactly what a hand-written fixture cannot catch.
3. **Detect drift and report it.** `protocol-drift.ts` compares each frame's
   fields against what we model and warns without refusing, so an upgrade is
   noticed while the head still works. Refusing would turn a harmless added
   field into the outage this exists to prevent.
4. **Surface a rejection.** `HistoryReplayFailed` records a head error naming
   the transition (`snapshot 2 to 3, 0 transaction(s), 1 pending decommit
   output(s)`), so this can never again present as a silent reconnect loop.

## Upgrading hydra-node: the checklist

Do this **before** rolling a new node version to anything that holds funds.

1. Run a head through the new version on preprod, exercising every path:
   open, an L2 escrow lock, an incremental commit, a **deposit recovery**, a
   **withdrawal**, close, and fanout.
2. Replay that node's log through the production verifier:

   ```
   pnpm exec tsx scripts/hydra-e2e/replay-check.mts <path-to>/node.log
   ```

   Every transition must report `ok`. A `FAILS` line names the exact snapshot
   pair, which is the thing that previously cost hours to locate by hand.
3. Regenerate both fixtures under `src/lib/hydra/hydra/__fixtures__/` from that
   log and run `pnpm test -- lib/hydra`.
   - `protocol-drift.spec.ts` fails if the snapshot carries a field we do not
     model. That failure is the prompt: decide whether the transition check
     accounts for it, add a case to `transition-shapes.spec.ts` either way, and
     only then add the field to `MODELLED_SNAPSHOT_FIELDS`.
   - `recorded-history.spec.ts` fails if a real transition stopped verifying.
4. Check the release notes for changes to `utxoToCommit` / `utxoToDecommit`
   semantics, to what `confirmed` contains, and to which messages carry a
   transaction body. Those three are what this check depends on.

## Consequences

- An added protocol field is a warning and a failing test at review time, not
  an offline head.
- The suite must be regenerated on upgrade. That is deliberate friction: it is
  the step that would have caught both bugs.
- Coverage follows what a head has actually done. Fanout and contestation have
  no recorded fixture yet, and multi-party heads are untested here — a mismatch
  there would still fail, though now visibly and with the transition named.
- The `confirmed` list remains the weak point by construction. It is not signed,
  and this check is the only thing binding it. If that ever proves too fragile,
  the alternative is to stop trusting node-supplied transaction metadata and
  drive escrow state from the signed output set alone — a larger change, and the
  one worth reaching for rather than relaxing the conservation rules.
