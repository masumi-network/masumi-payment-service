# Hydra L2 escrow: end-to-end harness

A turnkey driver that exercises the full Masumi V2 Hydra L2 escrow lifecycle
against a real `hydra-node`. Every step runs Masumi's own service code
(`processL2PurchaseLocks`, `processL2SubmitResult`, …); the head's `TxValid` log
and its `/snapshot/utxo` HTTP API are the ground-truth result.

Architecture overview: [`docs/hydra-architecture.md`](../docs/hydra-architecture.md).

This is a manual integration harness, not a CI unit test. It needs Docker, a
disposable Postgres, and a Hydra head, so it is run by hand when validating L2
changes, not on every push. The committed Jest suites (`*.spec.ts`) cover the
same code paths in isolation.

## Two entrypoints

| Script | Network | Answers |
| ------------------------------------------------- | ------------ | ------------------------------ |
| [`run-hydra-e2e.sh`](run-hydra-e2e.sh)             | local devnet | does the escrow lifecycle work |
| [`replicate-benchmark.sh`](replicate-benchmark.sh) | preprod      | how fast is it                 |

Both invoke the `NN-*.mts` step drivers and the `bench-*.mts` benchmarks for you.
Do not run those files directly.

Sections up to [Run](#run) describe the devnet harness. The preprod benchmark has
its own section: [Benchmark on preprod](#benchmark-on-preprod).

> **These files are not type-checked.** `hydra-l2-flow/**` is absent from the
> `include` list in `tsconfig.json`, so `tsc` never reads them. A type error, or
> an import you deleted while a call site still uses it, will not fail CI. Several
> step drivers fail `tsc` today against a stale `LocalParticipant` shape, which is
> why the directory is excluded. Check a file you edited on its own: add
> `tsconfig.l2flow.json` at the repo root with
>
> ```json
> { "extends": "./tsconfig.json", "include": ["src/ws.d.ts", "hydra-l2-flow/00-open-head.mts"] }
> ```
>
> run `pnpm exec tsc --noEmit -p tsconfig.l2flow.json`, then delete it.
> `src/ws.d.ts` is required: without it the `ws` import in the Hydra client
> reports TS7016.

## What it validates

The seven escrow operations, across three flows:

| Flow    | Path                                                                        | Waits   |
| ------- | --------------------------------------------------------------------------- | ------- |
| `flow1` | lock → submit-result → **collection** (seller paid)                         | ~13 min |
| `flow2` | lock → request-refund → authorize-refund → **collect-refund**               | none    |
| `flow3` | lock → submit-result → request-refund(→Disputed) → **authorize-withdrawal** | ~16 min |

The waits in flow1/flow3 are the payment contract's own seller/buyer cooldowns.
They are correct on-chain behaviour, not a hang.

## Prerequisites

### 1. Tooling

Docker running, plus `pnpm` and `node` on your `PATH`.

### 2. Container images

The devnet runs on two upstream images. Pull them ahead of time so the first run
doesn't stall on a download:

```bash
docker pull ghcr.io/cardano-scaling/hydra-node:2.3.0
docker pull ghcr.io/intersectmbo/cardano-node:10.6.2
```

The throwaway test database uses the official `postgres:15` image, which Docker
pulls automatically on first run.

### 3. Hydra devnet

The harness drives the official
[`cardano-scaling/hydra`](https://github.com/cardano-scaling/hydra) devnet. It is
maintained outside this repository. Masumi only connects to it over HTTP/WS.
Obtain it once:

```bash
git clone https://github.com/cardano-scaling/hydra
```

Clone it alongside this repository and the harness discovers it automatically. If
you keep it elsewhere, export its location:

```bash
export HYDRA_DEMO_DIR=<your hydra devnet directory>
```

### 4. Devnet timing configuration

The stock devnet uses sub-second slots and a five-slot epoch, which violates the
Ouroboros stability rule (`10k ≤ f · epochLength`). The forecast horizon
collapses and every time-bounded Plutus transaction fails with `OutsideForecast`.
Before the first run, adjust the devnet so the whole test stays inside one
forecastable epoch:

- **Shelley genesis**: 1-second slots, epoch length `43200`.
- **Byron genesis**: 1-second slot duration.
- **Node deposit period**: `120s`, so out-of-band commits finalize at 1-second
  slots.

The exact values, rationale, and the three blockers this harness shook out
(`PPViewHashesDontMatch`, `OutsideForecast`, slot-context propagation) are in
[`docs/hydra-l2-devnet-findings.md`](../docs/hydra-l2-devnet-findings.md).

## Run

```bash
# from the repo root
./hydra-l2-flow/run-hydra-e2e.sh up        # devnet + test DB (port 5433) + open & fund a head
./hydra-l2-flow/run-hydra-e2e.sh flow2     # fastest end-to-end (refund path, no cooldown)
./hydra-l2-flow/run-hydra-e2e.sh settle    # Close → Fanout: settle in-head balances back to L1 (run LAST)
./hydra-l2-flow/run-hydra-e2e.sh evidence  # render evidence/EVIDENCE.md (escrow proof + settlement)
./hydra-l2-flow/run-hydra-e2e.sh verify    # last head verdict + in-head escrow UTxOs
./hydra-l2-flow/run-hydra-e2e.sh down      # stop devnet + remove the test DB

# or the whole lifecycle in one go (~30 min incl. cooldowns): up → flows → settle:
./hydra-l2-flow/run-hydra-e2e.sh all
```

> `settle` is terminal (it closes the head), so run it only after the flows you want.
> It writes settlement state which `evidence` folds into `evidence/EVIDENCE.md`, so the
> escrow proof and the L1 settlement appear in **one** report. (`all`/`demo` run it last
> and regenerate the combined report automatically.) Reports this subcommand writes
> are gitignored, so regenerate them with `evidence`. The one committed exception is
> `evidence/2026-08-31-settled/`, the preprod run cited by the benchmark report.

`up` creates a throwaway Postgres in Docker on port 5433 (`masumi-hydra-test-db`)
and runs Prisma migrate + seed against it. Your dev DB on 5432 is untouched.
`down` removes it.

The preprod benchmark uses port 5434 for the same container name, because 5433 is
often already taken. Running both harnesses on one machine therefore collides: the
second one calls `docker start` on the existing container, which keeps the port it
was created with, and then connects to the other port. Run `down` before switching
harnesses, or set `DB_CONTAINER` to a distinct name.

### Useful env overrides

| Var              | Default                 | Purpose                                                               |
| ---------------- | ----------------------- | --------------------------------------------------------------------- |
| `HYDRA_DEMO_DIR` | sibling hydra checkout  | location of the external hydra devnet                                 |
| `DB_CONTAINER`   | `masumi-hydra-test-db`  | test Postgres container name                                          |
| `NODE1`          | `http://127.0.0.1:4001` | head node HTTP API (127.0.0.1, not localhost: native node binds IPv4) |
| `RUN_TIMEOUT`    | `120`                   | per-step tsx timeout (seconds)                                        |

Hydra persistence event-log rotation is deliberately unsupported. Do not set
`PERSISTENCE_ROTATE_AFTER` or add `--persistence-rotate-after` to the external
demo compose file: both supported launch paths reject that configuration. A
compacted replay can omit the original Open and signed-snapshot anchors, while
the remaining `Greetings`, side-loaded snapshot, and current `/snapshot/utxo`
data are not sufficient authentication. The service therefore also latches
fail-closed if a node emits `EventLogRotated` or an Open replay reaches
`Greetings` without a restored Open/signed-snapshot anchor. Use an unrotated
persistence tree; recover or settle an already-rotated head manually.

## Benchmark on preprod

[`replicate-benchmark.sh`](replicate-benchmark.sh) measures L2 throughput and
latency on Cardano preprod, not on the devnet. It opens a real head, commits real
tADA, and settles back to L1. Results and the method are in
[`docs/hydra-l2-benchmark-report.md`](../docs/hydra-l2-benchmark-report.md); the
committed evidence is in `evidence/2026-08-31-settled/`.

```bash
./hydra-l2-flow/replicate-benchmark.sh db        # test Postgres on 5434 + seed
./hydra-l2-flow/replicate-benchmark.sh head      # open a fresh preprod head
./hydra-l2-flow/replicate-benchmark.sh raw       # raw L2 throughput + latency, SSD
./hydra-l2-flow/replicate-benchmark.sh raw-ram   # same, persistence on a RAM disk
./hydra-l2-flow/replicate-benchmark.sh escrow    # full escrow lifecycles
./hydra-l2-flow/replicate-benchmark.sh settle    # drain, Close, Fanout, L1 anchors
./hydra-l2-flow/replicate-benchmark.sh timeline  # timeline from the node event store
./hydra-l2-flow/replicate-benchmark.sh all       # every stage, about 50 minutes
```

It needs `hydra-l2-flow/preprod/` holding the party keys and `blockfrost.txt`, a
purchasing wallet funded with roughly 250 tADA, and `ENCRYPTION_KEY` in `.env`.
`jq` and `sqlite3` must be on `PATH`. Only `raw-ram` is macOS-only, since it uses
`hdiutil`.

Run stages one at a time the first time. `head` commits real tADA, and `settle`
closes the head.

## Notes

- The harness runs no tx-sync loop, so it unlocks hot wallets between steps
  itself (`UPDATE "HotWallet" SET "lockedAt"=NULL`). That's a harness shortcut,
  not how production behaves.
- L2 is single-item by design (in-head txs are free + instant, so there is no fee
  reason to batch). `12-multi-lock.mts` demonstrates that multiple escrows
  serialize per-wallet, one per orchestrator tick.
- Step drivers hardcode the demo's deterministic container names
  (`demo-cardano-node-1`) and the `alice-funds` faucet address; these are fixed by
  the cardano-scaling demo's seed, so they are stable across devnet re-creations.
- `.seller.json` (a generated seller mnemonic) is written at runtime and is
  gitignored. Never commit it.
