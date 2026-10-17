# Upgrading a Hydra Host to a new release

A release of this project is one git tag, for example `0.30.0`. The tag builds
two images with the same version: the payment service and the Hydra Host. An
upgrade replaces the whole Host image: the Host code, its dependencies, the Node
runtime, etcd and `hydra-node`. The data volume stays.

The admin UI shows which release each part runs and the newest published
release. This guide is the procedure behind its **Update available** badge.

## How the version is shown

| Shown                          | Meaning                                                                     |
| ------------------------------ | --------------------------------------------------------------------------- |
| `0.29.0`                       | Built from the tag itself.                                                  |
| `0.29.0 + 5 commits (abc1234)` | Built 5 commits after the tag, at commit `abc1234`.                         |
| `abc1234`                      | The build reports a commit but no tag. It was built without the build args. |
| not reported                   | The image predates release reporting, or the Host was not checked yet.      |

The newest release comes from this repository's GitHub releases. The service
asks GitHub at most once every six hours. Pre-releases count, because every
release so far is a pre-release. If GitHub has never answered, the UI shows
**not checked**. It never reports a build as up to date without an answer.
If a later check fails, the UI keeps the last answer.

A Host shows the release from its last **Check**. Press **Check** after every
redeploy.

## Before you start

1. **Read the release notes.** If the new release changes the `hydra-node`
   version, close and fan out every head on the Host first. An upgraded node
   cannot use a head opened by the previous version, and both sides of a head
   must run the same version. See
   [hydra-host-deploy-droplet.md §9](hydra-host-deploy-droplet.md) and, for
   2.3.0 to 2.4.1, [hydra-2.4.1-upgrade-runbook.md](hydra-2.4.1-upgrade-runbook.md).
   When the `hydra-node` version stays the same, open heads can stay open.
2. **Upgrade one Host at a time.** A Host serves its heads alone. While it is
   down, those heads stop, and the counterparty sees them stop too.
3. **Plan a short window.** See [How long a pause can last](#how-long-a-pause-can-last).

## The procedure

### 1. Pause the Host

In the admin UI, open the Host and press **Pause**. The pause moves through
these phases:

| Phase    | What happens                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------- |
| Draining | No new work starts on the Host's heads. Work already in flight (L2 locks, top-ups, withdrawals) finishes. |
| Stopping | The service asked the Host to stop the nodes. Each node first finishes its snapshot round.                |
| Paused   | Every node reports `Stopped`. No transaction can happen on these heads until Resume.                      |

The service moves the pause forward every 30 seconds. You can close the
browser. The pause survives restarts of the service and of the Host.

Wait for **Paused**. **Pause now** skips the wait for in-flight work. That work
then waits for Resume. Use it only when the in-flight work is stuck.

The API is `POST /hydra/host/pause`, `GET /hydra/host/pause` and
`POST /hydra/host/resume`.

### 2. Back up the volume

Take a snapshot of the Host's data volume while the nodes are stopped. A
snapshot of stopped nodes is a clean copy. A new `hydra-node` version can
migrate `hydra.db` on its first start, with no way back.

What a snapshot does and does not cover is in
[hydra-host-deploy-droplet.md §8](hydra-host-deploy-droplet.md).

### 3. Give the container time to stop

The Host waits for each node's snapshot round before it exits. That can take up
to 240 seconds (`SHUTDOWN_GRACE_MS`). The platform must not kill the container
before that.

| Platform       | Setting                                                                       |
| -------------- | ----------------------------------------------------------------------------- |
| Docker         | `--stop-timeout 250` on `docker create` or `docker run`.                      |
| Docker Compose | `stop_grace_period: 250s` on the service.                                     |
| Railway        | Service variable `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=250`. The default is 0. |
| Other          | The time between SIGTERM and SIGKILL. Set it to 250 seconds or more.          |

With the nodes already paused, the stop is fast. The setting protects you when
a node did not stop.

### 4. Redeploy the Host image

Use the image built from the new tag:
`ghcr.io/masumi-network/masumi-payment-service-hydra-host:<tag>`. Pin it by
digest. Keep every flag, variable and the same volume.

**Docker on a droplet**, from
[hydra-host-deploy-droplet.md §9](hydra-host-deploy-droplet.md):

```bash
systemctl stop hydra-host
docker rm hydra-host
docker create --name hydra-host ... <new image digest>
systemctl start hydra-host
```

**Railway.** In the Host service settings, change the source image to the new
tag or digest. Then deploy. The volume stays attached. A
service with a volume cannot run two deployments at once, so expect a short
downtime while the old deployment stops.

A Host built by Railway from this repository's Dockerfile needs the build args
from [packages/hydra-host/Dockerfile](../packages/hydra-host/Dockerfile) to
report its version. Without them it reports only its commit.

**Other platforms.** Replace the image, keep the volume mounted at `/data`, and
keep the environment.

After the redeploy, the nodes stay stopped. The pause stopped them, and the
Host remembers that on its volume.

### 5. Check the Host

Press **Check** on the Host. Confirm that the release shows the new version and
that the Host status is `Active`. If the `hydra-node` version changed, also
re-pin `HYDRA_EXPECTED_VERSION` and `HYDRA_EXPECTED_SCRIPT_CATALOGUE_HASH` in
the payment service. See [hydra-operations.md](hydra-operations.md).

### 6. Resume

Press **Resume**. The service starts exactly the nodes the pause stopped, then
accepts new work again. If a node does not start, the Host stays paused and you
can press **Resume** again.

Nodes that were already stopped before the pause are started too, because the
pause recorded every node that had a head.

A node reserved for an invite that nobody has redeemed yet has no head, so the
pause does not stop it. It keeps running, and the Host still accepts a
redemption. The redeemer can then post Init with this node in the head, while
the service records that head only after Resume. Before an upgrade, revoke the
invites that are still open on the Host, or wait until they are redeemed or
expire.

## How long a pause can last

Keep the pause as short as you can. Three limits apply:

- **The dispute window.** While the nodes are stopped, this side cannot contest
  a close. The window is 12 hours on preprod and 5 days on mainnet
  ([hydra-operations.md](hydra-operations.md)). A pause must stay well inside
  it.
- **Parked L2 actions.** An L2 action that cannot reserve its head stands down
  and tries again on a doubling schedule. After 12 attempts, a little over
  three hours, it is parked for manual action (`MAX_L2_ATTEMPTS` in
  `packages/payment-source-v2/src/services/l2-queue-rotation.ts`). A longer
  pause sends these requests to the manual-action queue.
- **The out-of-sync limit.** A node may fall 30 minutes behind the chain before
  it refuses to keep transacting. This guide does not verify how a node behaves
  after a longer stop. Aim to resume within 30 minutes.

## Upgrade the payment service too

The payment service image comes from the same tag:
`ghcr.io/masumi-network/masumi-payment-service:<tag>`. Its version shows on the
main page of the admin UI. Upgrade it the same way you deploy it today, and run
its database migrations as part of the deploy. See
[deployment.md](deployment.md).
