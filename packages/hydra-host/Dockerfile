# check=skip=InvalidBaseImagePlatform
# Hydra Host — supervises one hydra-node process per Hydra Head and fronts them
# with a token-gated control plane.
#
# The entrypoint is the supervisor, NOT hydra-node: this container's job is
# process supervision, not being a single node.
#
# Deliberately absent:
#   - TLS / ACME. Termination happens at a load balancer or ingress; keeping
#     certificate state out means the container has exactly one thing needing
#     durable storage.
#   - A restart policy. Restarts belong to the supervisor, which drains a
#     snapshot round before stopping; Docker's would not.

ARG HYDRA_VERSION=2.3.0
ARG HYDRA_SHA256=89e84b5005154a6275ee171e432db38084777a5d3d02aa72d3562d827f76a456
# Must match the etcd that hydra-node ships internally, confirmed by running the
# binary's own extracted copy: `etcd Version: 3.5.25`. Using --use-system-etcd
# with a mismatched build risks subtle raft incompatibilities.
ARG ETCD_VERSION=3.5.25
ARG ETCD_SHA256=168af82b59772e1811a9af7b358d42f5c6df44e0d9767afb006ecf12c4bbd607

# ---------------------------------------------------------------------------
# Fetch the pinned hydra-node and etcd binaries.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim@sha256:63a496b5d3b99214b39f5ed70eb71a61e590a77979c79cbee4faf991f8c0783e AS binaries
ARG HYDRA_VERSION
ARG HYDRA_SHA256
ARG ETCD_VERSION
ARG ETCD_SHA256
ARG TARGETARCH

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl unzip tar \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /out

# hydra-node publishes exactly two static builds: x86_64-linux and
# aarch64-darwin. There is NO linux/arm64 release, so this image is
# linux/amd64 only — build it with `--platform linux/amd64`.
#
# Note for local testing on an arm64 Mac: the image builds and the control
# plane runs, but hydra-node dies with SIGILL (exit 132, "Illegal instruction")
# the moment it touches its crypto path under Docker Desktop's emulation —
# `--version` succeeds, `--hydra-script-catalogue` does not. Observed directly,
# and it is why hydra-l2-flow runs the binary natively on Darwin. Anything that
# spawns a real node must be tested on amd64 hardware.
RUN set -eux; \
	case "${TARGETARCH}" in \
		amd64) HYDRA_ASSET="hydra-x86_64-linux-${HYDRA_VERSION}.zip"; ETCD_ARCH="amd64" ;; \
		*) echo "hydra-node publishes no linux/${TARGETARCH} build; this image is linux/amd64 only" >&2; exit 1 ;; \
	esac; \
	curl --proto '=https' --tlsv1.2 -fsSL -o hydra.zip \
		"https://github.com/cardano-scaling/hydra/releases/download/${HYDRA_VERSION}/${HYDRA_ASSET}"; \
	echo "${HYDRA_SHA256}  hydra.zip" | sha256sum -c -; \
	unzip -j hydra.zip -d /out; \
	curl --proto '=https' --tlsv1.2 -fsSL -o etcd.tar.gz \
		"https://github.com/etcd-io/etcd/releases/download/v${ETCD_VERSION}/etcd-v${ETCD_VERSION}-linux-${ETCD_ARCH}.tar.gz"; \
	echo "${ETCD_SHA256}  etcd.tar.gz" | sha256sum -c -; \
	tar -xzf etcd.tar.gz --strip-components=1 \
		-C /out "etcd-v${ETCD_VERSION}-linux-${ETCD_ARCH}/etcd"; \
	chmod +x /out/hydra-node /out/etcd; \
	/out/hydra-node --version; \
	/out/etcd --version

# ---------------------------------------------------------------------------
# Build the control plane.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim@sha256:a09aabc645e86e81e23dab78e0c0f2eaa233cab4277c7188232181a1a8bd5d39 AS control-plane
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm-workspace.yaml declares patchedDependencies, and pnpm hashes those patch
# files during install even for an unrelated filtered package. Without them the
# install fails with ENOENT on the patch.
COPY patches ./patches
COPY packages/hydra-host/package.json packages/hydra-host/
RUN pnpm install --filter @masumi/hydra-host --frozen-lockfile
COPY packages/hydra-host ./packages/hydra-host
COPY tsconfig.json ./
RUN pnpm --filter @masumi/hydra-host run build

# ---------------------------------------------------------------------------
# Runtime.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim@sha256:a09aabc645e86e81e23dab78e0c0f2eaa233cab4277c7188232181a1a8bd5d39 AS runtime
ARG HYDRA_VERSION
ARG ETCD_VERSION

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# etcd must be on PATH for --use-system-etcd, which keeps hydra-node from
# re-extracting its embedded copy into the persistence volume on every boot.
COPY --from=binaries /out/hydra-node /usr/local/bin/hydra-node
COPY --from=binaries /out/etcd /usr/local/bin/etcd
COPY --from=control-plane /build/packages/hydra-host/dist /app/dist
COPY --from=control-plane /build/node_modules /app/node_modules
# Ledger protocol parameters are generated at build time from the mesh version
# pinned by packages/payment-source-v2, so the head ledger cannot drift from the
# transactions the payment service builds.
COPY packages/hydra-host/params /opt/hydra/params

ENV NODE_ENV=production \
	HYDRA_HOST_DATA_DIR=/data \
	HYDRA_HOST_PORT=8443 \
	HYDRA_NODE_BIN=/usr/local/bin/hydra-node \
	HYDRA_VERSION=${HYDRA_VERSION} \
	ETCD_VERSION=${ETCD_VERSION}

# Run unprivileged: the supervisor and every hydra-node it spawns write keys and
# persistence into /data, and there is no reason for any of that to be uid 0.
RUN groupadd --system --gid 10001 hydra \
	&& useradd --system --uid 10001 --gid hydra --home-dir /app --shell /usr/sbin/nologin hydra \
	&& mkdir -p /data \
	&& chown -R hydra:hydra /data /app

# Durable state lives here and nowhere else, so the image stays
# orchestrator-agnostic: a droplet bind mount today, a PVC under DOKS later.
VOLUME ["/data"]
EXPOSE 8443 8444

# SIGTERM reaches the supervisor directly, which drains every node before
# exiting. Run with a generous --stop-timeout (Docker's 10s default would
# SIGKILL mid-drain).
STOPSIGNAL SIGTERM
WORKDIR /app
USER hydra
ENTRYPOINT ["node", "dist/index.js"]
