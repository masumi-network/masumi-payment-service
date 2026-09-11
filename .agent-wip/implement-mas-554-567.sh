#!/usr/bin/env bash
# Helper script - not committed
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=/Users/isaacadebayo/Documents/nmkr/masumi-payment-service
cd "$REPO"

push_ticket() {
  local branch="$1"
  local msg="$2"
  shift 2
  git checkout dev
  git pull origin dev
  git checkout -B "$branch"
  git add "$@"
  git commit -m "$msg"
  git push -u origin "$branch" --force-with-lease
}

echo "Run individual ticket implementations manually"
