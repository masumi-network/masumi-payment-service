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
#   - A restart policy. The supervisor restarts individual hydra-node processes
#     itself, waiting out an in-flight snapshot round first, which a container
#     restart policy cannot do. Whether the CONTAINER restarts is the
#     orchestrator's call: see docs/hydra-host-deploy-droplet.md.

ARG HYDRA_VERSION=2.4.1
# History: at 2.3.0, hydra-node published exactly two static builds
# (x86_64-linux, aarch64-darwin) as GitHub Release zips, and the official
# ghcr image was a linux/amd64-only manifest. Building this image for arm64
# meant running the amd64 binary under Docker Desktop's emulation, where it
# died with SIGILL (exit 132, "Illegal instruction") the moment it touched
# its crypto path — `--version` worked, `--hydra-script-catalogue` did not.
#
# 2.4.0 changed both of those facts. Release zips stopped being published
# entirely (`gh release view 2.4.1 --repo cardano-scaling/hydra --json
# assets` -> `[]`, and the same for 2.4.0), and an official linux/arm64
# ghcr manifest was added instead — verified running natively on Apple
# Silicon with no SIGILL and no emulation shim needed
# (docs/hydra-2.4.1-upgrade-runbook.md, release evidence). So hydra-node now comes
# from that multi-arch image rather than a downloaded zip, pinned by digest
# below for supply-chain integrity — the digest IS the integrity pin, so
# there is no separate HYDRA_SHA256 to check the way 2.3.0 needed one for
# its zip. This image builds for both `linux/amd64` and `linux/arm64`:
# `docker build --platform linux/amd64,linux/arm64 ...`.
#
# Pin the multi-arch INDEX (manifest-list) digest, not a single-platform
# manifest digest: buildx resolves the right per-platform manifest out of an
# index digest for whichever --platform it is building, but a per-arch
# digest would pin one architecture regardless of --platform.
ARG HYDRA_IMAGE_DIGEST=sha256:608ae9b336209a18d7f3c42f7ca2d73c51dcb1b90732e533dd3b8017485fa98a
# Must match the etcd that hydra-node ships internally, confirmed by scanning
# the binary for its embedded go.etcd.io module versions: `v3.5.25`
# (unchanged from 2.3.0 — see docs/hydra-2.4.1-upgrade-runbook.md). Using
# --use-system-etcd with a mismatched build risks subtle raft
# incompatibilities. Declared here (before the first FROM) rather than next
# to where it's consumed in the `binaries` stage below: a Dockerfile ARG's
# default only survives into a later stage's bare `ARG NAME` redeclare if the
# default was set before the file's first FROM — set anywhere else, the
# redeclare silently picks up an empty string instead.
ARG ETCD_VERSION=3.5.25
ARG ETCD_SHA256_AMD64=168af82b59772e1811a9af7b358d42f5c6df44e0d9767afb006ecf12c4bbd607
ARG ETCD_SHA256_ARM64=419dce0b679df31cc45201ef2449b7a6a48e9d241af01741957c9ac86a35badc
FROM ghcr.io/cardano-scaling/hydra-node@${HYDRA_IMAGE_DIGEST} AS hydra-upstream

# ---------------------------------------------------------------------------
# Fetch the pinned etcd binary.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim@sha256:63a496b5d3b99214b39f5ed70eb71a61e590a77979c79cbee4faf991f8c0783e AS binaries
ARG ETCD_VERSION
ARG ETCD_SHA256_AMD64
ARG ETCD_SHA256_ARM64
ARG TARGETARCH

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl tar \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /out

RUN set -eux; \
	case "${TARGETARCH}" in \
		amd64) ETCD_SHA256="${ETCD_SHA256_AMD64}" ;; \
		arm64) ETCD_SHA256="${ETCD_SHA256_ARM64}" ;; \
		*) echo "no pinned etcd checksum for linux/${TARGETARCH}" >&2; exit 1 ;; \
	esac; \
	curl --proto '=https' --tlsv1.2 -fsSL -o etcd.tar.gz \
		"https://github.com/etcd-io/etcd/releases/download/v${ETCD_VERSION}/etcd-v${ETCD_VERSION}-linux-${TARGETARCH}.tar.gz"; \
	echo "${ETCD_SHA256}  etcd.tar.gz" | sha256sum -c -; \
	tar -xzf etcd.tar.gz --strip-components=1 \
		-C /out "etcd-v${ETCD_VERSION}-linux-${TARGETARCH}/etcd"; \
	chmod +x /out/etcd; \
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
# hydra-node's binary and (arch-conditionally) its nix store closure.
# ---------------------------------------------------------------------------
# hydra-node's build differs by arch, and so does what has to be copied for
# it to run — verified directly, not assumed, by extracting both real
# per-arch binaries and checking them with `file`/`objdump -p`:
#
#   amd64 (hydra-node-x86_64-unknown-linux-musl): fully STATIC — `file`
#     reports "statically linked", `objdump -p` shows no PT_INTERP segment
#     and zero NEEDED entries. Confirmed by running the extracted binary
#     alone in a bare debian:bookworm-slim container with no /nix anywhere
#     on the filesystem — it just runs. This is the same static build
#     2.3.0 shipped; nothing about how it's copied needs to change.
#   arm64 (hydra-node, no arch suffix in its derivation name): dynamically
#     linked against its own nix store closure — `objdump -p` shows a real
#     PT_INTERP plus 15 NEEDED entries (glibc, libsodium-vrf, blst, gmp, and
#     others, all under /nix/store). Copying just this ELF out, the way the
#     amd64 one can be, does not run: proven directly, the extracted binary
#     fails with a bare "not found" — not "cannot execute", not a linker
#     error — which is exactly the ENOENT a shell reports when a binary's
#     own interpreter path doesn't exist. The whole store (272 MiB,
#     measured) has to come along.
#
# `hydra-bin` below resolves the binary's path once (identical on both
# arches — only the derivation hash and suffix differ) and branches only on
# how to expose it: a plain copy for amd64, a symlink for arm64. Note the
# arm64 symlink does NOT survive as a symlink — BuildKit's COPY dereferences
# it into the runtime stage, so /usr/local/bin/hydra-node lands as a regular
# file and that image carries the binary twice (once in /nix/store, once
# here). Verified, and harmless: the dereferenced ELF still resolves its
# libraries from the closure copied below, which is why it runs. The store
# copy itself is isolated into `hydra-closure`, built two ways from an empty
# `scratch` base so the ${TARGETARCH} that doesn't need it pays nothing
# (copying "/" out of an untouched `scratch` stage copies 0 bytes) — this is
# the fix for a real amd64 correctness/size issue: an earlier version of
# this Dockerfile copied the whole store unconditionally on both arches,
# which put 272 MiB of nix-store content the amd64 build never touches
# (its binary needs none of it) into the primary production image. Measured
# net effect on an exported image, via `docker save`, comparing this fix
# against that earlier version with everything else held constant: ~12.6 MB
# smaller on amd64 — noticeably less than raw `du -sh /nix/store` (140.9
# MiB) would suggest, since most of that raw content compresses well in a
# layer and doesn't translate 1:1 into exported bytes. Report the exact
# figures measured for a given build rather than assuming this one.
# ponytail: arm64's copy is still the whole store rather than a computed
# minimal closure; revisit with `nix-store --export`/`nix copy --to` if 272
# MiB (uncompressed, on disk) becomes a real constraint.
FROM hydra-upstream AS hydra-bin
ARG TARGETARCH
RUN set -eux; \
	candidates="$(find /nix/store -maxdepth 3 -type f -path '*/bin/hydra-node' ! -path '*-exe-*')"; \
	count="$(printf '%s\n' "${candidates}" | sed '/^$/d' | wc -l)"; \
	if [ "${count}" -ne 1 ]; then \
		echo "expected exactly one hydra-node binary under /nix/store, found ${count}:" >&2; \
		printf '%s\n' "${candidates}" >&2; \
		exit 1; \
	fi; \
	case "${TARGETARCH}" in \
		amd64) cp "${candidates}" /hydra-node; chmod +x /hydra-node ;; \
		arm64) ln -s "${candidates}" /hydra-node ;; \
		*) echo "no hydra-node packaging rule for linux/${TARGETARCH}" >&2; exit 1 ;; \
	esac; \
	/hydra-node --version

FROM scratch AS hydra-closure-amd64
FROM scratch AS hydra-closure-arm64
COPY --from=hydra-upstream /nix /nix

ARG TARGETARCH
FROM hydra-closure-${TARGETARCH} AS hydra-closure

# ---------------------------------------------------------------------------
# Runtime.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim@sha256:a09aabc645e86e81e23dab78e0c0f2eaa233cab4277c7188232181a1a8bd5d39 AS runtime
ARG HYDRA_VERSION
ARG ETCD_VERSION

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=hydra-closure / /
COPY --from=hydra-bin /hydra-node /usr/local/bin/hydra-node

# etcd must be on PATH for --use-system-etcd, which keeps hydra-node from
# re-extracting its embedded copy into the persistence volume on every boot.
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
# (The /nix/store tree stays root-owned and world-readable — 555, verified —
# so the unprivileged user below can still execute hydra-node through it.)
RUN groupadd --system --gid 10001 hydra \
	&& useradd --system --uid 10001 --gid hydra --home-dir /app --shell /usr/sbin/nologin hydra \
	&& mkdir -p /data \
	&& chown -R hydra:hydra /data /app

# Durable state lives here and nowhere else, so the image stays
# orchestrator-agnostic: a droplet bind mount today, a PVC under DOKS later.
VOLUME ["/data"]
EXPOSE 8443 8444

# SIGTERM reaches the supervisor directly. It waits out each node's in-flight
# snapshot round, then stops the node process. That wait is what this codebase
# calls a drain, and it is NOT the API drain that removes a node: heads stay
# open, the desired state is untouched, and a restart brings every node back.
# Run with a generous --stop-timeout (Docker's 10s default would SIGKILL
# mid-round).
STOPSIGNAL SIGTERM
WORKDIR /app
USER hydra
ENTRYPOINT ["node", "dist/index.js"]
