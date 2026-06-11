# Hydra L2 escrow — end-to-end devnet harness

A turnkey driver that exercises the **full Masumi V2 Hydra L2 escrow lifecycle**
against a **live local Hydra devnet**. Every step runs Masumi's own service code
(`processL2PurchaseLocks`, `processL2SubmitResult`, …) against a real
`hydra-node`; the head's `TxValid` log and its `/snapshot/utxo` HTTP API are the
ground-truth result.

This is a **manual integration harness**, not a CI unit test. It needs Docker, a
disposable Postgres, and an external Hydra devnet, so it is run by hand when
validating L2 changes — not on every push. The committed Jest suites
(`*.spec.ts`) cover the same code paths in isolation.

> One entrypoint: [`run-hydra-e2e.sh`](run-hydra-e2e.sh). The `NN-*.mts` files are
> its step drivers (one per escrow operation) and are invoked by the script — you
> don't run them directly.

## What it validates

The seven escrow operations, across three flows:

| Flow    | Path                                                              | Waits        |
| ------- | ---------------------------------------------------------------- | ------------ |
| `flow1` | lock → submit-result → **collection** (seller paid)              | ~13 min      |
| `flow2` | lock → request-refund → authorize-refund → **collect-refund**    | none         |
| `flow3` | lock → submit-result → request-refund(→Disputed) → **authorize-withdrawal** | ~16 min |

The waits in flow1/flow3 are the payment contract's own seller/buyer cooldowns —
correct on-chain behaviour, not a hang.

## Prerequisites

### 1. Tooling

Docker running, plus `pnpm` and `node` on your `PATH`.

### 2. Container images

The devnet runs on two upstream images. Pull them ahead of time so the first run
doesn't stall on a download:

```bash
docker pull ghcr.io/cardano-scaling/hydra-node:2.1.0
docker pull ghcr.io/intersectmbo/cardano-node:10.6.2
```

The throwaway test database uses the official `postgres:15` image, which Docker
pulls automatically on first run.

### 3. Hydra devnet

The harness drives the official
[`cardano-scaling/hydra`](https://github.com/cardano-scaling/hydra) devnet. It is
maintained **outside this repository** — Masumi only connects to it over HTTP/WS.
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

- **Shelley genesis** — 1-second slots, epoch length `43200`.
- **Byron genesis** — 1-second slot duration.
- **Node deposit period** — `120s`, so out-of-band commits finalize at 1-second
  slots.

The exact values, rationale, and the three blockers this harness shook out
(`PPViewHashesDontMatch`, `OutsideForecast`, slot-context propagation) are in
[`docs/hydra-l2-devnet-findings.md`](../docs/hydra-l2-devnet-findings.md).

## Run

```bash
# from the repo root
./hydra-l2-flow/run-hydra-e2e.sh up      # devnet + test DB (port 5433) + open & fund a head
./hydra-l2-flow/run-hydra-e2e.sh flow2   # fastest end-to-end (refund path, no cooldown)
./hydra-l2-flow/run-hydra-e2e.sh verify  # last head verdict + in-head escrow UTxOs
./hydra-l2-flow/run-hydra-e2e.sh down    # stop devnet + remove the test DB

# or the whole lifecycle in one go (~30 min incl. cooldowns):
./hydra-l2-flow/run-hydra-e2e.sh all
```

`up` creates a throwaway Postgres in Docker on **port 5433** (`masumi-hydra-test-db`)
and runs Prisma migrate + seed against it. Your dev DB on 5432 is untouched.
`down` removes it.

### Useful env overrides

| Var              | Default                  | Purpose                                  |
| ---------------- | ------------------------ | ---------------------------------------- |
| `HYDRA_DEMO_DIR` | sibling hydra checkout   | location of the external hydra devnet    |
| `DB_CONTAINER`   | `masumi-hydra-test-db`   | test Postgres container name             |
| `NODE1`          | `http://localhost:4001`  | head node HTTP API                       |
| `RUN_TIMEOUT`    | `120`                    | per-step tsx timeout (seconds)           |

## Notes

- The harness runs **no tx-sync loop**, so it unlocks hot wallets between steps
  itself (`UPDATE "HotWallet" SET "lockedAt"=NULL`). That's a harness shortcut,
  not how production behaves.
- L2 is single-item by design (in-head txs are free + instant, so there is no fee
  reason to batch). `12-multi-lock.mts` demonstrates that multiple escrows
  serialize per-wallet, one per orchestrator tick.
- Step drivers hardcode the demo's deterministic container names
  (`demo-cardano-node-1`) and the `alice-funds` faucet address; these are fixed by
  the cardano-scaling demo's seed, so they are stable across devnet re-creations.
- `.seller.json` (a generated seller mnemonic) is written at runtime and is
  gitignored — never commit it.
