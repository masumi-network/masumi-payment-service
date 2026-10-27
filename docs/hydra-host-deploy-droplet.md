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
| **An encrypted block-storage volume** | Keep head state across droplet rebuilds. The volume holds plaintext node signing-key files while mounted. Use local block storage with LUKS2; never a network filesystem.       |
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
VERIFIED (`packages/hydra-host/src/api/provision.ts`): the Host writes node
signing keys as mode 0600 files under `keys/`. File permissions do not protect
an offline copy of the volume. Encrypt the block device before putting a Host
on it, and keep the unlock secret outside the droplet and its snapshots. LUKS2
protects an unmounted volume; the running Host can still read its keys.

### Attach, encrypt, format, mount

DigitalOcean's control panel prints the exact device path and commands when you
attach a volume. The device follows the pattern
`/dev/disk/by-id/scsi-0DO_Volume_<volume-name>`.
These commands are for a **new, empty volume only**. `luksFormat` and `mkfs.ext4`
destroy existing data. Do not run them on a volume that holds a live head. For
an existing plaintext Host, keep the volume and snapshots protected until its
heads are finalised and an encrypted replacement can be built.

```bash
VOLUME=/dev/disk/by-id/scsi-0DO_Volume_hydra-data
cryptsetup luksFormat --type luks2 "$VOLUME"
cryptsetup open "$VOLUME" hydra_data
mkfs.ext4 /dev/mapper/hydra_data
mkdir -p /mnt/hydra_data
mount -o defaults,noatime /dev/mapper/hydra_data /mnt/hydra_data
cryptsetup status hydra_data
findmnt -no SOURCE /mnt/hydra_data
```

The status check must show an active LUKS2 mapping. The mount source must be
`/dev/mapper/hydra_data`. Store the passphrase in an operator secret store.
Configure an unlock method that survives droplet rebuilds before enabling the
Host. A manual unlock requires an operator at each boot; an unattended unlock
requires an external key service. Do not put the unlock key on the same droplet
or in a snapshot of it.

Add this entry to `/etc/crypttab` so systemd knows the mapping:

```
hydra_data /dev/disk/by-id/scsi-0DO_Volume_hydra-data none luks
```

Persist the mapped filesystem in `/etc/fstab`:

```
/dev/mapper/hydra_data /mnt/hydra_data ext4 defaults,nofail,noatime 0 0
```

`nofail` lets the droplet finish booting when the encrypted volume is locked or
missing. That is safe here **only because the systemd unit below refuses to
start without the mount**. After every reboot, confirm `cryptsetup status
hydra_data`, `findmnt -no SOURCE /mnt/hydra_data`, and the Host service state.
Without that guard, `nofail` plus a Docker restart policy is how a Host boots
on an empty directory while every head sits unattended.

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

### The token file

Keep the two Host tokens in a root-owned file with mode 600. Do not pass them
as `-e NAME=value` arguments. Those arguments are visible in the process list
to every local user while the command runs. With `--env-file`, the Docker client
reads the file itself, so the tokens never appear in process arguments.

```bash
install -o root -g root -m 600 /dev/null /srv/hydra/host.env
# Type the two lines below with the real tokens, then Ctrl-D.
# Avoids leaving the tokens in shell history.
cat > /srv/hydra/host.env
```

The file contains exactly these two lines:

```
HYDRA_HOST_ADMIN_TOKEN=<admin token>
HYDRA_HOST_USER_TOKEN=<user token>
```

Docker reads each line literally. Do not put quotes around a value, because the
quotes become part of the token.

## 2. Run the container

Use `--network host`. Publishing 32 peer ports individually spawns 32 userland
proxies and caps how many heads one Host can carry. Under host networking the
`hydra-node` API range stays shut anyway, because it is pinned to `127.0.0.1` in
code ([args.ts:27](../packages/hydra-host/src/supervisor/args.ts:27)).

The `--dns 127.0.0.53` value below is an example. Use a reachable IPv4 DNS
server on the target host, then put the same address in
`HYDRA_EGRESS_DNS_IPV4` in section 4. Repeat `--dns` for each server and keep
the same order in that comma-separated setting.

VERIFIED (`packages/hydra-host/Dockerfile`, `USER hydra` and uid `10001`):
the outbound peer rule matches host uid `10001`. Before `docker create`, make
the root-owned receipt directory that the container will read. Keep it on
`/run`, which is cleared at boot.

```bash
install -d -o root -g root -m 755 /run/hydra-peer-egress
```

```bash
docker create --name hydra-host \
  --network host \
  --dns 127.0.0.53 \
  --restart no \
  --stop-timeout 250 \
  --memory 4g \
  -v /mnt/hydra_data:/data \
  -v /run/hydra-peer-egress:/run/hydra-peer-egress:ro \
  -v /srv/hydra/blockfrost.txt:/run/secrets/blockfrost.txt:ro \
  -e HYDRA_HOST_PUBLIC_HOST=hydra1.example.com \
  -e HYDRA_HOST_PUBLIC_EXCHANGE_URL=https://hydra-exchange.example.com:8444/exchange \
  -e HYDRA_HOST_EXCHANGE_TRUST_PROXY=false \
  -e HYDRA_HOST_NETWORK=preprod \
  --env-file /srv/hydra/host.env \
  -e BLOCKFROST_PROJECT_FILE=/run/secrets/blockfrost.txt \
  -e HYDRA_HOST_SCRIPTS_TX_IDS="<txid,txid from publish-scripts>" \
  -e HYDRA_HOST_PEER_PORT_START=5001 \
  -e HYDRA_HOST_API_PORT_START=4001 \
  -e HYDRA_HOST_PEER_PORT_COUNT=32 \
  -e HYDRA_HOST_REQUIRE_PEER_FIREWALL_REFRESH=true \
  -e HYDRA_HOST_REQUIRE_PEER_EGRESS_FIREWALL=true \
  -e HYDRA_HOST_MONITORING_ENABLED=false \
  ghcr.io/example/hydra-host@sha256:...
```

`HYDRA_HOST_SCRIPTS_TX_IDS` holds the comma-separated transaction ids of a
Hydra script set you published yourself:

```bash
hydra-node publish-scripts --blockfrost /srv/hydra/blockfrost.txt \
  --cardano-signing-key /srv/hydra/publisher.sk
```

On preprod this is required from 2.4.1 on. Left empty, the Host passes
`--network preprod` instead, the node resolves upstream's published set, and it
dies seconds after boot with `BlockfrostClientError AssetNameMissing`
(REPORTED, see
[hydra-2.4.1-upgrade-runbook.md](hydra-2.4.1-upgrade-runbook.md)). That message
names neither the scripts nor this variable, so it reads as a chain-data fault.

The placeholder above is deliberate. An empty value is accepted silently and
fails later at the node; the unsubstituted placeholder is refused at startup by
name, with `HYDRA_HOST_SCRIPTS_TX_IDS must be comma-separated 64-character hex
transaction ids`.

`docker create` rather than `docker run -d`: the container is created here and
started by systemd in the next step, so there is exactly one thing that decides
when it runs.

`--memory` caps what the container can take from the droplet. Under
`--network host` the peer plane is open to every address the nftables ruleset
admits, so a flood from a peer must not be able to take the whole machine.
`4g` is an example: size it for the number of heads this Host runs, and leave
headroom for the OS. It is the same limit as `HYDRA_HOST_MEMORY_LIMIT` in the
compose file.

Pin an immutable digest. A floating `latest` replaces reviewed code at the next
pull, and both sides of a head must run the same `hydra-node` version.

Leave `HYDRA_HOST_LEDGER_PARAMS_FILE` and `HYDRA_HOST_USE_SYSTEM_ETCD` unset.
The image copies the reviewed params to `/opt/hydra/params` and bakes etcd 3.5.35
(same 3.5 line as the copy hydra-node embeds), which are the defaults. Overriding either is how you get
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
Wants=nftables.service hydra-peer-firewall.timer
After=docker.service network-online.target nftables.service
RequiresMountsFor=/mnt/hydra_data

[Service]
Type=simple
Restart=always
RestartSec=10
TimeoutStopSec=270
ExecStartPre=/usr/local/sbin/hydra-peer-firewall baseline
ExecStartPre=/usr/local/sbin/hydra-peer-egress baseline
ExecStart=/usr/bin/docker start --attach hydra-host
ExecStop=/usr/bin/docker stop --timeout 250 hydra-host

[Install]
WantedBy=multi-user.target
```

`RequiresMountsFor` is the whole point: the unit refuses to start when the volume
is not mounted, so a Host never comes up on an empty registry.
`TimeoutStopSec` must exceed the `docker stop` timeout, or systemd kills the
client while the drain is still running.

`ExecStartPre` is the firewall gate. Before every start, including each
`Restart=always` restart, it loads a ruleset that refuses the whole peer range.
Then it reads the loaded ruleset back. If `nft` fails, or the loaded table does
not refuse the range on both hooks, the script exits non-zero and systemd does
not start the container. No accept rule from an earlier run survives a restart.
The refresh timer in [section 4](#4-the-firewall) opens each peered port again
after the Host answers. Install the script and the timer before you enable this
unit.

VERIFIED (`packages/hydra-host/scripts/hydra-peer-egress:176`): the
second prestart check loads and reads back a separate outbound nftables table.
It writes a root-owned receipt only after verification. The Host checks that
receipt before it adopts or starts any node (`packages/hydra-host/src/index.ts`).
If Docker needs more than 30 seconds to start, the Host refuses boot. The
systemd restart runs both prestart checks again.

`After=nftables.service` matters at boot. A distribution `nftables.conf` that
starts with `flush ruleset` would otherwise delete the baseline after it loads.

```bash
systemctl daemon-reload
systemctl enable --now hydra-host
```

## 4. The firewall

The cloud firewall restricts inbound traffic. The inbound nftables table keeps
each peer port open only to its counterparty. The separate outbound table
restricts connections from the Hydra uid (section 4, below).

### The five ranges

| Port        | Plane                                          | Exposed                                                                                                                            |
| ----------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `8443`      | Control. Your payment service talks to this.   | Through the restricted Control Plane load balancer.                                                                                |
| `8444`      | Exchange. Where counterparties redeem invites. | Through the public TLS Exchange Plane load balancer.                                                                               |
| `5001-5032` | Peer. One per head, etcd raft.                 | Yes, per-head source allow-list.                                                                                                   |
| `4001-4032` | `hydra-node` API                               | **Never.** Unauthenticated, can close a head. Pinned to loopback in code.                                                          |
| `6001-6032` | Prometheus                                     | **Never.** `hydra-node` has no `--monitoring-host`, so it cannot be bound to loopback. Keep `HYDRA_HOST_MONITORING_ENABLED=false`. |

The etcd client port is derived as `2379 + (listenPort - 5001)` and binds
loopback only. It never crosses the network.

### DigitalOcean cloud firewall

| Type    | Protocol | Ports     | Sources                                          |
| ------- | -------- | --------- | ------------------------------------------------ |
| Inbound | TCP      | 8443      | Control Plane load balancer. Never `0.0.0.0/0`.  |
| Inbound | TCP      | 8444      | Exchange Plane load balancer. Never `0.0.0.0/0`. |
| Inbound | TCP      | 5001-5032 | Counterparty addresses only                      |
| Inbound | TCP      | 22        | Your own administrative range                    |

The Exchange Plane load balancer on 8444 is open on purpose. The droplet port
accepts traffic only from that load balancer. The plane is unauthenticated by design,
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

[`packages/hydra-host/scripts/hydra-peer-firewall`](../packages/hydra-host/scripts/hydra-peer-firewall)
applies them. Install it with its settings and the admin token:

```bash
install -o root -g root -m 755 packages/hydra-host/scripts/hydra-peer-firewall /usr/local/sbin/hydra-peer-firewall
install -o root -g root -m 600 /dev/null /srv/hydra/admin-token
# Paste the admin token, then Ctrl-D.
cat > /srv/hydra/admin-token
cat > /etc/default/hydra-peer-firewall <<'EOF'
HYDRA_PEER_PORT_START=5001
HYDRA_PEER_PORT_COUNT=32
HYDRA_ADMIN_TOKEN_FILE=/srv/hydra/admin-token
EOF
```

The port range must match `HYDRA_HOST_PEER_PORT_START` and
`HYDRA_HOST_PEER_PORT_COUNT`. `refresh` compares it with the `peerRange` the
Host reports and refuses a mismatch.

It has three commands:

| Command    | What it does                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseline` | Loads a ruleset that refuses the whole peer range. The `ExecStartPre` of the Host unit runs it.                                                   |
| `refresh`  | Fetches `GET /v1/peer-allowlist`, checks the file, applies it, persists it to `/etc/nftables.d/hydra-peer.nft`, then acknowledges it to the Host. |
| `verify`   | Reads the loaded ruleset and exits 0 only if both the `input` and `forward` chains refuse the range. Prints `verified` on success.                |

`baseline` and `refresh` both end with `verify`. A command that cannot prove the
loaded state exits non-zero. A failed fetch leaves the loaded ruleset unchanged.

`refresh` refuses a file that does not refuse the range on exactly two hooks or
that does not end with the closing brace. `nft -c` alone does not catch this.
The generated ruleset opens with `add table` and `flush table`, so a fetch that
dies after those two lines leaves a file that is valid syntax and that flushes
every rule. Applied, that file opens the whole peer range.

Refresh on a timer, so membership and DNS changes reach the firewall without an
operator. `/etc/systemd/system/hydra-peer-firewall.service`:

```ini
[Unit]
Description=Refresh the Hydra Host peer firewall
After=hydra-host.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/hydra-peer-firewall refresh
```

`/etc/systemd/system/hydra-peer-firewall.timer`:

```ini
[Unit]
Description=Refresh the Hydra Host peer firewall every 30 seconds

[Timer]
OnActiveSec=15s
OnUnitActiveSec=30s
AccuracySec=1s

[Install]
WantedBy=timers.target
```

```bash
systemctl daemon-reload
systemctl enable --now hydra-peer-firewall.timer
```

The script takes a lock, so a manual `refresh` and a timer run never apply at
the same time. A refresh fails while the Host is down. That is expected, and the
loaded ruleset stays as it is.

Also refuse the range before Docker starts. The Host unit above already runs
`baseline`, but anything else that Docker restarts on its own, such as a
compose container with `restart: unless-stopped`, publishes its ports again at
boot with no check. `/etc/systemd/system/hydra-peer-firewall-baseline.service`:

```ini
[Unit]
Description=Refuse the Hydra Host peer range before Docker starts
Wants=nftables.service
After=nftables.service
Before=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/hydra-peer-firewall baseline

[Install]
RequiredBy=docker.service
```

```bash
systemctl daemon-reload
systemctl enable hydra-peer-firewall-baseline.service
```

`RequiredBy=docker.service` makes the failure mode closed: if the baseline
cannot be loaded and verified, Docker does not start.

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

**The timer re-applies the ruleset at most 30 seconds after peer membership or
DNS changes.** To close that window, run
`systemctl start hydra-peer-firewall.service` right after every provision, every
invite redemption and every node removal. The `add` plus `flush` plus
declarations are one `nft` transaction, so an update replaces every prior accept
rule with no fail-open interval.

Include `/etc/nftables.d/hydra-peer.nft` from `/etc/nftables.conf`, after any
`flush ruleset` line, and enable `nftables.service`. This is required. A
distribution `nftables.conf` usually starts with `flush ruleset`, so without the
include a `systemctl reload nftables` deletes the peer table and opens the range
until the next refresh. With the include, the reload restores the last applied
ruleset. Include that one file by name, not a glob over the directory. Run
`hydra-peer-firewall baseline` once before you add the include: nft refuses the
whole `nftables.conf` when an included file does not exist.

### Outbound peer connections

VERIFIED (`packages/hydra-host/src/peer-target-policy.ts:149`): the Host checks
a peer name once at admission. REPORTED (`docs/hydra-operations.md:143`):
`hydra-node` resolves it again on reconnect. A peer
that changes its DNS after admission can make a new connection to an internal
address. The separate `hydra_peer_egress` table drops those destinations for
uid `10001` on the host-network deployment. It does not change the inbound peer
table (`packages/hydra-host/scripts/hydra-peer-firewall:10`).

VERIFIED (`packages/hydra-host/docker-compose.yml:112`): the local bridge-network
Compose rig opts out of this gate. This outbound rule covers the documented
production host-network launch only. A bridge-network deployment needs its own
outbound control.

VERIFIED (`packages/hydra-host/scripts/hydra-peer-egress:86`): the script renders
an output rule for uid `10001`. It allows replies to inbound connections and
permits the configured loopback node API, derived etcd client ports, and exact
Docker DNS servers on TCP and UDP port `53`. It then drops host-local and
non-public IPv4 and IPv6 destinations. Other public destinations follow the
base accept policy. It has no exception for the control plane on `8443`.
The Host refuses peer advertisements on DNS port `53` and on the local
API and etcd client ranges (`packages/hydra-host/src/peer-target-policy.ts:76`).
The `fib daddr type local` rule covers addresses assigned to this machine.
INFERRED: a floating IP or external load balancer may route back to the machine
without being a local FIB address. Check that routing separately before rollout.

Install the script and configure the same port layout as the container:

```bash
install -o root -g root -m 755 packages/hydra-host/scripts/hydra-peer-egress /usr/local/sbin/hydra-peer-egress
install -o root -g root -m 600 /dev/null /etc/default/hydra-peer-egress
cat > /etc/default/hydra-peer-egress <<'EOF'
HYDRA_HOST_PEER_PORT_START=5001
HYDRA_HOST_API_PORT_START=4001
HYDRA_HOST_PEER_PORT_COUNT=32
HYDRA_EGRESS_DNS_IPV4=127.0.0.53
EOF
```

VERIFIED (`packages/hydra-host/scripts/hydra-peer-egress:130`): `baseline` refuses a
non-host-network container, a changed port layout, a private-peer opt-in, a
missing firewall opt-in, user namespace remapping, or rootless Docker. It also
requires the created container's `--dns` list to match
`HYDRA_EGRESS_DNS_IPV4` exactly. Inspect both before starting:

```bash
cat /etc/resolv.conf
docker inspect --format '{{json .HostConfig.Dns}}' hydra-host
```

VERIFIED (local `docker create --network host --dns 127.0.0.53` and
`docker inspect --format '{{json .HostConfig.Dns}}'`: `["127.0.0.53"]`):
Docker records explicit DNS servers before start. On the tested Docker host,
`/etc/resolv.conf` was empty before first start and then contained
`nameserver 127.0.0.53`. INFERRED: another Docker host may populate that file
differently. After first start, compare
`docker exec hydra-host cat /etc/resolv.conf` with the configured list. If a
private resolver differs, DNS may fail on that first boot because the firewall
drops unlisted private DNS traffic. Stop the Host, correct `--dns` and the
exception list, recreate the stopped container, then restart through systemd.
A private IPv6 resolver needs a reachable IPv4 replacement.

INFERRED: changing the host uid mapping would make a uid-scoped rule miss all
Hydra sockets. Keep the reviewed image user and check the Docker namespace
setting on the target host. The script checks both before it applies a rule.
It does not change Docker's existing namespace mode.

INFERRED: the uid rule also affects unrelated host processes that use uid
`10001`. Use a dedicated droplet. Before rollout, inspect the host account and
current process inventory:

```bash
getent passwd 10001 || true
ps -eo uid,pid,comm | awk '$1 == 10001 { print }'
```

An empty process list does not prove that no scheduled job uses this uid.

VERIFIED (`packages/hydra-host/src/api/server.ts:475`): before the first rollout,
list every stored peer advertisement through the authenticated `GET /v1/nodes`.
Check for port `53`, the configured node API
range, the derived etcd client range, private peers, and peers on this same
machine. Such heads need an operator plan before this gate is enabled. Do not
change an open head's peer identity in place. The Host refuses stored records
using exception ports before it starts any node. INFERRED: stored peers that
resolve to private or same-machine addresses lose connectivity under the new
rule, so resolve them before rollout. The Host also refuses stored nodes whose
API or derived etcd client port is outside the configured exception ranges
(`packages/hydra-host/src/peer-target-policy.ts:92`). The API omits `apiPort`
(`packages/hydra-host/src/api/serialize.ts:60`), so inspect the protected
`/data/nodes/<nodeId>/node.json` records if the port layout has changed.

VERIFIED (`packages/hydra-host/scripts/hydra-peer-egress:170`): `baseline`
requires a stopped container. Use this rollout order for an existing Host:

1. Run `systemctl stop hydra-host`. Confirm
   `docker inspect --format '{{.State.Running}}' hydra-host` prints `false`.
2. Rename the stopped container with
   `docker rename hydra-host hydra-host-before-egress`. Recreate `hydra-host`
   with the `docker create` command in section 2. Keep its `/data` bind mount,
   image digest, identity, tokens and port layout. Add the read-only
   `/run/hydra-peer-egress` mount, explicit `--dns`, and egress setting shown
   there.
3. Install the root-owned script and `/etc/default/hydra-peer-egress` settings
   above. Check the host's resolver addresses and configured exceptions.
4. Run `hydra-peer-egress baseline` and `hydra-peer-egress verify`. Add the
   persisted nft file to `/etc/nftables.conf` as described below.
5. Run `systemctl start hydra-host`. The service repeats `baseline` before
   Docker starts the replacement container.

VERIFIED (`packages/hydra-host/scripts/hydra-peer-egress:178`, `:185`): the script persists
`/etc/nftables.d/hydra-peer-egress.nft` and writes a fresh receipt under
`/run/hydra-peer-egress`. Include that one nft file by name in
`/etc/nftables.conf`, after `flush ruleset`, beside `hydra-peer.nft`. This keeps
the outbound table present after a firewall reload. Run `baseline` once before
adding the include, because nft rejects a missing included file. The Host
service runs `baseline` again before every Docker start.

Run `packages/hydra-host/scripts/test-hydra-peer-egress-linux` as root on an
isolated Linux test host. It creates a temporary network namespace, loads the
real nft rule, and checks local exceptions, denied connections, and inbound
replies. A macOS unit test checks rendered rules and startup errors, but cannot
execute Linux nftables.

`HYDRA_HOST_REQUIRE_PEER_FIREWALL_REFRESH=true` closes the last window. Without
it, a new node can take the port of a removed node. The old counterparty's
address then reaches the new node until the next successful refresh. With it,
the Host keeps each released peer port out of use. `refresh` acknowledges each
ruleset after it applies and verifies it, through
`POST /v1/peer-allowlist/applied`. The Host frees a port only when it gets an
acknowledgement for a ruleset rendered after the release.

Expect these effects:

- A provision that finds only held ports gets `503`. Retry after the next
  refresh.
- After each Host start, every provision gets `503` until the first refresh
  succeeds. The Host cannot know which ports an earlier process released. With
  the timer above, that takes at most about 30 seconds after the Host answers.
- A refresh that keeps failing keeps released ports held. Alert on failures of
  `hydra-peer-firewall.service`.

Install the current script before you set the variable. An older script does
not acknowledge, so the Host never frees a released port.

## 5. TLS and the load balancer

The container serves plain HTTP and honours `X-Forwarded-Proto` for logging
only. Terminate TLS outside the container for both HTTP planes.

Use two regional load balancers because their public access rules differ:

| Load balancer  | Public rule  | Backend rule | Access                                   |
| -------------- | ------------ | ------------ | ---------------------------------------- |
| Control Plane  | HTTPS `443`  | HTTP `8443`  | Allow only the payment service addresses |
| Exchange Plane | HTTPS `8444` | HTTP `8444`  | Public                                   |

Set `HYDRA_HOST_PUBLIC_EXCHANGE_URL` to the Exchange Plane URL, including
`/exchange`. The Host reports this URL through its authenticated capabilities
response. The payment service puts that exact URL in signed invites. It no
longer derives the public Exchange Plane address from the private Control Plane
address.

Keep `HYDRA_HOST_EXCHANGE_TRUST_PROXY=false` during initial setup.
Before enabling it, configure the load balancer and restrict backend port `8444`
to that load balancer in the cloud firewall. Confirm that direct access is blocked.
Then set `HYDRA_HOST_EXCHANGE_TRUST_PROXY=true` in the container configuration.
DigitalOcean adds
the client address to `X-Forwarded-For`. The Host uses the last address when it
is a valid IP. It ignores this header when the setting is false.

VERIFIED on 2026-09-04: DigitalOcean regional load balancers support several
port and protocol rules, and HTTP forwarding adds `X-Forwarded-For`. See the
[forwarding-rule reference](https://docs.digitalocean.com/reference/doctl/reference/compute/load-balancer/add-forwarding-rules/)
and [load-balancer feature reference](https://docs.digitalocean.com/products/networking/load-balancers/details/features/).

Do not put both planes behind one public load balancer. A load balancer firewall
applies to the load balancer, not to one forwarding rule. Making its Exchange
Plane rule public would also make the Control Plane listener public.

Keeping ACME state out of the image means the container has exactly one thing
needing durable storage.

The peer plane bypasses the load balancer entirely. It has no TLS upstream, and
per-head dynamic TCP ports behind a managed load balancer are unworkable, so
peer ports sit directly on the droplet IP under the allow-list above.

### Control Plane traffic limits

VERIFIED (`packages/hydra-host/src/api/server.ts`,
`packages/hydra-host/src/api/server-limits.ts`): the Host caps JSON request
bodies at 256 KiB and bounds header and request read time. It closes a socket
that moves no bytes for 60 seconds. Authenticated node proxy requests and
proxied WebSockets opt out of that idle timeout. Its control socket cap is the
greater of 256 and eight times `HYDRA_HOST_PEER_PORT_COUNT`. The default 32
Head slots get 256 sockets. A Host configured for more Heads gets a larger
finite cap. This formula is a guard, not a measured capacity claim. When the
cap refuses a connection, the Host logs `control plane is at its N-connection
cap`, at once and then at most once a minute while drops continue. VERIFIED (`packages/hydra-host/src/api/proxy.ts`):
the node proxy streams HTTP bodies and tunnels WebSocket frames. Only an
authenticated caller reaches it. The Host does not bound request rate, proxy byte
volume, or WebSocket message size.

The Control Plane ingress must enforce these limits before forwarding to port
`8443`:

- **Connections:** Set a total cap below the Host's capacity-derived socket
  cap and a per-source cap. Without a per-source cap, one client that keeps
  opening connections can fill the Host cap, and the Host then drops new
  service calls and WebSocket reconnects. Alert on the Host's
  `connection cap` warning. Count WebSocket upgrades for the life of each
  session. Leave room for one live session per Head and normal control
  requests. Check OS file descriptor and memory limits at the chosen cap.
- **HTTP rate:** Set per-source and total request budgets with a short burst
  allowance. Reject excess requests with `429` before they reach the Host.
  Apply this to public docs routes as well as token routes.
- **HTTP bodies:** Reject Host JSON bodies over 256 KiB. Give proxied node
  `POST` routes a separate finite byte cap, based on the largest valid request
  measured in staging. Reject over-limit bodies before forwarding.
- **WebSocket messages:** Cap each reassembled client-to-Host message, including
  fragmented frames. Do not apply that cap to the Host-to-client history replay.
  Close an over-limit client message before it reaches a node.

Record the numeric limits in the ingress configuration. Size the proxy body,
WebSocket message, rate, and burst limits from a staging run with the maximum
configured Heads and a full `?history=yes` replay. Do not assume the load
balancer from section 5 enforces any of these rules. Check each rule against
its current documentation. If it cannot enforce a rule, put a capable ingress
between it and the Host. Keep the backend firewall restricted to that ingress.

Before production, verify the ingress rejects an over-rate request with `429`,
an oversized proxied body before it reaches the node, and an oversized client
WebSocket message before it reaches the node. Hold connections up to the chosen
cap and confirm that the next one is refused. Then confirm normal provisioning,
node transactions, and full history replay still complete. This checks both
the limits and the capacity left for valid traffic.

## 6. Health

The control plane deliberately has no unauthenticated health route. Probe an
authenticated route without a token and expect `401`: that proves the server is
serving and that auth is wired, without adding one more thing reachable without a
token.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8443/v1/capabilities
# 401 means healthy
```

Configure a separate TCP health check on each load balancer:

| Load balancer  | Health protocol | Backend port |
| -------------- | --------------- | ------------ |
| Control Plane  | TCP             | `8443`       |
| Exchange Plane | TCP             | `8444`       |

These ports match the forwarding rules and firewall sources above. The Exchange
Plane load balancer cannot probe `8443` through those firewall rules.
TCP checks confirm that a listener accepts connections. They do not test
authentication, TLS, or head readiness. Keep the local `401` probe as a manual check.

VERIFIED on 2026-09-05: DigitalOcean HTTP health checks accept status codes
`200` through `399`, so the `401` probe cannot serve as an HTTP health check.
TCP health checks require a successful TCP handshake. See the
[health-check reference](https://docs.digitalocean.com/products/networking/load-balancers/how-to/manage/#health-checks).

## 7. One Host per volume

`/data/host.lock` is a lease with a heartbeat. A second Host pointed at the same
volume refuses to start and reports that another Host already holds it. The lease
goes stale after 60 seconds, so a Host that died without releasing it blocks its
own replacement for up to that long. That is expected; do not shorten it by
deleting the lock directory while a Host may still be running.

VERIFIED (`packages/hydra-host/src/registry/host-lock.ts:190`): startup also uses
`/data/host.lock.takeover` as an exclusive acquisition gate. Gate age never proves
that its creator stopped. Startup leaves an existing gate intact and fails after
bounded retries. A crash during acquisition can therefore require manual recovery.

If startup reports a held takeover gate:

1. Stop every Host and startup contender that can access this volume. Disable
   automatic restarts, including replacement containers on other machines.
2. Verify that no Host owner or startup attempt remains. A local PID check cannot
   establish this for a volume shared between containers or machines.
3. Remove only `/data/host.lock.takeover`, then start one Host. Keep
   `/data/host.lock` intact so its lease and heartbeat checks still apply.

VERIFIED (`packages/hydra-host/src/registry/host-lock.spec.ts`, test
`does not reclaim a paused contender gate and replace the successor lease`): a
paused acquisition keeps its gate even when the directory timestamp is old.

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
Keep the LUKS unlock secret outside both the droplet and its snapshots. Test a
restore by unlocking a snapshot on an isolated machine before relying on it.
Deleting a key file is not secure erasure on block storage or in old snapshots;
retain and retire snapshots under the same secret-handling policy as the volume.

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
coordinated change, not a rolling one. Close and fan out every open head
first: an upgraded node cannot use a head opened by the previous version. The
2.3.0 to 2.4.1 move has its own steps in
[hydra-2.4.1-upgrade-runbook.md](hydra-2.4.1-upgrade-runbook.md).

```bash
systemctl stop hydra-host                          # drains, up to 250s
docker rm hydra-host
docker create --name hydra-host ... <new digest>   # same flags, same volume
systemctl start hydra-host
```

After any change to the running version or scripts, review the binary and
update `src/services/hydra-host/reviewed-catalogue.ts` before placement. Press
**Check** on the node and confirm that its values match the reviewed record. See
[hydra-operations.md §2b](hydra-operations.md).

## Checklist

1. amd64 droplet, LUKS2 block-storage volume unlocked and mounted at
   `/mnt/hydra_data`, owned by `10001:10001`; unlock secret stored separately.
2. Blockfrost project id in a file, mode 600, owned by `10001:10001`. Host
   tokens in `/srv/hydra/host.env`, mode 600, owned by root.
3. Container run with `--network host`, `--stop-timeout 250`, `--restart no`.
4. systemd unit with `RequiresMountsFor` and `TimeoutStopSec=270`, enabled.
5. Cloud firewall: 8443 from the Control Plane load balancer, 8444 from the
   Exchange Plane load balancer, 5001-5032 from counterparties, and 22 from
   your administrative range.
6. Install `/usr/local/sbin/hydra-peer-firewall`. Run `baseline` before the
   Host starts. Run `refresh` on its timer and after membership changes.
7. Enable `hydra-peer-firewall-baseline.service`.
8. Install `/usr/local/sbin/hydra-peer-egress` and
   `/etc/default/hydra-peer-egress`. Run `baseline`, then `verify`.
9. Include `/etc/nftables.d/hydra-peer.nft` and
   `/etc/nftables.d/hydra-peer-egress.nft` from `/etc/nftables.conf`, after
   `flush ruleset`.
10. The Host unit runs `hydra-peer-firewall baseline` and
    `hydra-peer-egress baseline` as `ExecStartPre`.
11. Use separate TLS Control and Exchange Plane load balancers. Set TCP health
    checks on backend ports 8443 and 8444. Keep the local 401 request as a
    manual check.
12. Volume snapshots scheduled and restore tested; unlock secret and escrowed
    keys stored separately.

## Related

- [hydra-operations.md](hydra-operations.md): running heads day to day
- [hydra-host-native-mode.md](hydra-host-native-mode.md): running without a container
- [adr/0015-hydra-host-provisioning-and-exposure.md](adr/0015-hydra-host-provisioning-and-exposure.md): why the planes are split this way
