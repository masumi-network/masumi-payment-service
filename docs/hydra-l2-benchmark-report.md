# Masumi on Hydra L2 — benchmark report

**Date:** 2026-08-31 · **Network:** Cardano **preprod** (real testnet) · **hydra-node:** 2.3.0
**Topology:** 2-party head (purchasing ⇄ selling)

Everything below was measured on the live preprod network, not a local devnet. Raw evidence
(per-run JSON, per-transaction timings, and the node's own event log) is in
`hydra-l2-flow/evidence/`. To reproduce, see [Replication](#replication).

---

## 1. Headline results

### Raw agent-to-agent payments

One agent paying another inside the head — a plain 1-input/1-output ADA transfer, zero fee, no
smart contract. This is what the Catalyst milestone means by "agent-to-agent transactions".

| Persistence | Sustained throughput | Latency per payment (p50) | Run |
|---|---|---|---|
| Mac SSD | **100.0 TPS** | **39 ms** | 2026-08-31, settled on-chain |
| Mac SSD | 96.8 TPS | 38 ms | 2026-08-28 |
| RAM disk | **1,128–1,148 TPS** | **2.7 ms** | 2026-08-28 (diagnostic, see §3) |

Every run: 10,000 transactions, **100 % confirmed, zero invalid**. Throughput and latency come from
two runs on the same head: a saturation run for TPS, a sequential run for per-payment finality.

The 2026-08-31 SSD run is the one to cite: it is the only run whose head was also **closed and
fanned out back to L1**, so its throughput and its settlement are the same head (§4). The RAM-disk
figure was not re-measured that day.

### Milestone targets

The Catalyst targets are **network-level**: 500+ TPS across Masumi, under 500 ms per payment.

**Latency: met, measured.** 39 ms p50 to multi-signed finality on the settled head, 13× inside the
500 ms target. That figure comes from the sequential run, where each payment waits for snapshot
confirmation before the next is sent, so it is per-payment finality.

The saturation run reports a p50 of 4,981 ms (mean 4,992 ms) on the same head. That is **not a second
latency figure for the same operating point.** Throughput and latency trade against each other
through snapshot batch size, and the two runs sit at opposite ends of that curve:

| In flight | Snapshot size | Snapshot rate | Throughput | p50 finality |
|---|---|---|---|---|
| 1 | 1 tx | 24.2 /s | 24.2 TPS | **39 ms** |
| 500 | 100 tx | 1.01 /s | **100.0 TPS** | 4,981 ms |

Batching amortises the signing round. Per-transaction snapshot cost falls from 41.3 ms to 10.0 ms,
which buys 4.1× throughput and costs 128× latency. Both points satisfy Little's Law, so queue depth
rather than the head sets the wait: 500 / 100.0 = 5.0 s predicted against 4,992 ms measured, within
0.1 %.

Pick the operating point from the requirement. A 500 ms budget admits far deeper batching than the
sequential run uses, but **the intermediate windows were not measured**, so the shape of the curve
between these two points is unknown. See [Open items](#6-open-items).

**Throughput: met by horizontal scaling, extrapolated.** One head sustains a measured 100.0 TPS.
Heads share no leader, no mempool and no snapshot round, so throughput adds across them. Five
2-party heads, meaning **10 agents transacting pairwise**, reach 500 TPS. Masumi opens one head per
agent pair, so head count grows with the agent population.

| | Per head | 5 heads / 10 agents |
|---|---|---|
| Sustained TPS | 100.0, measured | 500, extrapolated |
| Per-payment p50 | 39 ms, measured | 39 ms; heads do not interact |

500 TPS is arithmetic on a measured per-head number, **not a measured network number**. Measured:
one head, 10,000 transactions, settled on L1. Assumed: heads on adequate hardware do not contend.
That assumption holds at the protocol layer. It is untested at the host layer, since five heads on
one machine would share the CPU and the fsync path (§3). Tracked in [Open items](#6-open-items).

### Masumi escrow payments (the product)

A real Masumi payment is three transactions against the `vested_pay` V2 contract, driven by the
payment service's own code. 20 of 20 lifecycles completed (2026-08-28, N=20).

On 2026-08-31 the full refund lifecycle — lock → request-refund → authorize-refund → collect-refund —
ran inside the settled head, 4/4 `TxValid`, each step confirming `head id == Masumi DB hash`.

| Step | Rate | What happens on-chain |
|---|---|---|
| Lock | **5.58 /sec** | pays into the escrow script (no validator run) |
| Submit result | **0.84 /sec** | **Plutus validator executes in-head** |
| Collect | gated by cooldown | Plutus validator executes again |

Excluding the contractual cooldown: **0.73 complete payments/sec**.

---

## 2. What the two numbers mean

They answer different questions and should never be quoted interchangeably.

- **744–1,148 TPS is the infrastructure ceiling** — how fast the L2 itself moves value.
- **0.84 /sec is the product rate** — how fast a full escrow payment currently completes.

The gap is **not** a Hydra limitation. It comes from three things, all in code we control:

1. **Plutus execution.** Each escrow step runs the validator against a ~480-byte datum, far heavier
   than a plain transfer.
2. **Cron batching.** The service processes a few escrows per tick because each transaction locks
   the hot wallet. In-head transactions confirm in ~3 ms, so the head is idle most of the time —
   batching more per tick is the obvious optimisation.
3. **Contractual cooldown.** The seller cooldown is written into the datum at submit time and must
   elapse before withdrawal is legal. That is a business rule, not a performance limit.

---

## 3. Why the disk matters

Swapping persistence from the Mac's SSD to a RAM disk took throughput from 96.8 to ~1,140 TPS —
**12×**, nothing else changed. The bottleneck is not Hydra: during the slow runs the busiest process
used only **~25 % of one core**. macOS `F_FULLFSYNC` costs ~15 ms per flush, and Hydra flushes
consensus messages to disk inside the payment path.

**RAM disk is a diagnostic, not a deployment** — ephemeral storage loses head state on reboot, which
this repo's own deployment guide already forbids. The production answer is ordinary **Linux with
NVMe**, where that flush costs ~0.1–1 ms, so it should recover most of the gain while staying
durable. (Expected from fsync costs, not yet measured — see [Open items](#6-open-items).)

---

## 4. Verification and evidence

The numbers were re-measured from scratch on a second, independent head and reproduced:

| Test | First head | Second head | |
|---|---|---|---|
| Sustained TPS (SSD) | 95.6 | **96.8** | reproduces |
| Latency (SSD) | 39.7 ms | **38 ms** | reproduces |
| Sustained TPS (RAM) | 744 | **1,128 / 1,148** | higher — fresh head |
| Latency (RAM) | 3.9 ms | **2.7 ms** | reproduces |

The RAM figure is higher on a fresh head than on one carrying hours of accumulated history.
**Quote 744 TPS as the conservative number**, ~1,140 as the fresh-head figure.

The 2026-08-28 runs are **not shipped in this repository**. `.gitignore` keeps exploratory bench
output local and commits only the settled 2026-08-31 run, so the figures in this table are
reproducible via [Replication](#replication) but not checkable from the tree.

### Independent corroboration

Throughput was cross-checked against **hydra-node's own event store**, which is written by the node
itself and independent of our test harness. Bucketing its transaction-application events by second
during the RAM benchmark windows:

```
2026-08-28T13:52:39Z   1200 tx/s
2026-08-28T13:50:55Z   1200 tx/s
2026-08-28T13:50:58Z   1185 tx/s
2026-08-28T13:52:41Z   1181 tx/s
```

Those timestamps fall exactly inside the two RAM benchmark runs, and the rate matches what the
harness reported. Regenerate with `replicate-benchmark.sh timeline`.

### Head lifecycle, node-recorded

```
2026-08-28T13:33:16Z  HeadOpened
2026-08-28T13:36:19Z  DepositRecorded
2026-08-28T13:41:17Z  DepositActivated
2026-08-28T13:41:18Z  CommitApproved
2026-08-28T13:43:32Z  CommitFinalized
```

### On-chain anchors

The 2026-08-31 run settled end to end on preprod. Head id
`d276058a22ad180bc94bfc89d85d6c02c5e5a110dd5ddcd759f213b1`; view any hash at
`https://preprod.cardanoscan.io/transaction/<hash>`.

| Role | Tx | Block | Time (UTC) |
|---|---|---|---|
| funding/split | `b6bc7f589d2688cdd281290f9d3b4711e055c25c6798907b84a7549cd4972b55` | 5121783 | 13:40:38 |
| **Init** | `29a86185fc14e956c3f2abdc32487c246be13deea28882d5fa147b5064bc4996` | 5121789 | 13:41:58 |
| **Increment** | `4b7b61735af539bf39a6899e6558f42f39b75e887327a412486cd1966d2a2daa` | 5121818 | 13:52:30 |
| **Close** | `171d99ddaa6545fe6795bd81546aa1bd5dfc23186764dfd0b6435823fd9ba2bf` | 5121841 | 14:01:02 |
| **Fanout** | `2108fdf624e313ddbd79ad83669130bf360827b7288909cd4e7b51bca52cfc83` | 5121860 | 14:10:21 |

Close and Fanout both consume assets whose minting policy **is** that head id, so they provably
belong to this head and no other. Fanout burns all three head tokens and pays **200.000000 ADA**
back to L1 — 10 + 45 + 5 ADA to the buyer, 25 ADA to the seller, 115 ADA to the node wallet. That
split is the net result of everything that happened inside the head.

### Why the L2 transactions are not on Cardanoscan

They never touch L1, which is the entire point of a head. Cardano L1 tops out near 10-15 TPS, so
100 TPS cannot exist there, and running the same 10,000 transactions on L1 would cost roughly
1,700 tADA in fees rather than zero. **Their absence from L1 is the result, not a gap in it** —
verified by sampling tx ids from `events.ndjson.gz` against Blockfrost, which returns HTTP 404.

What proves the throughput is the **multi-signed `ConfirmedSnapshot`** captured in
`evidence/2026-08-31-settled/snapshots/`: signed by both hydra-nodes rather than by our harness, and
its balances equal the Fanout outputs above. That equality is the bridge from L2 back to L1.

One caveat on scope. `events.ndjson.gz` retains transaction **ids and timings, not bodies**, so the
10,000 benchmark transactions cannot be re-validated from this tree. The independent check on the
count is hydra-node's own event store, which recorded 10,216 `TransactionAppliedToLocalUTxO` and 316
`SnapshotConfirmed` for this head (`head-timeline.txt`). One transaction body did ship: the tx
carried inside snapshot 316. Its blake2b-256 re-derives the stated tx id, its Ed25519 witness
verifies against that id, its fee is 0, and its output is the 115 ADA UTxO the Fanout paid on L1.

### Evidence layout

| Path | Contents |
|---|---|
| `evidence/2026-08-31-settled/SUMMARY.md` | headline numbers, Cardanoscan table, copy-paste verification |
| `evidence/2026-08-31-settled/l1-anchors.json` | every L1 tx: role, block, slot, `valid_contract`, Cardanoscan URL |
| `evidence/2026-08-31-settled/settlement.json` | closeTx / fanoutTx (reconciled against the chain), lovelace settled |
| `evidence/2026-08-31-settled/snapshots/` | `/snapshot` (multi-signed), `/snapshot/utxo`, `/head` — both nodes, pre-close and post-fanout |
| `evidence/2026-08-31-settled/bench/*/events.ndjson.gz` | every transaction id, with sent / valid / confirmed timings (no tx bodies) |
| `evidence/2026-08-31-settled/head-timeline.{json,txt}` | head history from hydra-node's own event store |

Re-running any stage writes to `evidence/bench/<ts>/`, `evidence/bench-escrow/<ts>/` and
`evidence/timeline/`. Those paths are gitignored, so they exist only on the machine that ran them.

---

## 5. Product path over the REST API

Beyond the benchmarks, the complete product was exercised through its public HTTP API, with the
service's own cron scheduler performing every on-chain action:

`POST /registry` → agent minted on L1 → `POST /payment` → `POST /purchase` → **funds locked in the
head** (`layer=L2`) → `POST /payment/submit-result` → **Plutus validator executed in-head**.

Two Confirmed L2 transactions were produced and verified *absent* from L1 — i.e. they really
executed inside the head.

---

## 6. Open items

1. **Linux/NVMe confirmation.** The claim that a real server approaches the RAM-disk figure is
   reasoned from fsync costs, not yet measured. One droplet run would settle it.
2. **Fanout and open script UTxOs.** Fanout takes the whole UTxO set in one transaction, so every
   escrow script UTxO left in the head is validated inside a single Plutus evaluation. On 2026-08-28
   a head carrying 29 of them (~480-byte inline datums) overspent the execution budget by 39 M units
   on a 6.5 KB transaction — under the size limit, so Hydra's size-based partial fanout never
   triggered, and retrying rebuilt the identical failing transaction. Mitigated by
   `16-drain-escrows.mts`, which drives every terminal L2 cycle before Close and refuses to close
   above a calibrated ceiling (default 10; the measured failure point is ~28). The 2026-08-31 run
   closed and fanned out cleanly with this gate in place. Upstream splitting fanout on execution
   units — not only on transaction size — still looks like a genuine gap worth reporting.

3. **Refund and dispute flows** were not part of this measurement (validated separately in July).
4. **Escrow throughput tuning.** Batching more escrows per cron tick is untested and is the most
   promising lever.
5. **Multi-head throughput.** The 500 TPS network figure is per-head throughput multiplied by head
   count, and has not been measured. Running five heads concurrently, ideally on separate hosts,
   would confirm that heads do not contend.
6. **The throughput/latency curve.** Only two operating points were measured: 1 transaction in
   flight (24.2 TPS, 39 ms) and 500 (100.0 TPS, 4,981 ms). Sweeping the window between them would
   show the best throughput reachable inside a 500 ms finality budget, which is the number an
   operator actually needs.

---

## Replication

```bash
# one step at a time (recommended)
./hydra-l2-flow/replicate-benchmark.sh db        # test Postgres + seed
./hydra-l2-flow/replicate-benchmark.sh head      # open a fresh preprod head
./hydra-l2-flow/replicate-benchmark.sh raw       # raw L2 bench, SSD
./hydra-l2-flow/replicate-benchmark.sh raw-ram   # raw L2 bench, RAM disk
./hydra-l2-flow/replicate-benchmark.sh escrow    # escrow lifecycles
./hydra-l2-flow/replicate-benchmark.sh settle    # drain -> Close -> Fanout -> L1 anchors
./hydra-l2-flow/replicate-benchmark.sh timeline  # node-recorded history

# or the whole thing (~50 min)
./hydra-l2-flow/replicate-benchmark.sh all
```

**Prerequisites**

- Docker running (for the test Postgres)
- `jq` and `sqlite3` on `PATH` (the script parses JSON; the timeline reads the node's event store)
- `hydra-l2-flow/preprod/` holding the party keys and `blockfrost.txt`
- The purchasing wallet funded with ~250 tADA on preprod
- `ENCRYPTION_KEY` present in `.env`
- macOS for the `raw-ram` step only (`hdiutil`/`diskutil`); every other step is portable

Run subcommands individually rather than `all` the first time — `head` commits real tADA.

Do **not** override `CONTESTATION_PERIOD` or `DEPOSIT_PERIOD`. Both were tried on 2026-08-31 and
both broke the run: a 60 s contestation period shrinks the head datum and lowers its stored
`headAdaOverhead` (Close then fails H65 `ChangedHeadAdaOverhead`), and a 120 s deposit period
expired the deposit before the increment could land.

**Cost:** opening a head commits `COMMIT_ADA` (default 110) into it. Until the fanout issue above is
resolved, that ADA stays in the head unless all escrows are collected before closing.

**Two traps worth knowing:** do not export a shell-extracted `ENCRYPTION_KEY` (`.env` is not
shell-safe to `source`, and a mangled value silently breaks API-key hashing); and the test database
uses port **5434**, since 5433 is commonly already taken.
