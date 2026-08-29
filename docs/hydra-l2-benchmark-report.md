# Masumi on Hydra L2 — benchmark report

**Date:** 2026-08-28 · **Network:** Cardano **preprod** (real testnet) · **hydra-node:** 2.3.0
**Topology:** 2-party head (purchasing ⇄ selling)

Everything below was measured on the live preprod network, not a local devnet. Raw evidence
(per-run JSON, per-transaction timings, and the node's own event log) is in
`hydra-l2-flow/evidence/`. To reproduce, see [Replication](#replication).

---

## 1. Headline results

### Raw agent-to-agent payments

One agent paying another inside the head — a plain 1-input/1-output ADA transfer, zero fee, no
smart contract. This is what the Catalyst milestone means by "agent-to-agent transactions".

| Persistence | Sustained throughput | Latency per payment (p50) |
|---|---|---|
| Mac SSD | **96.8 TPS** | **38 ms** |
| RAM disk | **1,128–1,148 TPS** | **2.7 ms** |

Every run: 10,000 transactions, **100 % confirmed, zero invalid**.

**Milestone targets — 500+ TPS and under 500 ms — are met.**

### Masumi escrow payments (the product)

A real Masumi payment is three transactions against the `vested_pay` V2 contract, driven by the
payment service's own code. 20 of 20 lifecycles completed.

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

### Evidence layout

| Path | Contents |
|---|---|
| `evidence/bench/<ts>/result.json` | per-run config + results |
| `evidence/bench/<ts>/events.ndjson` | **every transaction**, with sent / valid / confirmed timings |
| `evidence/bench/2026-08-28-VERIFICATION-RERUN.md` | the reproduction comparison |
| `evidence/bench-escrow/2026-08-28-CORRECTED-N20/` | escrow lifecycle results |
| `evidence/timeline/head-timeline.{txt,json}` | node-recorded head history |

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
2. **Fanout limit.** Settling a head that still holds many open escrow UTxOs fails: the fanout
   transaction overspends the Plutus execution budget (~39 M CPU units over) even though the
   transaction is only 6.5 KB, so Hydra's size-based partial fanout never triggers. **Collect
   escrows before closing.** Funds remain safe and recoverable — fanout has no deadline.
3. **Refund and dispute flows** were not part of this measurement (validated separately in July).
4. **Escrow throughput tuning.** Batching more escrows per cron tick is untested and is the most
   promising lever.

---

## Replication

```bash
# one step at a time (recommended)
./hydra-l2-flow/replicate-benchmark.sh db        # test Postgres + seed
./hydra-l2-flow/replicate-benchmark.sh head      # open a fresh preprod head
./hydra-l2-flow/replicate-benchmark.sh raw       # raw L2 bench, SSD
./hydra-l2-flow/replicate-benchmark.sh raw-ram   # raw L2 bench, RAM disk
./hydra-l2-flow/replicate-benchmark.sh escrow    # escrow lifecycles
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

**Cost:** opening a head commits `COMMIT_ADA` (default 110) into it. Until the fanout issue above is
resolved, that ADA stays in the head unless all escrows are collected before closing.

**Two traps worth knowing:** do not export a shell-extracted `ENCRYPTION_KEY` (`.env` is not
shell-safe to `source`, and a mangled value silently breaks API-key hashing); and the test database
uses port **5434**, since 5433 is commonly already taken.
