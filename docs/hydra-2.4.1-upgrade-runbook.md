# Upgrading Hydra from 2.3.0 to 2.4.1

This runbook covers the move of every Hydra Host and payment service from
`hydra-node` 2.3.0 to 2.4.1 (PR #827). Read the first section before you touch
a Host. The upgrade is not reversible, and a head that is still open when its
node upgrades cannot be used again by that node.

Provenance tags in this document: VERIFIED means the author ran the command in
this repository and saw the output. REPORTED means the value comes from the
upstream release notes or from PR #827 and was not reproduced here.

## Why upgrade

2.4.1 is a security release. Upstream's note for 2.4.1 says that a malicious
participant on 2.3.0 or 2.4.0 can trick honest nodes into signing a snapshot
that contains a transaction with an invalid signature (REPORTED,
`gh release view 2.4.1 --repo cardano-scaling/hydra`). 2.4.0 also changed the
Hydra scripts and the snapshot signature payload so that a snapshot names the
deposit it approves (REPORTED, same source).

## Before you upgrade anything: close and fan out every open head

Upstream's 2.4.0 release note says to close and fan out any open head before
upgrading, because an upgraded node can no longer interact with it and
snapshots signed by earlier versions fail verification (REPORTED). This
service has the same limit: its own snapshot verification now uses the 2.4
signature payload, and a 2.3-signed history no longer verifies (VERIFIED,
`src/lib/hydra/hydra/snapshot-verification.spec.ts`). A head that is still
open at upgrade time goes offline with its funds inside, and no 2.4.1 node can
close it.

1. In the admin UI, confirm that every head on every Host shows `Idle` or
   `Final`. Close and fan out the rest, and wait for the fanout to confirm on
   L1.
2. Confirm that no top-up (`HydraTopup`) is pending. A deposit that is on chain
   but not yet absorbed must be recovered before the head closes.
3. Take a snapshot of each Host's data volume. The node migrates `hydra.db` on
   its first 2.4.1 start, and upstream says there is no downgrade path
   (REPORTED).

Both sides of a head must upgrade. A 2.3.0 node and a 2.4.1 node cannot open a
head together, because their script hashes differ.

## Upgrade the Host

The Host image now takes `hydra-node` from the upstream multi-arch image,
pinned by index digest
`sha256:608ae9b336209a18d7f3c42f7ca2d73c51dcb1b90732e533dd3b8017485fa98a`
(VERIFIED, `docker buildx imagetools inspect ghcr.io/cardano-scaling/hydra-node:2.4.1`
reports that digest for the tag). Follow
[hydra-host-deploy-droplet.md §9](hydra-host-deploy-droplet.md) for the
container swap. Two new environment variables exist on the Host:

| Variable                                | Set it?                                                                                                                                                                                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HYDRA_HOST_SCRIPTS_TX_IDS`             | Yes, on preprod. Comma-separated transaction ids of a Hydra script set you published yourself. PR #827 reports that upstream's preprod publication cannot be read through the 2.4.1 Blockfrost client (`AssetNameMissing`) (REPORTED). Empty means `--network`, the upstream set. |
| `HYDRA_HOST_DEPOSIT_ACTIVATION_SECONDS` | No. Leave it unset. The Host then uses each node's own deposit period as its activation, which keeps the 2.3.0 deposit timing. Setting it changes when deposits become usable on every node this Host runs.                                                                       |

Publish a script set once per network with the 2.4.1 binary:

```bash
hydra-node publish-scripts --blockfrost <project-file> --cardano-signing-key <payment.sk>
```

The command prints the transaction ids. Both Hosts of a head may use the same
set. Node records written by a 2.3.0 Host get their deposit activation filled
in at read time from their own deposit period, so existing records need no
migration (VERIFIED, `packages/hydra-host/src/registry/store.ts`).

## Re-pin the payment service

Every pin in `.env` that names the 2.3.0 node must change. Both sides of a
head do this on their own service.

| Variable                               | 2.4.1 value                                                                                                                                                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HYDRA_EXPECTED_VERSION`               | `2.4.1-<git sha>` as the node reports it under **Details → Version**. The 2.4.1 tag builds as `2.4.1-099f5dd775d8640047d0074edef294c1b39a600d` (VERIFIED, `hydra-node --version` on the tag's CI artifact). |
| `HYDRA_EXPECTED_SCRIPT_CATALOGUE_HASH` | From **Details → Scripts** after **Check**, as in [hydra-operations.md §2b](hydra-operations.md).                                                                                                           |
| `HYDRA_HEAD_SCRIPT_HASH`               | `1d511733200df551c8cd8cddb3160ed39087af815638be37a1b80ffd`                                                                                                                                                  |
| `HYDRA_DEPOSIT_SCRIPT_HASH`            | `eafae2c32f99ab347c7bb15961e0e84c74305f9088c1a7b8abf88e7f`                                                                                                                                                  |

The two script hashes are the code defaults, so an `.env` that never set them
needs no change. An `.env` that pinned the 2.3.0 values must update, or every
new head fails on-chain verification with
`Hydra InitTx did not contain exactly one official head output with its state token`.

Note on the script hashes: upstream's
`hydra-chain-observer/script-hashes.json` at tag 2.4.1 lists these two values
the other way round. The preprod chain does not. The deposit transaction
`63fc758a77ffb7b25968099e277c55964f78119914b835c92d105c11990183b9` pays its
200 ADA deposit output to script `eafae2c3…`, and the InitTx
`29519fad5e031bb1ce678026523503eca8149ab9d439495996dcbae889bf38a2` of the
recorded head `7357fa25…` pays its head output to script `1d511733…`
(VERIFIED, Koios preprod `tx_info`, 2026-09-11). Do not swap the values to
match upstream's file.

## Check that it worked

1. Press **Check** on each node in the admin UI. The node goes Active once
   the three pins match.
2. Open a head. The service verifies the InitTx on chain and now also compares
   the on-chain deposit period with the one the invite carried.
3. Send one top-up. `usableFrom` and `absorbBy` keep the 2.3.0 offsets, because
   the Host sets deposit activation equal to the deposit period.

## What behaves differently on 2.4.1

- An L2 submission returns after the head confirms the snapshot, not after the
  local node accepts the body. A peer that refuses the body used to leave the
  service pointing at a transaction that never existed. The wait has the usual
  30 s command timeout; on timeout the reservation stays pending and recovery
  reverts it once the body can no longer land.
- `Init` waits for a node that reports `CatchingUp` to report `NodeSynced`
  before it sends, for up to 180 s, because a parked `Init` on a node that is
  behind was seen to never run.
- The deposit period is now part of the head's on-chain parameters. Both nodes
  of a head must run the same value, which the invite already enforces.
- The node no longer emits `SyncedStatusReport`. Chain-sync state arrives as
  `NodeSynced` and `NodeUnsynced`, and on `Greetings.chainSyncedStatus`.

## Release evidence

- `gh release view 2.4.1 --repo cardano-scaling/hydra --json assets` returns
  no assets (VERIFIED). The Host image therefore pulls the upstream container
  image by digest, and the local dev script falls back to the tag's CI
  artifact.
- The aarch64-darwin CI artifact of Binaries run `33660882209` (commit
  `099f5dd7`, the commit the 2.4.1 tag points at) contains a `hydra-node` with
  sha256 `aed4edcc451cf691eb1ece6e80fb5953f432652d928a36ed4141da5dd09db087`
  that reports version `2.4.1-099f5dd775d8640047d0074edef294c1b39a600d`
  (VERIFIED, 2026-09-11). `hydra-l2-flow/hydra-native.sh` pins that value.
- The snapshot signature payload in `hydraSnapshotSignableBytes` matches
  upstream `hydra-tx/src/Hydra/Tx/Snapshot.hs` at tag 2.4.1: the commit slot is
  `sha256(hashUTxO(utxoToCommit) ‖ depositTxId)`, applied with or without a
  deposit (VERIFIED against the tagged source). Real 2.4.1 multisignatures
  recorded on preprod verify under it (VERIFIED,
  `src/lib/hydra/hydra/__fixtures__/recorded-signed-snapshots-2.4.1.json`).
- The Open datum layout (eight fields, deposit period at index 4) matches
  upstream `hydra-plutus/src/Hydra/Contract/HeadState.hs` at tag 2.4.1
  (VERIFIED).
- The Host image builds and runs natively on linux/arm64 without the SIGILL
  the 2.3.0 amd64-only build hit under emulation (REPORTED, PR #827).

## Local development

`hydra-l2-flow/hydra-native.sh` needs two values on 2.4.1:

- `HYDRA_SCRIPTS_TX_IDS`, the self-published preprod script set, for the same
  Blockfrost reason as the Host.
- `HYDRA_BINARY_SHA256`, pinned in the script for 2.4.1. The script refuses to
  install a binary it cannot verify.
