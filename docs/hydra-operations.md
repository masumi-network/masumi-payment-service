# Running Hydra in production

This is the operator's guide: what a Hydra head actually gives you, how to
stand one up with a counterparty, and the failure modes that are worth knowing
before you meet them. For how the pieces fit together internally, see
[hydra-architecture.md](hydra-architecture.md).

## What a head is, and what it is not

A **head** is a payment channel between exactly two wallets. Inside it,
payments settle in under a second and cost no fees. Everything else about
Cardano still applies: the same escrow contract, the same states, the same
signatures.

Three things follow from that, and every operational surprise below is a
consequence of one of them:

1. **A head is per counterparty.** It is opened between your wallet and one
   other wallet, and it carries payments between those two only. An agent
   whose seller wallet is not the head's counterparty settles on L1, and the
   payment succeeds — it is simply slower and costs a fee.
2. **Money must be inside the head to be spent there.** Funds are put in when
   the head opens, and added later through a deposit. Neither is instant.
3. **Opening and closing are L1 transactions.** They take minutes and cost
   fees. A head is worth opening when you expect a stream of payments with the
   same counterparty, not for a single one.

If you take one thing from this page: **Hydra is a speed optimisation with a
setup cost, and L1 is always the fallback.** Nothing is stuck on L2 that
cannot come back.

## What you need

|                                      |                                                                                                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A Hydra Host**                     | Supervises one `hydra-node` process per head. Ships as a container; see [hydra-host-native-mode.md](hydra-host-native-mode.md) for macOS and arm64 Linux, where it runs as a plain Node process instead. |
| **A public address**                 | Your counterparty's node connects to yours directly. A hostname or IP that resolves from outside, and one open TCP port per head.                                                                        |
| **A Blockfrost project**             | The node follows the chain through it. Same network as your payment source.                                                                                                                              |
| **ADA in a purchasing wallet**       | For the funds you put in the head, plus about 10 ADA per head for its node to pay the on-chain fees.                                                                                                     |
| **A counterparty who also runs one** | Both sides need a node. There is no one-sided head.                                                                                                                                                      |

Both nodes must run the **same `hydra-node` version** (2.3.0 at the time of
writing) and the **same ledger protocol parameters**. Mismatched versions
produce script hashes that do not agree, and the head never opens. The node
details dialog shows both, which is the first thing to compare when a head will
not open.

## Setting up

### 1. Start the Host

The image is built from `packages/hydra-host/Dockerfile` and is not published to
a registry. **In production, run that image under whatever you already use** —
Kubernetes, Nomad, systemd, your own `docker run`. The compose file next to it
is for local testing and as a worked example of the settings that matter; it is
a single unmanaged container with a local volume, which is not what you want
holding a mainnet head.

```bash
# Local testing.
cd packages/hydra-host
HYDRA_HOST_PUBLIC_HOST=hydra.example.com \
HYDRA_HOST_NETWORK=preprod \
HYDRA_HOST_ADMIN_TOKEN="$(openssl rand -hex 32)" \
HYDRA_HOST_USER_TOKEN="$(openssl rand -hex 32)" \
BLOCKFROST_PROJECT_FILE=/srv/secrets/blockfrost.txt \
docker compose up -d --build
```

Four settings carry over to any deployment, and three of them are the kind that
only hurt later:

- **A durable volume at `/data`.** It holds a SQLite event store and etcd's raft
  WAL, both of which need real fsync — block storage, not a network filesystem.
  Losing it loses the heads.
- **A shutdown grace period of about two minutes** (`--stop-timeout 120`, or
  `terminationGracePeriodSeconds: 120`). The supervisor drains a snapshot round
  before stopping, and etcd's raft WAL does not tolerate being cut off
  mid-round. The default 10 seconds will eventually corrupt it.
- **One instance per Host identity.** The peer ports, the advertise address and
  the volume all belong to a specific Host. Do not scale it horizontally.
- **The Blockfrost file, mounted read-only.**

Compose also shows a healthcheck worth copying: an unauthenticated request to
an authenticated route, expecting `401`. That proves the server is up _and_
that auth is wired, without adding a health route reachable without a token.

Both tokens must be at least 32 characters and must differ — the admin token
manages the fleet, the user token drives a node that already exists, and the
split is the point. Never give either to a counterparty: a user token can close
a head. `HYDRA_HOST_PUBLIC_HOST` is a bare hostname or IP with no scheme, port
or path; the Host refuses to start otherwise, because that value becomes each
node's advertise identity and must not change for a head's lifetime.

The ports are the security boundary. Four ranges exist and only three may leave
the machine:

| Port        | Plane                                        | Exposed?                                                                                |
| ----------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `8443`      | Control. Your payment service talks to this. | Yes, bearer-token gated                                                                 |
| `8444`      | Exchange. Where invites are redeemed.        | Yes, to whoever you invite                                                              |
| `5001-5032` | Peer. One per head.                          | Yes — and see below                                                                     |
| `4001-4032` | `hydra-node` API                             | **Never.** Unauthenticated, can close a head.                                           |
| `6001-6032` | Prometheus                                   | **Never.** No bind-host option exists, so `HYDRA_HOST_MONITORING_ENABLED` defaults off. |

The API range is additionally bound to `127.0.0.1` inside the container, so it
stays shut even if someone switches to host networking.

**The peer plane cannot authenticate its callers.** Fetch the per-head
allow-list from `GET /v1/peer-allowlist` — it renders an nftables ruleset — and
re-apply it whenever a head is added or removed. Skipping this leaves your peer
ports open to the internet.

`BLOCKFROST_PROJECT_FILE` is a **path to a file** containing the project id,
not the id itself: it is handed to `hydra-node` as `--blockfrost` and the node
opens it. Mount it read-only. A Host with no such file starts fine and then
every node it spawns dies, which reads as a node problem rather than a missing
secret.

`HYDRA_HOST_PEER_PORT_COUNT` (32) caps how many heads one Host runs.

### 2. Connect the Host to your payment service

Admin UI → **Hydra Heads** → **Connect node**. You need the Host's base URL and
its admin token. The user token is optional; supply it if you want the service
restricted to node operation.

The node's hostname lives under **Advanced** and is usually inferred correctly.
Override it when the Host sits behind a NAT or a load balancer and cannot see
the address the outside world reaches it on.

### 3. Open a head with your counterparty

A head is opened through an **invite**, which is a signed offer naming both
wallets and all four durations. Neither side can change the terms afterwards.

**You invite them:**

1. **New head → Invite someone.**
2. Pick the wallet you will settle with. This is the important choice: it fixes
   both sides. Pick a purchasing wallet and they must redeem with a selling
   one, and the other way round — a head carries payments in one direction.
3. Check the timings if you have a reason to; the defaults are per network and
   are right for almost every head.
4. Send them the code. It is a bearer token: whoever redeems it opens the head
   with you.

**They invite you:** paste the code under **New head → Redeem an invite**, pick
your wallet, and confirm the terms. **The side that redeems is the side that
opens the head** — there is nothing to click afterwards.

The head appears as _awaiting counterparty_, then _Initializing_, then _Open_.
Reaching Open takes a few minutes: it is two on-chain transactions and both
nodes have to see each other.

### 4. Put money in

Opening commits the funds. Later, add more with **Add funds** on the head.

A deposit is not instant, and the delay is not a queue — it is protocol:

```
deposit confirms on L1
        │
        │  ← deposit period (10 min preprod, 20 min mainnet)
        ▼
head may absorb it        ─┐
                           │ ← the window it may be absorbed in
head stops being able to  ─┘
        │
        ▼
recover it back to the wallet
```

So money added to a head is **confirmed on chain but unspendable for the
deposit period**, and if the head never takes it, it is recovered rather than
lost. The deposit row shows _Submitted_ in yellow the whole time; it never goes
green, because nothing available proves the head absorbed that particular
deposit.

### 5. Take money out

**Take funds out** on the head moves funds back to L1 without closing it. A head
meant to stay open for months would otherwise only accumulate.

It runs the opposite way round to a deposit, and the difference matters:

```
you ask for an amount
        │
        │  ← split inside the head (free, ~1s) if the amount is partial
        ▼
both nodes sign it away      ← the point of no return
        │
        │  ← your node posts the payout
        ▼
funds spendable on L1
```

Once both nodes have signed, the value is out of the head whether or not L1 has
it yet. There is no recovery step on this side — a deposit the head refuses
stays at a script and comes back, but a withdrawal the head approves is gone
from the head for good. The panel says _Paying out_ from that moment.

Two things follow from how Hydra works here:

- **Your counterparty has to be reachable.** Removing funds needs a snapshot
  both parties sign. A counterparty whose node is down cannot be withdrawn
  around; closing the head is the only way out in that case.
- **5 ADA stays behind.** Spending an escrow inside the head requires collateral,
  and collateral has to be a plain UTxO the wallet already holds. Take the last
  one and the wallet can no longer submit results, collect or refund in this
  head — while the balance still reads as healthy, because the escrows are
  untouched. Withdrawing everything is offered separately, for winding a head
  down.

## The four durations

Set once per head, in the invite, and fixed for its life.

|                         | Preprod  | Mainnet  | What it does                                                                                                                                                                                                   |
| ----------------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dispute window**      | 12 hours | 5 days   | After a head closes, how long either side may challenge the final balances. Nothing settles until it passes, so it is also how long after closing before you have your funds back. Long is the safe direction. |
| **Out-of-sync limit**   | 6 hours  | 2.5 days | How long a node may fall behind before it refuses to keep transacting. Capped at half the dispute window: a node returning later than that has too little time left to defend the head.                        |
| **Deposit settle time** | 10 min   | 20 min   | The deposit period above.                                                                                                                                                                                      |
| **Invite lifetime**     | 7 days   | 7 days   | How long the node and peer port stay reserved for an unredeemed invite.                                                                                                                                        |

The dispute window is the one to think about. It protects you from a
counterparty closing on a stale state while your node is down — but you cannot
withdraw during it. Five days on mainnet assumes you will notice an unexpected
close within five days.

## Day to day

**Payments route themselves.** A purchase between two wallets with an open head
goes through it; anything else goes to L1. There is no per-payment switch, and
a head that is not usable is never an error — it is a slower payment.

**Watch the node balance.** Each head's node holds about 10 ADA of its own to
pay for opening, depositing and closing. It is topped up automatically from the
assigned wallet. A node that cannot pay cannot close its head, which is the one
failure that costs you the dispute window.

**Back up the keys once.** Each head has its own signing keys, and the service
will show them exactly once before sealing them. Without them you cannot
recover funds from a head whose service database is gone. The head details
dialog warns until you do it.

**Closing.** Close from the head's action menu. The funds return to L1 after
the dispute window, then fan out. Nothing needs watching in between.

**Closing is not how you get funds out.** It costs you the dispute window — five
days on mainnet — and ends the head. Use **Take funds out** for anything you
want back while the head keeps working, and close only when you are done with
the counterparty.

## Problems you are likely to meet

### The head will not reach Open

Check, in this order:

1. **Both nodes reachable.** The Connection panel reports your node, your
   service's session to it, and whether the counterparty's node is in the
   cluster. All three must be green on both sides.
2. **Same `hydra-node` version and ledger parameters.** Under _Version and
   hashes_ in the node details. A mismatch cannot open a head, and it does not
   say so directly — it just never opens.
3. **The peer port is actually reachable from outside.** This is the common
   one. `nc -vz your.host 5001` from somewhere else, not from the same machine.

Connectivity in Hydra's network layer is cluster-wide, not per peer: a node
reports itself connected or not, not "connected to X". Both sides being _Ready_
is the signal, not one side.

### Nodes exit immediately with SIGILL

```
[supervisor] starting <id> (peer 5001, api 4001)
[supervisor] <id> exited (code=null signal=SIGILL)
```

The Host is fine — this is `hydra-node` itself refusing to run. Upstream
publishes only `x86_64-linux` and `aarch64-darwin` builds, so on arm64 hardware
the container runs the amd64 binary under emulation and it dies the moment it
touches its crypto path. The supervisor restarts it with backoff and node health
reports `usable: false` with a climbing `restartCount`, which is the correct
report of a node that cannot run.

An early sign, before you start anything: `GET /v1/capabilities` returns a
`hydraVersion` but a null `scriptCatalogue` with
`probeError: --hydra-script-catalogue: Command failed`. The version call
survives emulation; the catalogue call does not.

Run the Host on amd64 Linux, or run it natively. On Apple silicon native mode
works today and there are step-by-step instructions in
[hydra-host-native-mode.md](hydra-host-native-mode.md#running-it). On arm64
Linux there is no `hydra-node` build at all, so native mode does not help
either; that page says what building one would involve.

### A payment settled on L1 with the head open

Almost always one of:

- **The seller wallet is not the head's counterparty.** A head is between two
  specific wallets. The head details dialog names both — compare them against
  the agent's seller wallet.
- **The head's wallet was busy.** A head lock needs the one wallet that
  participates in it, and that wallet builds one transaction at a time. Two
  purchases seconds apart contend for it; the second waits, and after two
  minutes falls back to L1 rather than waiting indefinitely.
- **A deposit was mid-fold.** See below.

None of these lose money. They cost a fee and some seconds.

### Payments stopped moving entirely

A payment source has a limited number of purchasing wallets, and Hydra needs a
specific one. If that wallet is held by a transaction that can never complete,
everything behind it queues.

Look at the head's **Transactions**: a lock that is Pending with no hash and
does not change is the signature. Reconciliation releases these on its own once
the head has explicitly refused the transaction and its validity window has
closed — but a request whose `payByTime` passes while it waits will fail, with
the reason recorded on it.

If you see this and it does not clear within an hour, the reservation is
holding for a reason worth reading: check the head's error list.

### A deposit that will not become spendable

Between the head agreeing to absorb a deposit and actually absorbing it, that
deposit is visible in the head's balance and cannot be spent. It is a window of
a few minutes, and every deposit has one — not just a head's first.

The service leaves those funds out of coin selection during the window, so the
rest of the head keeps working. If the arriving deposit is the _only_ money in
the head, there is nothing to work with and payments wait for the fold to
finish. That is expected; it resolves itself.

### "Transaction is invalid" on a head

The head's own reason is included after the colon. `All inputs are spent`
usually means the fold-in race above rather than a malformed transaction.

## Running both sides yourself

Nothing above requires a counterparty organisation — you can run two Hosts and
two payment services and invite yourself, which is how the end-to-end suite
works. Both nodes still need distinct peer ports and to reach each other by the
addresses they advertise, and using `localhost` for both will not do that.

```bash
pnpm exec tsx scripts/hydra-e2e/run.mts
```

See [scripts/hydra-e2e/README.md](../scripts/hydra-e2e/README.md) for what each
phase asserts and the opt-in phase that opens a real head on preprod.

## Related

- [hydra-architecture.md](hydra-architecture.md) — how the pieces fit together
- [hydra-host-native-mode.md](hydra-host-native-mode.md) — running without a container
- [hydra-l2-reservation-recovery.md](hydra-l2-reservation-recovery.md) — why L2 reservations are held
- [adr/0011-head-invites-on-a-host-exchange-plane.md](adr/0011-head-invites-on-a-host-exchange-plane.md) — why invites work the way they do
