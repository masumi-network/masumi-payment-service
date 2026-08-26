#!/usr/bin/env bash
# Run the REAL Masumi payment service against the Hydra preprod DEMO env
# (fresh DB on :5434 + local Hydra head wiring). Exports .env.hydra-demo so its
# values win over the committed .env (dotenv does not override process.env), so
# your normal dev .env is left untouched.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
[ -f .env.hydra-demo ] || { echo "missing .env.hydra-demo"; exit 1; }
set -a; # shellcheck disable=SC1091
source .env.hydra-demo; set +a
echo "payment node → DB $DATABASE_URL"
echo "hydra local $HYDRA_NODE_URL  remote $HYDRA_REMOTE_NODE_URL"
exec pnpm dev
