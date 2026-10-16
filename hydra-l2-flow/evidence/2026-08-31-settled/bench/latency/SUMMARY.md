# Hydra L2 benchmark — latency — 2026-08-31T13:58:20.770Z

| metric | value |
|---|---|
| transactions sent / valid / confirmed | 200 / 200 / 200 |
| **TPS (snapshot-confirmed)** | **24.2** |
| TPS (node-validated) | 24.3 |
| latency to confirmed p50 / p95 / p99 (ms) | 39 / 50.1 / 54.1 |
| latency to valid p50 / p95 / p99 (ms) | 9.9 / 19.9 / 25.7 |
| snapshots (avg txs each) | 200 (1) |
| invalid | 0 |
| config | 1 chains × 200 hops, 1-in/1-out ada transfer, fee 0, no scripts |
| hydra-node | 2.3.0-ef833d8a07d412a5a58cf1976afd4e81866ac4df, 2-party head |
| hardware | Apple M4 (10 cores, 16 GB), darwin arm64 |

> Sequential round-trips: each payment waits for multi-signed snapshot
> confirmation before the next is sent — this is per-payment finality latency.
