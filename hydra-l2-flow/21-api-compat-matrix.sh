#!/usr/bin/env bash
#
# 21-api-compat-matrix.sh — prove that the same POST /payment and POST /purchase
# calls run on L1 or L2 with nothing but the optional forceLayer field changed.
# Three cases: forceLayer "L1", "Hydra", and omitted (automatic routing, which
# picks the Open head). Records the layer the resulting purchase reports.
#
# Preconditions: service on :3011, an Open head, the M4 agent registered
# (m4-agent-identifier.txt), buyer funded in-head (~15 ADA) and on L1 (~15 ADA).
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$REPO" || exit 1
API=http://127.0.0.1:3011/api/v1
KEY="$(cat hydra-l2-flow/.native-state/m4-api-key.txt)"
AGENT="$(cat hydra-l2-flow/.native-state/m4-agent-identifier.txt)"
# M4_MATRIX_OUT lets another evidence run (the identity run) reuse these exact
# requests without truncating the committed api-compat/cases.json below.
OUT="${M4_MATRIX_OUT:-$REPO/hydra-l2-flow/evidence/2026-m4-preprod/api-compat}"
mkdir -p "$OUT"; : > "$OUT/cases.json"

# The M4 agent (Task 5 Step 1) advertises exactly one supportedPaymentSources
# entry, at index 0. POST /payment REQUIRES supportedPaymentSourceIndex for a
# Web3CardanoV2 payment source (src/routes/api/payments/index.ts:180-184: "V2
# Cardano payments require supportedPaymentSourceIndex to select a priced
# Cardano source"), and the value is signed into the blockchainIdentifier
# (payments/index.ts:320). POST /purchase must echo the SAME value
# (src/routes/api/purchases/shared.ts:269 reconstructs the signed payload from
# it directly, unconditionally) or the signature check fails with 400. The
# payment response does not expose supportedPaymentSourceIndex — it is not a
# field of paymentResponseSchema in src/routes/api/payments/schemas.ts — so it
# cannot be copied from the response; both requests hardcode the same index.
SPSI=0

# POST /payment takes ISO-8601 dates (ez.dateIn). The purchase must then echo the
# seller's signed terms exactly as the payment RESPONSE returns them, which is
# unix-milliseconds strings — so never recompute them, copy them.
iso_in(){ node -pe "new Date(Date.now() + $1*60*1000).toISOString()"; }

run_case(){ # $1 = label, $2 = forceLayer JSON value ("\"L1\"", "\"Hydra\"" or null)
  local label="$1" force="$2"
  local pay_by; pay_by="$(iso_in 10)"; local submit; submit="$(iso_in 25)"; local unlock; unlock="$(iso_in 60)"; local dispute; dispute="$(iso_in 120)"
  local idp; idp="$(head -c 13 /dev/urandom | xxd -p)"     # <= 26 hex chars
  # xxd -p wraps at 30 bytes (60 hex chars) on macOS, so 32 bytes would split
  # across two lines and corrupt the JSON string below; force a single line.
  local input_hash; input_hash="$(head -c 32 /dev/urandom | xxd -p -c 64)"
  local force_field=""; [ "$force" != null ] && force_field=", \"forceLayer\": $force"

  local payment; payment="$(curl -s -X POST -H "token: $KEY" -H 'content-type: application/json' "$API/payment" -d "{
    \"network\": \"Preprod\", \"agentIdentifier\": \"$AGENT\", \"paymentSourceType\": \"Web3CardanoV2\",
    \"supportedPaymentSourceIndex\": $SPSI,
    \"inputHash\": \"$input_hash\", \"identifierFromPurchaser\": \"$idp\",
    \"payByTime\": \"$pay_by\", \"submitResultTime\": \"$submit\", \"unlockTime\": \"$unlock\", \"externalDisputeUnlockTime\": \"$dispute\"
    $force_field }")"
  local bid; bid="$(jq -r '.data.blockchainIdentifier // empty' <<<"$payment")"
  if [ -z "$bid" ]; then jq -n --arg l "$label" --arg e "$payment" '{case:$l, step:"payment", error:$e}' >> "$OUT/cases.json"; return 1; fi

  # The blockchainIdentifier is the seller's signature over these fields, and the
  # signed payload includes the seller's forceLayer, which the purchase must carry
  # as paymentForceLayer (src/routes/api/purchases/shared.ts).
  local pfl; pfl="$(jq -r '.data.forceLayer // empty' <<<"$payment")"
  # The payment response has no top-level `network` or `identifierFromPurchaser`
  # field (network only appears nested under PaymentSource.network; the nonce is
  # never echoed at all) — jq's object-construction shorthand silently turns a
  # missing key into `null` rather than erroring, so pulling them from `.data`
  # always produced a request with network=null, identifierFromPurchaser=null,
  # rejected 400 by the zod schema. purchases/shared.ts:214 also requires
  # identifierFromPurchaser to equal the exact value embedded in the payment's
  # signed blockchainIdentifier, i.e. the SAME $idp this case already sent when
  # creating the payment — so it must come from here, not from the response.
  local purchase; purchase="$(jq -c --argjson spsi "$SPSI" --arg idp "$idp" '.data | {
      network: "Preprod", blockchainIdentifier, agentIdentifier, inputHash, identifierFromPurchaser: $idp,
      payByTime, submitResultTime, unlockTime, externalDisputeUnlockTime,
      sellerVkey: .SmartContractWallet.walletVkey,
      Amounts: [.RequestedFunds[] | {unit, amount}],
      supportedPaymentSourceIndex: $spsi
    }' <<<"$payment")"
  [ "$force" != null ] && purchase="$(jq -c --argjson f "$force" '. + {forceLayer: $f}' <<<"$purchase")"
  [ -n "$pfl" ] && purchase="$(jq -c --arg p "$pfl" '. + {paymentForceLayer: $p}' <<<"$purchase")"
  local created; created="$(curl -s -X POST -H "token: $KEY" -H 'content-type: application/json' "$API/purchase" -d "$purchase")"
  local pid; pid="$(jq -r '.data.id // empty' <<<"$created")"
  if [ -z "$pid" ]; then jq -n --arg l "$label" --arg e "$created" '{case:$l, step:"purchase", error:$e}' >> "$OUT/cases.json"; return 1; fi

  # Wait for the cron to lock the funds and report the layer it used.
  # GET /purchase defaults to filterPaymentSourceType=Web3CardanoV1 when no V2-
  # aware filter is given (resolvePurchasePaymentSourceTypeFilter in
  # src/routes/api/purchases/queries.ts, mirrors the registry's default) — our
  # M4 agent is V2, so without this filter the row never appears and every
  # case times out at 600s regardless of what actually happened on chain.
  local layer="" state="" tx=""
  for _ in $(seq 1 60); do
    local row; row="$(curl -s -H "token: $KEY" "$API/purchase?network=Preprod&limit=50&filterPaymentSourceType=Web3CardanoV2" | jq -c --arg id "$pid" '.data.Purchases[] | select(.id==$id)')"
    state="$(jq -r '.onChainState // ""' <<<"$row")"; layer="$(jq -r '.CurrentTransaction.layer // ""' <<<"$row")"; tx="$(jq -r '.CurrentTransaction.txHash // ""' <<<"$row")"
    [ "$state" = "FundsLocked" ] && break; sleep 10
  done
  jq -n --arg l "$label" --arg f "$force" --arg id "$pid" --arg s "$state" --arg layer "$layer" --arg tx "$tx" \
    '{case:$l, forceLayer:$f, purchaseId:$id, onChainState:$s, layer:$layer, txHash:$tx}' >> "$OUT/cases.json"
  echo "$label: forceLayer=$force -> layer=$layer state=$state tx=$tx"
}

# M4_MATRIX_CASES=l2 skips the L1 case for runs that only need in-head purchases.
[ "${M4_MATRIX_CASES:-all}" = l2 ] || run_case "forceLayer L1"     '"L1"'
run_case "forceLayer Hydra"  '"Hydra"'
run_case "forceLayer omitted" null

{
  echo '# API compatibility matrix (preprod)'; echo
  echo "Generated $(date -u +%Y-%m-%dT%H:%M:%SZ). Same endpoints, same bodies; only the optional \`forceLayer\` field differs."; echo
  echo '| Case | forceLayer sent | Layer chosen by the service | State | Tx |'; echo '|---|---|---|---|---|'
  jq -r 'select(.layer!=null) | "| \(.case) | \(.forceLayer) | \(.layer) | \(.onChainState) | `\(.txHash[0:16])…` |"' "$OUT/cases.json"
} > "$OUT/MATRIX.md"
cat "$OUT/MATRIX.md"
