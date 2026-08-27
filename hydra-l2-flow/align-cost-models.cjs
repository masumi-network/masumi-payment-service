#!/usr/bin/env node
/**
 * Align the devnet Hydra head's Plutus cost models with the EXACT arrays bundled
 * by the V2 mesh line (@meshsdk/core@1.9.0-beta.102). The demo's cardano-node
 * emits an older PlutusV3 cost model (251 params) while mesh — and preprod, which
 * the deployed V2 contract was built against — use the newer 297-param model.
 * That length/value gap is what makes every in-head script-spending tx fail with
 * `PPViewHashesDontMatch` (head expects its 251-param hash, mesh produces the
 * 297-param hash). Overwriting the head's `--ledger-protocol-parameters` cost
 * models with mesh's bundled arrays makes the devnet head behave like preprod, so
 * the head's expected script-data-hash equals what the V2 builder produces.
 *
 * Devnet-only: this rewrites the demo's protocol-parameters.json. It does NOT
 * touch any Masumi service code, mesh version, or contract address.
 *
 * Usage: node align-cost-models.cjs <protocol-parameters.json> [<repoRoot>]
 */
const fs = require('node:fs');
const path = require('node:path');

const paramsPath = process.argv[2];
const repoRoot = process.argv[3] || path.resolve(__dirname, '..');
if (!paramsPath) {
  console.error('[align-cost-models] missing protocol-parameters.json path');
  process.exit(1);
}

// Resolve the V2 mesh line's bundled cost models — the same source
// @meshsdk/core-cst hashes the script-data against. Resolve it from the
// packages/payment-source-v2 package context so we always pick up whatever V2
// mesh version that package currently pins (beta.102, .103, …) instead of a
// hardcoded path that breaks on every mesh bump. Values are identical across
// module instances; only array identity differs, which does not matter here.
const V2_PKG_DIR = path.join(repoRoot, 'packages/payment-source-v2');
let mesh;
let COMMON_CJS;
try {
  // @meshsdk/common is a transitive dep (via @meshsdk/core), so resolve core
  // from the V2 package first, then resolve common from core's own location —
  // that lands on the exact common version the V2 mesh line bundles.
  const coreMain = require.resolve('@meshsdk/core', { paths: [V2_PKG_DIR] });
  COMMON_CJS = require.resolve('@meshsdk/common', { paths: [path.dirname(coreMain)] });
  mesh = require(COMMON_CJS);
} catch (e) {
  console.error('[align-cost-models] cannot resolve @meshsdk/common via @meshsdk/core from', V2_PKG_DIR, '-', e.message);
  process.exit(1);
}

const toNums = (a) => a.map((x) => Number(x));
const v1 = toNums(mesh.DEFAULT_V1_COST_MODEL_LIST);
const v2 = toNums(mesh.DEFAULT_V2_COST_MODEL_LIST);
const v3 = toNums(mesh.DEFAULT_V3_COST_MODEL_LIST);

const params = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
const before = params.costModels && params.costModels.PlutusV3 ? params.costModels.PlutusV3.length : 'none';
params.costModels = { ...(params.costModels || {}), PlutusV1: v1, PlutusV2: v2, PlutusV3: v3 };
fs.writeFileSync(paramsPath, JSON.stringify(params, null, 2));

console.log(
  `[align-cost-models] ${paramsPath}: PlutusV3 ${before} -> ${v3.length} (V1=${v1.length} V2=${v2.length}); aligned to ${path.relative(repoRoot, COMMON_CJS)}`,
);
