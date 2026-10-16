# Masumi on Hydra L2: preprod run, settled end to end (2026-08-31)

**Network:** Cardano preprod · **hydra-node:** 2.3.0-ef833d8a · **Topology:** 2-party head
**Head id:** `d276058a22ad180bc94bfc89d85d6c02c5e5a110dd5ddcd759f213b1`
**Hardware:** Apple M4 (10 cores, 16 GB), darwin arm64 · persistence on SSD
**Wall clock:** 13:40 -> 14:10 UTC (30 min, open -> settle)

One head: opened on L1, ran a full escrow lifecycle and 10,000 agent-to-agent payments inside it,
then closed and fanned the result back out to L1.

## Throughput

| Metric | Result |
|---|---|
| Sustained throughput | **100.0 TPS** confirmed (100.3 valid) |
| Transactions | **10,000 / 10,000 confirmed, 0 invalid** |
| Per-payment latency p50 | **39.0 ms** |
| Per-payment latency p95 | 50.1 ms |

Sustained: 40 chains x 250 hops, 1-in/1-out ADA transfer, fee 0, no scripts, 100.2 s wall clock.
Latency is measured in a separate sequential run (200/200 confirmed): each payment waits for
multi-signed snapshot confirmation before the next is sent, so it is per-payment finality. The
sustained run's own p50 (4,980 ms) is snapshot batching under saturation and is **not** the latency
figure. Quote 39 ms.

## Escrow lifecycle (Masumi's own services)

`flow2`: lock -> request-refund -> authorize-refund -> collect-refund. **4/4 TxValid.**

Every transaction was built, signed and submitted by the payment service's own V2 services, the
same code the production crons run, with the Plutus validator executing in-head. Each step logged
`head id == Masumi DB hash`, which is only possible if the transaction the head accepted was the one
Masumi built.

## On-chain, preprod

`https://preprod.cardanoscan.io/transaction/<hash>`

| Role | Tx | Block | Time (UTC) |
|---|---|---|---|
| funding/split | `b6bc7f589d2688cdd281290f9d3b4711e055c25c6798907b84a7549cd4972b55` | 5121783 | 13:40:38 |
| **Init** | `29a86185fc14e956c3f2abdc32487c246be13deea28882d5fa147b5064bc4996` | 5121789 | 13:41:58 |
| **Increment** | `4b7b61735af539bf39a6899e6558f42f39b75e887327a412486cd1966d2a2daa` | 5121818 | 13:52:30 |
| **Close** | `171d99ddaa6545fe6795bd81546aa1bd5dfc23186764dfd0b6435823fd9ba2bf` | 5121841 | 14:01:02 |
| **Fanout** | `2108fdf624e313ddbd79ad83669130bf360827b7288909cd4e7b51bca52cfc83` | 5121860 | 14:10:21 |

Close and Fanout both consume assets whose minting policy **is** the head id above, so they
provably belong to this head and no other. Fanout burns all three head tokens and pays
**200.000000 ADA** back to L1: 10 + 45 + 5 ADA to the buyer, 25 ADA to the seller, 115 ADA to the
node wallet. That split is the net result of everything that happened inside the head.

## Why the 10,000 L2 transactions are not on Cardanoscan

They never touch L1, which is what a Hydra head is for. Cardano L1 tops out near 10-15 TPS, so
100 TPS cannot exist there, and running the same 10,000 transactions on L1 would cost roughly
1,700 tADA in fees instead of zero. **Their absence from L1 is the result, not a gap in it.**
Verified: sampling tx ids from `bench/*/events.ndjson.gz` against Blockfrost preprod returns HTTP 404.

What proves the throughput is `snapshots/pre-close/node{1,2}-snapshot.json`: a **ConfirmedSnapshot
carrying both parties' signatures**, produced by the hydra-nodes rather than by our harness. Its
balances equal the Fanout outputs above. That equality is the bridge from L2 to L1.

`events.ndjson.gz` holds transaction ids and timings, not transaction bodies, so the 10,000
payments cannot be re-validated from this directory. The independent check on the count is
hydra-node's own event store in `head-timeline.txt`: 10,216 `TransactionAppliedToLocalUTxO`
and 316 `SnapshotConfirmed`, matching the snapshot number in `snapshots/pre-close/`.

## Contents

| Path | What |
|---|---|
| `l1-anchors.json` | every L1 tx: role, block, slot, time, `valid_contract`, Cardanoscan URL |
| `settlement.json` | closeTx / fanoutTx (reconciled against the chain), lovelace settled, settled UTxOs |
| `snapshots/pre-close/`, `snapshots/post-fanout/` | `/snapshot` (multi-signed), `/snapshot/utxo`, `/snapshot/last-seen`, `/head`, from both nodes |
| `bench/saturation/`, `bench/latency/` | `result.json`, `SUMMARY.md`, `events.ndjson.gz`: per-transaction sent/valid/confirmed timings |
| `head-timeline.{json,txt}` | head lifecycle + per-second tx rate, read from hydra-node's own event store |
| `run.log` | full run transcript |

## Verify it yourself

```bash
BF=$(cat hydra-l2-flow/preprod/blockfrost.txt)
API=https://cardano-preprod.blockfrost.io/api/v0

# 1. every L1 anchor is real and its scripts validated
jq -r '.anchors[].txHash' l1-anchors.json | while read h; do
  curl -s -H "project_id: $BF" "$API/txs/$h" | jq -r '"\(.hash[0:16])… block \(.block_height) valid=\(.valid_contract)"'
done

# 2. the fanout paid 200 ADA back to L1
curl -s -H "project_id: $BF" "$API/txs/$(jq -r .fanoutTx l1-anchors.json)/utxos" | jq '.outputs[].amount[0]'

# 3. L2 transactions are absent from L1 (expect 404)
gunzip -c bench/saturation/events.ndjson.gz | head -1 | jq -r .txId | \
  xargs -I{} curl -s -o /dev/null -w "%{http_code}\n" -H "project_id: $BF" "$API/txs/{}"

# 4. TPS re-derives from the raw per-transaction log.
#    The earliest 'sent' event is the untimed split tx that seeds the chains, so it is
#    excluded here exactly as the harness excludes it. Prints 10000 / 99.98 s / 100 TPS.
gunzip -c bench/saturation/events.ndjson.gz | jq -s '
  (map(select(.kind=="sent"))|sort_by(.t)) as $s
  | ($s[0].txId) as $seed
  | (map(select(.kind=="confirmed" and .txId != $seed))) as $c
  | (($c|map(.t)|max) - $s[1].t) / 1000 as $sec
  | { transactions: ($c|length), seconds: ($sec|.*100|round/100), tps: (($c|length)/$sec|.*10|round/10) }'
```

## Reproducing

```bash
./hydra-l2-flow/replicate-benchmark.sh all     # db -> head -> benches -> escrow -> settle
# or one stage at a time:
./hydra-l2-flow/replicate-benchmark.sh db
COMMIT_ADA=200 ./hydra-l2-flow/replicate-benchmark.sh head
./hydra-l2-flow/replicate-benchmark.sh raw
./hydra-l2-flow/replicate-benchmark.sh settle  # drain -> Close -> Fanout -> anchors
```

Do **not** override `CONTESTATION_PERIOD` or `DEPOSIT_PERIOD`. Both were tried on 2026-08-31 and both
broke the run: a 60 s contestation period shrinks the head datum and lowers its stored
`headAdaOverhead`, and a 120 s deposit period expired the deposit before the increment could land.
