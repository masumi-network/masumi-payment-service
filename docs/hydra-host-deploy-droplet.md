# Deploying a Hydra Host on a droplet

This is the deployment path the Hydra Host was designed for: one virtual
machine, one attached block-storage volume, one container, and a firewall in
front. It replaces `docker compose` entirely. The compose files in
`packages/hydra-host/` are a local testing rig and a worked example of the
settings that matter, not a deployment.

Read [hydra-operations.md](hydra-operations.md) first for what a head is and how
to connect a Host to your payment service. This document covers only the
machine.

## Why not App Platform

A Hydra Host cannot run on DigitalOcean App Platform, or on any platform with an
ephemeral filesystem. Its durable state is a SQLite event store plus an etcd
raft write-ahead log. Both need real POSIX `fsync` durability on local disk, and
etcd expects local disk rather than a network filesystem. Checkpointing to
object storage does not rescue it: an involuntary kill between checkpoints loses
exactly the head state whose loss is unrecoverable. See
[ADR 0015 §7](adr/0015-hydra-host-provisioning-and-exposure.md).

## What the droplet needs

| Requirement                           | Why                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **amd64 CPU**                         | The image bakes `hydra-node`, and upstream publishes no `aarch64-linux` build. An arm64 droplet has nothing to run. See [hydra-host-native-mode.md](hydra-host-native-mode.md). |
| **A block-storage volume**            | Not the droplet's own disk if you want the head to survive rebuilding the droplet. Never a network filesystem.                                                                  |
| **A stable public hostname or IP**    | It becomes each node's advertise identity and must not change for a head's lifetime.                                                                                            |
| **A Blockfrost project id in a file** | Every node follows the chain through it.                                                                                                                                        |
| **A cloud firewall**                  | The peer plane cannot authenticate its callers.                                                                                                                                 |

Sizing is not measured in this repository. The structural facts: one
`hydra-node` process per head, each running an embedded etcd, and the default
capacity is 32 heads per Host (`HYDRA_HOST_PEER_PORT_COUNT`). Start small,
measure with your own head count, and treat any figure quoted elsewhere as
unverified.

## 1. The persistent volume

### What lives on it

```
/data/
  host.lock/              lease directory: one Host per volume
  host.lock.takeover/
  exchange.json           invites this Host issued, unspent and unexpired
  nodes/<nodeId>/
    node.json             the durable record for one head
    keys/                 mode 0700: hydra.sk and cardano.sk
    persistence/          SQLite event store plus the etcd raft WAL
```

Losing this volume loses the heads. Recovering one needs the escrowed keys plus
a snapshot, so treat the volume as the primary copy of something irreplaceable.

### Attach, format, mount

DigitalOcean's control panel prints the exact device path and commands when you
attach a volume. The device follows the pattern
`/dev/disk/by-id/scsi-0DO_Volume_<volume-name>`.

```bash
VOLUME=/dev/disk/by-id/scsi-0DO_Volume_hydra-data
mkfs.ext4 -F "$VOLUME"
mkdir -p /mnt/hydra_data
mount -o defaults,discard,noatime "$VOLUME" /mnt/hydra_data
```

Persist it in `/etc/fstab`:

```
/dev/disk/by-id/scsi-0DO_Volume_hydra-data /mnt/hydra_data ext4 defaults,nofail,discard,noatime 0 0
```

`nofail` lets the droplet finish booting when the volume is missing. That is
safe here **only because the systemd unit below refuses to start without the
mount**. Without that guard, `nofail` plus a Docker restart policy is how a Host
boots on an empty directory, finds no node records, and supervises nothing while
every head sits unattended.

### Ownership

The image runs as a non-root user, uid and gid `10001`
([Dockerfile:115](../packages/hydra-host/Dockerfile:115)). A freshly formatted
volume is owned by root, so the Host cannot write to it.

```bash
chown -R 10001:10001 /mnt/hydra_data
chmod 700 /mnt/hydra_data
```

### The Blockfrost file

`BLOCKFROST_PROJECT_FILE` is a **path to a file containing the project id**, not
the id itself. It is handed to `hydra-node` as `--blockfrost`, and the node opens
it. A Host with no such file starts fine and then every node it spawns dies,
which reads as a node problem rather than a missing secret.

```bash
mkdir -p /srv/hydra
install -o 10001 -g 10001 -m 600 /dev/null /srv/hydra/blockfrost.txt
# Paste the project id, then Ctrl-D. Avoids leaving it in shell history.
cat > /srv/hydra/blockfrost.txt
```

## 2. Run the container

Use `--network host`. Publishing 32 peer ports individually spawns 32 userland
proxies and caps how many heads one Host can carry. Under host networking the
`hydra-node` API range stays shut anyway, because it is pinned to `127.0.0.1` in
code ([args.ts:27](../packages/hydra-host/src/supervisor/args.ts:27)).

```bash
docker create --name hydra-host \
  --network host \
  --restart no \
  --stop-timeout 250 \
  -v /mnt/hydra_data:/data \
  -v /srv/hydra/blockfrost.txt:/run/secrets/blockfrost.txt:ro \
  -e HYDRA_HOST_PUBLIC_HOST=hydra1.example.com \
  -e HYDRA_HOST_NETWORK=preprod \
  -e HYDRA_HOST_ADMIN_TOKEN="$HYDRA_HOST_ADMIN_TOKEN" \
  -e HYDRA_HOST_USER_TOKEN="$HYDRA_HOST_USER_TOKEN" \
  -e BLOCKFROST_PROJECT_FILE=/run/secrets/blockfrost.txt \
  -e HYDRA_HOST_PEER_PORT_START=5001 \
  -e HYDRA_HOST_PEER_PORT_COUNT=32 \
  -e HYDRA_HOST_MONITORING_ENABLED=false \
  ghcr.io/example/hydra-host@sha256:...
```

`docker create` rather than `docker run -d`: the container is created here and
started by systemd in the next step, so there is exactly one thing that decides
when it runs.

Pin an immutable digest. A floating `latest` replaces reviewed code at the next
pull, and both sides of a head must run the same `hydra-node` version.

Leave `HYDRA_HOST_LEDGER_PARAMS_FILE` and `HYDRA_HOST_USE_SYSTEM_ETCD` unset.
The image copies the reviewed params to `/opt/hydra/params` and bakes a matching
etcd, which are the defaults. Overriding either is how you get
`PPViewHashesDontMatch` on the first spend inside a head.

### Why `--stop-timeout 250`

The Host waits out each node's in-flight snapshot round before stopping it,
because etcd persists `last-known-revision` before the head logic durably
consumes the message. A round cut off in that window is never redelivered and
every later transaction fails `TxInvalid`.

The arithmetic, at the defaults: `HYDRA_HOST_DRAIN_TIMEOUT_MS` is 120s, a node
that ignores its SIGTERM gets another 30s before SIGKILL, and the SIGKILL is
waited on for 5s. A worst-case node takes 155s. The shutdown fans out over every
node at once, so 155s is the whole shutdown rather than per node. The Host's own
guard gives up at 240s (`SHUTDOWN_GRACE_MS`). The stop timeout has to sit past
that. Docker's 10s default SIGKILLs mid-round. Raise both together if you raise
the drain timeout.

## 3. Let systemd own the container

`--restart no` above is deliberate. A Docker restart policy starts the container
at boot, possibly before `/mnt/hydra_data` is mounted. systemd can express the
dependency; Docker cannot.

`/etc/systemd/system/hydra-host.service`:

```ini
[Unit]
Description=Hydra Host
Requires=docker.service
After=docker.service network-online.target
RequiresMountsFor=/mnt/hydra_data

[Service]
Type=simple
Restart=always
RestartSec=10
TimeoutStopSec=270
ExecStart=/usr/bin/docker start --attach hydra-host
ExecStop=/usr/bin/docker stop --timeout 250 hydra-host

[Install]
WantedBy=multi-user.target
```

`RequiresMountsFor` is the whole point: the unit refuses to start when the volume
is not mounted, so a Host never comes up on an empty registry.
`TimeoutStopSec` must exceed the `docker stop` timeout, or systemd kills the
client while the drain is still running.

```bash
systemctl daemon-reload
systemctl enable --now hydra-host
```

## 4. The firewall

Two layers, and both are needed. The cloud firewall keeps strangers off the
machine. The nftables ruleset keeps a peer port open only to the counterparty
that head actually peers with.

### The five ranges

| Port        | Plane                                          | Exposed                                                                                                                            |
| ----------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `8443`      | Control. Your payment service talks to this.   | Yes, bearer-token gated. Restrict by source.                                                                                       |
| `8444`      | Exchange. Where counterparties redeem invites. | Yes. See below.                                                                                                                    |
| `5001-5032` | Peer. One per head, etcd raft.                 | Yes, per-head source allow-list.                                                                                                   |
| `4001-4032` | `hydra-node` API                               | **Never.** Unauthenticated, can close a head. Pinned to loopback in code.                                                          |
| `6001-6032` | Prometheus                                     | **Never.** `hydra-node` has no `--monitoring-host`, so it cannot be bound to loopback. Keep `HYDRA_HOST_MONITORING_ENABLED=false`. |

The etcd client port is derived as `2379 + (listenPort - 5001)` and binds
loopback only. It never crosses the network.

### DigitalOcean cloud firewall

| Type    | Protocol | Ports     | Sources                                                                   |
| ------- | -------- | --------- | ------------------------------------------------------------------------- |
| Inbound | TCP      | 8443      | Your load balancer, or your payment service's address. Never `0.0.0.0/0`. |
| Inbound | TCP      | 8444      | `0.0.0.0/0`                                                               |
| Inbound | TCP      | 5001-5032 | Counterparty addresses only                                               |
| Inbound | TCP      | 22        | Your own administrative range                                             |

The exchange plane on 8444 is open on purpose. It is unauthenticated by design,
because the invite nonce is the credential: redemption requires a nonce this Host
issued, unspent and unexpired. Bodies are capped at 64KB, concurrency at 16, and
requests at 120 per minute. Nothing on that plane can provision, delete,
reconfigure or proxy a node. Its entire vocabulary is "redeem an invite I
issued". A counterparty's address is not knowable before they redeem, which is
why it cannot be source-restricted the way the peer plane can.

### The nftables ruleset for the peer plane

The peer plane carries etcd raft. There is no token to present, no handshake to
gate, and no peer encryption. It must still be reachable, because a head whose
peer port is closed cannot reach its counterparty. The Host therefore generates a
per-head source allow-list from what it already knows: a counterparty's address
must already be configured to set `--peer`.

The Host emits the rules and does not apply them. The container cannot alter the
firewall of the machine it runs on, and should not try.

Save this as `/usr/local/sbin/hydra-peer-rules`, because you will run it often:

```bash
#!/bin/bash
set -euo pipefail
umask 077

DEST=/etc/nftables.d/hydra-peer.nft
TMP="$DEST.new"
mkdir -p /etc/nftables.d

curl -fsS \
  -H "Authorization: Bearer $HYDRA_HOST_ADMIN_TOKEN" \
  http://127.0.0.1:8443/v1/peer-allowlist \
  | python3 -c 'import json,sys; sys.stdout.write(json.load(sys.stdin)["nftables"])' \
  > "$TMP"

test -s "$TMP"      # refuse an empty or truncated fetch
nft -c -f "$TMP"    # syntax check
mv "$TMP" "$DEST"
nft -f "$DEST"
```

The temporary file and the `test -s` both matter, and `nft -c` alone does not
replace them. The generated ruleset opens with `add table` and `flush
table`, so a fetch that dies after those two lines leaves a file that is
perfectly valid syntax and that flushes every accept rule. Written straight to
the destination and applied, that empties the table and opens the whole peer
range. Fetch to one side, prove the file is non-empty, then move it into place.

What the generated ruleset does:

- Emits an `input` chain **and** a `forward` chain. Host-network traffic
  traverses `input`; Docker-published bridge traffic traverses `forward` after
  DNAT. The same file is correct for either deployment shape.
- Default-denies the whole peer range, not just the ports it allows. A node
  removed between two applications would otherwise leave its port quietly open.
- Leaves a provisioned-but-unpeered node's port shut. That window is when an
  open peer port protects nothing at all.
- Resolves peer hostnames itself and renders IPv4 literals only. Configured names
  are never interpolated into nftables syntax, so a syntactically valid hostname
  cannot change the meaning of the ruleset.

**Re-apply the ruleset whenever peer membership or DNS changes.** That means
after every provision, every invite redemption, every node removal, and whenever
a counterparty's address moves. The `add` plus `flush` plus declarations are one
`nft` transaction, so an update replaces every prior accept rule with no
fail-open interval.

Persist it across reboots the way your distribution expects, for example by
including `/etc/nftables.d/hydra-peer.nft` from `/etc/nftables.conf` and enabling
`nftables.service`.

## 5. TLS and the load balancer

The container serves plain HTTP and honours `X-Forwarded-Proto` for logging
only. The token, not the transport, is what authenticates. Terminate TLS outside:
a managed load balancer in front of `8443`.

Keeping ACME state out of the image means the container has exactly one thing
needing durable storage.

The peer plane bypasses the load balancer entirely. It has no TLS upstream, and
per-head dynamic TCP ports behind a managed load balancer are unworkable, so
peer ports sit directly on the droplet IP under the allow-list above.

## 6. Health

The control plane deliberately has no unauthenticated health route. Probe an
authenticated route without a token and expect `401`: that proves the server is
serving and that auth is wired, without adding one more thing reachable without a
token.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8443/v1/capabilities
# 401 means healthy
```

Point a load-balancer health check at `8443` with the same expectation, or at TCP
connect if your load balancer cannot assert a status code.

## 7. One Host per volume

`/data/host.lock` is a lease with a heartbeat. A second Host pointed at the same
volume refuses to start and reports that another Host already holds it. The lease
goes stale after 60 seconds, so a Host that died without releasing it blocks its
own replacement for up to that long. That is expected; do not shorten it by
deleting the lock directory while a Host may still be running.

A head is pinned to its Host for life. Persistence is not relocatable, so
placement happens once at provisioning and the head stays there. Process,
container and droplet restarts recover on their own from the intact volume. Only
destruction of the volume needs the escrowed keys plus a snapshot.

Rebuilding the droplet under the same volume is therefore the supported repair,
and re-provisioning a head elsewhere is not. Keep `HYDRA_HOST_PUBLIC_HOST`
resolving to the new machine before you start the Host: it is each node's
advertise identity, and a counterparty dials it.

## 8. Backups

Take DigitalOcean volume snapshots on a schedule.

A snapshot of a mounted volume is a crash-consistent image, not a clean copy: it
catches the event store and the raft WAL mid-write. That is the same class of
state a power cut leaves, which both stores are built to recover from, but it is
weaker than a snapshot taken with the Host stopped. Stop the Host first when the
schedule allows it.

What a snapshot does and does not cover:

- It does **not** replace the escrowed keys. Key material is readable exactly
  once, before escrow-ack, and no endpoint returns it again afterwards. Store it
  where you store your other irreplaceable secrets.
- It does not cover the tokens or the Blockfrost file. Those live on the
  droplet's own disk, not the volume. Keep them in your secret store.
- Restoring rewinds the event store to the snapshot. Restore only into a stopped
  Host, and treat the head as needing verification against the chain afterwards
  rather than assuming it resumes where it left off.

## 9. Upgrades

Both sides of a head must run the same `hydra-node` version, so an upgrade is a
coordinated change, not a rolling one.

```bash
systemctl stop hydra-host                          # drains, up to 250s
docker rm hydra-host
docker create --name hydra-host ... <new digest>   # same flags, same volume
systemctl start hydra-host
```

After any change to the running version or scripts, press **Check** on the node in
the admin UI and re-pin `HYDRA_EXPECTED_VERSION` and
`HYDRA_EXPECTED_SCRIPT_CATALOGUE_HASH` in your payment service. See
[hydra-operations.md §2b](hydra-operations.md).

## Checklist

1. amd64 droplet, block-storage volume mounted at `/mnt/hydra_data`, owned by
   `10001:10001`.
2. Blockfrost project id in a file, mode 600, owned by `10001:10001`.
3. Container run with `--network host`, `--stop-timeout 250`, `--restart no`.
4. systemd unit with `RequiresMountsFor` and `TimeoutStopSec=270`, enabled.
5. Cloud firewall: 8443 restricted, 8444 open, 5001-5032 to counterparties, 22 to
   you.
6. `/usr/local/sbin/hydra-peer-rules` installed, run once, and re-run on every
   membership or DNS change.
7. Load balancer terminating TLS in front of 8443, health check expecting 401.
8. Volume snapshots scheduled; escrowed keys stored separately.

## Related

- [hydra-operations.md](hydra-operations.md): running heads day to day
- [hydra-host-native-mode.md](hydra-host-native-mode.md): running without a container
- [adr/0015-hydra-host-provisioning-and-exposure.md](adr/0015-hydra-host-provisioning-and-exposure.md): why the planes are split this way
