#!/usr/bin/env bash
# One-shot: generate 2-party preprod cardano+hydra keys and the Blockfrost
# project file. Re-run is safe (skips anything that already exists).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$REPO/hydra-l2-flow/preprod"
NATIVE_BIN="$REPO/hydra-l2-flow/.bin/hydra-node"
CARDANO_IMAGE="ghcr.io/intersectmbo/cardano-node:10.6.2"
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

for party in purchasing selling; do
  if [ ! -f "$OUT/$party-cardano.sk" ]; then
    docker run --rm -v "$OUT:/keys" --entrypoint cardano-cli "$CARDANO_IMAGE" \
      address key-gen \
      --signing-key-file "/keys/$party-cardano.sk" \
      --verification-key-file "/keys/$party-cardano.vk"
    echo "generated $party-cardano.{sk,vk}"
  fi
  if [ ! -f "$OUT/$party-hydra.sk" ]; then
    DYLD_FALLBACK_LIBRARY_PATH=/usr/lib "$NATIVE_BIN" gen-hydra-key --output-file "$OUT/$party-hydra"
    echo "generated $party-hydra.{sk,vk}"
  fi
done

echo
echo "=== fund these via https://docs.cardano.org/cardano-testnets/tools/faucet (preprod) ==="
for party in purchasing selling; do
  addr="$(docker run --rm -v "$OUT:/keys" --entrypoint cardano-cli "$CARDANO_IMAGE" \
    address build --payment-verification-key-file "/keys/$party-cardano.vk" --testnet-magic 1)"
  echo "$party: $addr"
done
