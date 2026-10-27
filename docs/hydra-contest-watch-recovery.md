# Respond to a Hydra contest watch alert

VERIFIED: `HYDRA_HEAD_CONTEST_WATCH_ALERT` has three reasons. `HEAD_CLOSED`
comes from an independent L1 state-token lookup. `NODE_UNOBSERVABLE` means the
local node could not provide a Head state that the watch can compare with L1
for more than one tenth of the contestation period, bounded to one through five
minutes. The node may be down, or it may answer with a state that disagrees
with L1, for example Open after L1 shows a Close. `L1_OBSERVER_UNAVAILABLE`
means the separate chain lookup
failed for that long while the node remained observable.

A node that this service cannot observe at all is alerted as
`HYDRA_HEAD_UNOBSERVED` (see [Hydra operations](hydra-operations.md)).
Subscribe to both events: during such an outage, `NODE_UNOBSERVABLE` is held
back while the unobserved gap is checked and started no later than it, and is
dropped once the unobserved alert went out. A node that then comes back in a
state that L1 contradicts starts a new `NODE_UNOBSERVABLE` clock.
`NODE_UNOBSERVABLE` still comes when the unobserved gap starts over first, for
example after a restart of this service that lasts more than three minutes, or
when the node is down on some checks and answers in a state that L1 contradicts
on others.

The unobserved alert waits five minutes, or a quarter of the contestation
period when that is shorter. For a contestation period between 4 and 50
minutes, that is later than the bound above. On such a head, a down node is
alerted later than `NODE_UNOBSERVABLE` alone would alert it, and a node that is
down for less than the unobserved wait is not alerted at all. Two instances of
this service that start the two clocks on the same check can send both alerts.

1. On `HEAD_CLOSED`, check the Head's current L1 state and contestation
   deadline. Keep the local node running so it can post a Contest. Confirm on
   L1 that a Contest with the latest signed snapshot lands before the deadline.
   The first Close alert does not prove a Contest is missing. The separate
   `HYDRA_HEAD_CONTEST_MISSING` event reports that gap after its grace period.
2. On `NODE_UNOBSERVABLE`, check the Host, the node process, its persistent
   volume, and the service's runtime token. Restore the existing node with its
   original keys and volume. Do not create a new Head identity. Repeat the L1
   check after the node reconnects. A restarted node may need time to replay
   its history before it can compare snapshots. If the node runs and answers,
   compare its Head state with L1: a node that lags the chain, or an L1
   rollback, makes the two disagree.
3. If node persistence is lost, use the stored `initChainSlot` and
   `initChainHash` as the pre-Init replay point for `--start-chain-from`.
   REPORTED: [the preprod recovery drill](hydra-persistence-recovery-verification.md)
   rebuilt the last on-chain increment with this method. INFERRED: L2 activity
   after that increment still needs a cooperative peer or a separate recovery
   transaction path. Do not claim the old balance is restored from chain replay
   alone.
4. On `L1_OBSERVER_UNAVAILABLE`, restore the payment source's Blockfrost key
   and chain access. The local node can still contest while it is healthy, but
   the service has lost its separate view of a Close. Run the admin Head chain
   check after access returns.

INFERRED from `src/services/hydra-contest-watch/watch.ts`: the watch records
alert claims and webhook delivery entries in the same database transaction.
A failed enqueue should leave the alert unclaimed for a later tick. Monitor
the webhook receiver and the Head's chain state until the contestation period
ends.
