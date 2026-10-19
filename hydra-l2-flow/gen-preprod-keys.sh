#!/usr/bin/env bash
# One-shot: generate 2-party preprod cardano+hydra keys and the Blockfrost
# project file. Re-run is safe (skips anything that already exists).
set -euo pipefail
# Secrets below (Blockfrost key, Hydra signing keys) must be owner-only.
umask 077
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$REPO/hydra-l2-flow/preprod"
NATIVE_BIN="$REPO/hydra-l2-flow/.bin/hydra-node"
# Pinned by digest (multi-arch index of tag 10.6.2), so a moved tag cannot
# swap the image that generates signing keys. Re-pin when the tag changes.
CARDANO_IMAGE="ghcr.io/intersectmbo/cardano-node:10.6.2@sha256:c3cbc5aa0b758ba211567791539a67001e661fbe7a09275e37449e8b1252c4b2"
mkdir -p "$OUT"

# .env must already contain BLOCKFROST_API_KEY_PREPROD. Write the project
# file directly from the process env — never echo the key.
# (Note: `node -e` sets __dirname to the cwd, not the script's directory,
# so the env file path and output path are passed explicitly via argv.)
node -e '
const fs = require("fs");
const path = require("path");
const repoRoot = process.argv[1];
const outDir = process.argv[2];
require("dotenv").config({ path: path.join(repoRoot, ".env") });
const key = process.env.BLOCKFROST_API_KEY_PREPROD;
if (!key) { console.error("BLOCKFROST_API_KEY_PREPROD missing in .env"); process.exit(1); }
fs.writeFileSync(path.join(outDir, "blockfrost.txt"), key.trim());
console.log("wrote preprod/blockfrost.txt");
' "$REPO" "$OUT"

# Reset, so a value from the caller's environment cannot skip the check.
bin_checked=''
for party in purchasing selling; do
  if [ ! -f "$OUT/$party-cardano.sk" ]; then
    docker run --rm -v "$OUT:/keys" --entrypoint cardano-cli "$CARDANO_IMAGE" \
      address key-gen \
      --signing-key-file "/keys/$party-cardano.sk" \
      --verification-key-file "/keys/$party-cardano.vk"
    echo "generated $party-cardano.{sk,vk}"
  fi
  if [ ! -f "$OUT/$party-hydra.sk" ]; then
    # Verify (or download and verify) the pinned binary before it makes keys.
    # HYDRA_BIN_TAG is cleared so the check covers this exact $NATIVE_BIN.
    if [ -z "${bin_checked:-}" ]; then
      HYDRA_BIN_TAG='' NATIVE_BIN="$NATIVE_BIN" "$REPO/hydra-l2-flow/hydra-native.sh" bin
      bin_checked=1
    fi
    DYLD_FALLBACK_LIBRARY_PATH=/usr/lib "$NATIVE_BIN" gen-hydra-key --output-file "$OUT/$party-hydra"
    echo "generated $party-hydra.{sk,vk}"
  fi
done
# umask does not tighten files that already exist from an earlier run.
# cardano-cli writes its .sk as 0600 itself; on Linux Docker it may be root-owned.
chmod 600 "$OUT/blockfrost.txt" "$OUT"/*-hydra.sk

echo
echo "=== fund these via https://docs.cardano.org/cardano-testnets/tools/faucet (preprod) ==="
for party in purchasing selling; do
  addr="$(docker run --rm -v "$OUT:/keys" --entrypoint cardano-cli "$CARDANO_IMAGE" \
    address build --payment-verification-key-file "/keys/$party-cardano.vk" --testnet-magic 1)"
  echo "$party: $addr"
done
