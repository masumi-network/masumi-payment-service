# Hydra Host end-to-end run

Brings up two Hydra Hosts and two real `hydra-node` processes on one machine,
peers them into a single etcd cluster, and asserts the behaviour that only
appears when actual processes are involved.

```bash
pnpm exec tsx scripts/hydra-e2e/run.mts
```

Exits non-zero if any check failed. State and logs land in `.hydra-e2e/`
(gitignored), which is wiped at the start of each run — set `HYDRA_E2E_KEEP=1`
to inspect a previous run instead.

This runs the Host natively rather than in its container. That is not a
shortcut: upstream publishes no `linux/arm64` `hydra-node`, so on an arm64 Mac a
container could only hold the amd64 binary, which dies under emulation. See
[docs/hydra-host-native-mode.md](../../docs/hydra-host-native-mode.md).

## Prerequisites

- The Darwin `hydra-node` binary and a preprod Blockfrost project id, both from
  the untracked `hydra-l2-flow/` harness. They are resolved from the main clone
  when this runs in a git worktree.
- PostgreSQL with a `masumi_hydra_e2e` database, migrated:

  ```bash
  createdb masumi_hydra_e2e
  ```

  ```bash
  DATABASE_URL="postgresql://$USER@localhost:5432/masumi_hydra_e2e?schema=public" ENCRYPTION_KEY=12345678901234567890123456789012 pnpm exec prisma migrate deploy --config prisma/prisma.config.ts
  ```

Override any path with `HYDRA_E2E_NODE_BIN`, `HYDRA_E2E_BLOCKFROST_FILE`,
`HYDRA_E2E_DATABASE_URL`, `HYDRA_E2E_DIR`.

## Topology

Two Hosts rather than one, because a Head has two participants and in production
they belong to different organisations. Separate Hosts keep that boundary real:
separate registries, locks, port ranges and tokens.

|                           | Host A   | Host B   |
| ------------------------- | -------- | -------- |
| control plane             | `:18443` | `:18444` |
| peer ports                | `5001+`  | `5101+`  |
| derived etcd client ports | `2379+`  | `2479+`  |

`hydra-node` derives its etcd client port from the peer port (peer − 2622), so
the peer ranges are far enough apart that the derived ranges do not collide
either.

The payment service runs on `:3010`. There is no second deployment: the
counterparty is simulated by posting to the Exchange Plane directly, so nothing
listens on `:3011` during a run.

## What each phase asserts

| Phase                                 | Substance                                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hosts: capabilities`                 | the probe ran the real binary — a populated script catalogue with no probe error can only come from `hydra-node --hydra-script-catalogue` executing                       |
| `hosts: auth tiers`                   | admin/user separation, and that one Host rejects the other's token                                                                                                        |
| `provision: escrow contract`          | keys are disclosed once, a replay of the same idempotency key re-discloses, a replay with different parameters is refused, and acknowledgement seals the path permanently |
| `cluster: start`                      | both nodes reach a serving API. With two members raft has no quorum until the peers find each other, so a serving API is itself proof the peer plane works                |
| `cluster: peer connection`            | each node logged connecting to the other's advertise address — mutual and named, not just "something connected"                                                           |
| `proxy: allow-list`                   | `/config` is unreachable by construction, unauthenticated requests are refused, and one Host does not serve the other's node ids                                          |
| `lifecycle: drain and stop`           | a stop drains the node before killing it, rather than cutting it off mid-round                                                                                            |
| `lifecycle: restart from persistence` | a restarted node comes back on the same event store and etcd WAL                                                                                                          |
| `lifecycle: removal guard`            | removing a live node needs an explicit `force`                                                                                                                            |
| `lifecycle: host crash recovery`      | after `SIGKILL` the Host boots again despite the unreleased lock and reconciles its nodes back to serving, unattended                                                     |
| `invites: minting` / `preview`        | an invite is minted against a reserved node, and previewing one discloses nothing that identifies the issuer                                                              |
| `invites: exchange plane`             | a redemption signed by the invited wallet is accepted, and one signed by anyone else gets an indistinguishable answer                                                     |
| `invites: exchange plane surface`     | the Exchange Plane serves the redeem route and nothing else — no fleet operation and no proxied node API                                                                  |
| `invites: revocation`                 | a revoked invite stops being redeemable and gives its node and peer port back                                                                                             |

## Opening a real Head

Opt-in, because it spends preprod funds and waits on confirmations:

```bash
HYDRA_E2E_INIT=1 pnpm exec tsx scripts/hydra-e2e/run.mts
```

Each node's Cardano key is generated by its Host and starts empty, so the phase
funds both from `hydra-l2-flow/preprod/purchasing-cardano.sk` (override with
`HYDRA_E2E_FUNDING_KEY`) and then sends `Init` over the node's own API, through
the proxy, with the user token — the same route the payment service uses. It
then closes the head down again, so a run leaves nothing open on chain. Set
`HYDRA_E2E_KEEP_HEAD=1` to leave it open for inspection.

Two chain-timing facts shape this phase, and both look like bugs if you do not
know them:

- Blockfrost confirming the funding transaction is not the same as the node's
  chain follower having observed it. Until it has, `Init` returns
  `NoSeedInput`, so the phase retries rather than sleeping once.
- `Abort` is legal only while the head is `Initializing`. Once it is `Open` the
  only way out is `Close`, waiting out the contestation period, then `Fanout`.
  Sending the wrong one is silently ignored.

Funds sent to a node address are recoverable only through that node's signing
key, which lives under the Host's data directory and is wiped with the run
directory. The phase prints both addresses and key paths before spending.

To check what is available first:

```bash
pnpm exec tsx scripts/hydra-e2e/balance.mts hydra-l2-flow/preprod/purchasing-cardano.vk
```

That reports pure-ADA UTxOs separately on purpose: the preprod faucet bundles
ADA with tUSDM, and `Init` only selects pure-ADA inputs, so a funded-looking
address whose every UTxO carries a token fails in a way that reads as a protocol
bug.

### If a run leaves something behind

Resume the previous run's Hosts without wiping anything, and optionally close
down whatever head they left open:

```bash
RESUME_TEARDOWN=1 pnpm exec tsx scripts/hydra-e2e/resume.mts
```

Then return the leftover funds to the harness wallet:

```bash
pnpm exec tsx scripts/hydra-e2e/sweep.mts .hydra-e2e/hostA/nodes/<id>/keys/cardano.sk
```

## Layout

| File                                                                                  | Role                                                                                                      |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `run.mts`                                                                             | orchestration                                                                                             |
| `env.mts`                                                                             | ports, tokens, paths, prerequisites                                                                       |
| `procs.mts`                                                                           | process and HTTP helpers                                                                                  |
| `check.mts`                                                                           | assertion recorder — records rather than throws, so one failure does not hide the twenty after it         |
| `cardano.mts`                                                                         | address derivation and balances                                                                           |
| `head-ws.mts`                                                                         | node WebSocket commands and head teardown                                                                 |
| `fixture.mts`                                                                         | seeds the database; runs as its own process so `DATABASE_URL` is set before Prisma loads                  |
| `resume.mts`                                                                          | restart a previous run's Hosts without wiping                                                             |
| `sweep.mts`                                                                           | return a node's leftover funds to the harness wallet                                                      |
| `balance.mts`                                                                         | report what a key envelope controls on chain                                                              |
| `phases/`                                                                             | one file per phase                                                                                        |
| `replay-check.mts`                                                                    | replays recorded history against snapshot verification — run it on every hydra-node upgrade, per ADR 0012 |
| `demo.mts`                                                                            | a scripted walkthrough against a running service; needs `HYDRA_DEMO_DATABASE_URL`                         |
| `two-nodes.mts` / `smoke-pairs.mts` / `measure-throughput.mts` / `submit-results.mts` | standalone L2 exercises against an already-open head; need `HYDRA_E2E_BLOCKFROST_KEY`                     |
