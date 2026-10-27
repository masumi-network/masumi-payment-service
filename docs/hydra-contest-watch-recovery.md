# Respond to a Hydra contest watch alert

VERIFIED: `HYDRA_HEAD_CONTEST_WATCH_ALERT` has three reasons. `HEAD_CLOSED`
comes from an independent L1 state-token lookup. `NODE_UNOBSERVABLE` means the
local node could not provide a usable Head state for more than one tenth of the
contestation period, bounded to one through five minutes. `L1_OBSERVER_UNAVAILABLE`
means the separate chain lookup
failed for that long while the node remained observable.

VERIFIED from `src/services/monitoring/scheduler/jobs.ts` and
`src/utils/async-interval/index.ts`: each watch run starts 60 seconds after the
previous run ends. A run with slow nodes or a slow chain lookup takes longer, so
an alert can arrive more than one run after that bound. A run that finds no
problem clears the clock.

1. On `HEAD_CLOSED`, check the Head's current L1 state and contestation
   deadline. Keep the local node running so it can post a Contest. Confirm on
   L1 that a Contest with the latest signed snapshot lands before the deadline.
   The first Close alert does not prove a Contest is missing. The separate
   `HYDRA_HEAD_CONTEST_MISSING` event reports that gap after its grace period.
2. On `NODE_UNOBSERVABLE`, check the Host, the node process, its persistent
   volume, and the service's runtime token. Restore the existing node with its
   original keys and volume. Do not create a new Head identity. Repeat the L1
   check after the node reconnects. A restarted node may need time to replay
   its history before it can compare snapshots.
   A paused Host stops its nodes, so every Open Head on it raises this alert
   once the pause outlasts the bound above.
   Resume the Host before the contestation deadline.
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
