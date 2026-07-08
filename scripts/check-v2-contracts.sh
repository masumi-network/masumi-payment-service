#!/usr/bin/env bash
# Verify V2 Aiken contracts: pinned compiler matches plutus.json and all tests pass.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

check_project() {
  local dir="$1"
  local expected
  expected="$(grep '^compiler' "$dir/aiken.toml" | sed -E 's/.*"(v[^"]+)".*/\1/')"
  local actual
  actual="$(python3 - <<PY
import json
print(json.load(open("$dir/plutus.json"))["preamble"]["compiler"]["version"].split("+")[0])
PY
)"
  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: $dir/plutus.json compiler is $actual but aiken.toml pins $expected"
    echo "       Run: cd $dir && aikup install $expected && aiken build"
    exit 1
  fi
  if ! command -v aiken >/dev/null; then
    echo "ERROR: aiken is not on PATH. Run: aikup install $expected"
    exit 1
  fi
  local running
  running="$(aiken --version | awk '{print $2}' | cut -d+ -f1)"
  if [[ "$running" != "$expected" ]]; then
    echo "ERROR: running aiken is $running but $dir/aiken.toml pins $expected"
    echo "       Building or checking with a different compiler silently changes"
    echo "       the script hash and contract address. Run: aikup install $expected"
    exit 1
  fi
  echo "==> aiken check $dir (compiler $expected)"
  (cd "$dir" && aiken check)
  # Freshness: a stale committed plutus.json (validator source edited without
  # re-running `aiken build`) passes the version checks above while shipping a
  # blueprint that no longer matches the source. Rebuild and byte-compare.
  local backup
  backup="$(mktemp)"
  cp "$dir/plutus.json" "$backup"
  echo "==> aiken build $dir (verify committed plutus.json is fresh)"
  (cd "$dir" && aiken build >/dev/null)
  if ! cmp -s "$dir/plutus.json" "$backup"; then
    cp "$backup" "$dir/plutus.json"
    rm -f "$backup"
    echo "ERROR: $dir/plutus.json is stale — a fresh 'aiken build' produces different output"
    echo "       Run: cd $dir && aiken build   (then commit plutus.json; script hash"
    echo "       and derived contract addresses change — see the migration runbook)"
    exit 1
  fi
  rm -f "$backup"
}

check_project "$ROOT/smart-contracts/payment-v2"
check_project "$ROOT/smart-contracts/registry-v2"
echo "V2 contract checks passed."
