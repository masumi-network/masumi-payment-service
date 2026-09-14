# Hydra L2 benchmark — saturation — 2026-08-31T13:56:29.425Z

| metric | value |
|---|---|
| transactions sent / valid / confirmed | 10000 / 10000 / 10000 |
| **TPS (snapshot-confirmed)** | **100** |
| TPS (node-validated) | 100.3 |
| latency to confirmed p50 / p95 / p99 (ms) | 4980.7 / 5745.5 / 7911 |
| latency to valid p50 / p95 / p99 (ms) | 554.7 / 1592.1 / 4166.9 |
| snapshots (avg txs each) | 101 (99) |
| invalid | 0 |
| config | 40 chains × 250 hops, 1-in/1-out ada transfer, fee 0, no scripts |
| hydra-node | 2.3.0-ef833d8a07d412a5a58cf1976afd4e81866ac4df, 2-party head |
| hardware | Apple M4 (10 cores, 16 GB), darwin arm64 |

> Latency here is measured **under saturation** (snapshot batching inflates it).
> Use a `--mode latency` run for the <500ms per-payment claim.
