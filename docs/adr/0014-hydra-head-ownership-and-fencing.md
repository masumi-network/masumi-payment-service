# 14. Head ownership: lease-shaped sessions and a durable fencing epoch

Date: 2026-08-11

## Status

Accepted. Phase 1 (the fencing seam) is implemented; Phase 2 (leases) is
deliberately deferred until multi-instance deployment is actually planned.

## Context

Hydra itself is multi-process by design: every participant runs their own
hydra-node, and one node's WebSocket API accepts any number of clients. What
the API does **not** do is arbitrate between them — it is unauthenticated
beyond the Host proxy's bearer token, broadcasts every server output to every
connected client, and accepts commands from any of them. Officially: an open
head can be closed through the API by anyone who can reach it. So Hydra
constrains but cannot enforce ownership; if two payment-service instances
ever attach to the same head, nothing on the node's side stops both from
issuing `Close`, or from writing contradictory lifecycle state to our
database.

Today the service is single-instance, and the connection manager's
process-local state (transport generation, quarantine, command revocation)
is enough. We want to be able to run more than one instance later without
rediscovering, in production, the standard failure modes of distributed
ownership. Those failure modes are well documented:

- **No singleton mechanism gives exactly-one ownership.** Akka's cluster
  singleton prevents duplicates "by all reasonable means"; a partition plus a
  splitting downing strategy yields one singleton per partition. Orleans'
  single-activation guarantee is only eventual. This is a property of the
  problem, not of any framework.
- **Leases alone cannot give mutual exclusion.** A holder paused past its TTL
  (GC pause, event-loop stall) resumes still believing it owns the resource
  (Kleppmann's canonical argument; Chubby's sequencers exist for the same
  reason). Node.js event-loop stalls make this concrete for us.
- **The fix is a fencing token checked by the resource**, not by the holder:
  a monotonically increasing number issued per acquisition, carried on every
  write, with the write path rejecting anything older than the highest seen.
- **Fencing is still not mutual exclusion.** A stale write that arrives
  before any fresh write is accepted (model-checked counterexamples exist).
  Effects must additionally be idempotent or monotonic — which our
  status-guarded compare-and-set writes already are.
- **Bare Postgres session advisory locks are not an ownership mechanism**: a
  dropped connection silently releases them and they carry no fence.
  (Transaction-scoped advisory locks for short critical sections, as in the
  x402 settle path, remain fine.)
- **Sockets never migrate.** In every actor framework, failover stops the old
  actor and starts a fresh one that re-establishes its connections and
  re-derives state. Our re-verification-on-connect design (ADR-0012) already
  assumes exactly this.

Since the hydra-node cannot be the fence-checking resource, the only
chokepoint we control on every durable effect is Postgres.

## Decision

1. **The Head Session is the ownership unit** (see `CONTEXT.md`): one
   per-head slot owning queues, reconnect policy and fences, with a current
   attachment (socket + provider + epoch) that comes and goes. Its lifecycle
   is already lease-shaped — acquire before create, tear down atomically —
   so a Phase 2 lease slots into `connect`/`disconnect` without interface
   change.

2. **`HydraHead.ownerEpoch` is the fencing token.** Acquiring an attachment
   increments it once (`UPDATE ... SET "ownerEpoch" = "ownerEpoch" + 1`);
   the returned value is carried by every lifecycle write the session makes:
   the status compare-and-set, the regressive-rollback path (under its row
   lock), the fail-closed disable, and the closeTxHash capture.

3. **A fenced-out session self-demotes.** On an epoch mismatch it tears its
   transport down locally and touches nothing durable — in particular it must
   NOT durably disable the head, because the head now belongs to a newer
   session and disabling it would be the stale instance vandalising the fresh
   one. It then re-reads durable enablement through the per-head control
   queue: single-instance, a stale epoch means this same process already
   re-acquired the head (a connect raced a disconnect), so reconciling
   self-heals the race. Under Phase 2 the lease gate inside connect decides
   whether that re-attachment is actually permitted.

4. **Commands stay serialized behind the fenced DB gate.** No source we found
   answers whether duplicated head commands (two owners both sending
   `NewTx`/`Close`/`Fanout`) are safely absorbed by the head protocol, so we
   do not rely on it: command issuance remains behind the session's queues
   and admission checks, which the fence governs.

Single-instance today, the fence always wins and nothing changes
behaviourally; the epoch-mismatch branches are dormant safety.

## Phase 2 (not now)

When multi-instance becomes real: a lease table (owner instance id,
heartbeat, expiry) decides who may hold an attachment; lease loss terminates
the session; the first fenced-write rejection is treated as lease loss. Two
cautions recorded for then:

- **Resync must stay snapshot-first at scale.** Per-client full history
  replay was one of the two causes of hydra-node's unbounded memory growth
  under hydra-doom load. Our replay-based verification (ADR-0012) is fine at
  today's reconnect rate; a failover-happy fleet re-replaying history on
  every lease movement would stress the node. Revisit against ADR-25's
  resource-path subscriptions if they ship.
- **Do not shorten the dual-owner window with aggressive TTLs**; tune the
  lease around Node.js pause behaviour and rely on the fence plus idempotent
  writes for correctness, not on timing.

## Consequences

- The lifecycle write path is multi-instance-safe now, and the write-path
  audit (which writes carry the epoch) is one file, `head-status-persistence`.
- Anything that mutates head lifecycle state outside that module must either
  go through it or consciously document why it is unfenced. The datum-sync
  and reconciliation paths are currently governed by the durable admission
  gates (`isEnabled`, `initTxHash`) rather than the epoch; widening the fence
  to them is a Phase 2 decision (granularity question left open by the
  research on purpose).
- A second instance started against today's build will not corrupt lifecycle
  state, but it will also not coordinate: both instances will fight over the
  epoch and repeatedly self-demote. That is the designed failure mode until
  Phase 2 — safe, loud, and useless, in that order.
