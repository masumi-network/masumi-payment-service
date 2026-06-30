# Hydra L2 (V2) — devnet findings & open decisions

Status: **decision needed** (two architecture calls for the senior)
Branch: `gd/impl-hydra`
Date: 2026-06-07

This documents what was verified by running the Hydra L2 V2 re-target against a
live Hydra devnet, and the two blockers that stop a full in-head escrow E2E.
Both blockers are product/architecture decisions, not coding bugs.

---

## 1. Context

Per the senior's ruling, Hydra L2 is **V2-only**; V1 Hydra was removed. The
re-target uses the "minimal plan" (Hydra lib + connection-manager stay at repo
root; V2 builders gain an `isHydra` path). See
`docs/adr/0005-meshsdk-version-pinning-v1-v2.md`.

A local Hydra devnet (official `cardano-scaling/hydra` demo: 1 cardano-node + 3
hydra-nodes, ports `4001/4002/4003`) was brought up to validate the integration.
See the team memory `hydra-devnet-bringup` for the exact bring-up steps.

## 2. What is verified working ✅

- **Devnet**: cardano-node forging, 3 hydra-nodes serving the API; head opens.
- **masumi `HydraNode` against the live node**: WS connect + `Greetings`/status
  parsing; `fetchProtocolParameters()` + `castProtocol()` parse the real
  zero-fee head params (the exact path the V2 `isHydra` fee-bypass relies on).
- **`HydraNode.init()` robustness fix** (`src/lib/hydra/hydra/node.ts`): it
  previously hung forever when hydra-node 2.1.0 fast-forwarded past
  `HeadIsInitializing` to `HeadIsOpen` on a `?history=no` socket. Now guards on
  current status and also resolves on `HeadIsOpen`/`Greetings`. +4 unit tests;
  verified live (resolves ~1ms vs 30s hang). 180/180 Hydra tests pass.
- **Seed re-targeted to V2** (`prisma/seed.ts`): the `HydraRelation` +
  participants + head now attach to the **Web3CardanoV2** PaymentSource (was
  V1). Verified on a disposable DB: the relation's local hot wallet resolves to
  `Web3CardanoV2 Preprod`.

## 3. Blocker 1 — heads open EMPTY; no fund-entry path 🔴

`src/routes/api/hydra/head/index.ts:400` commits an **empty** UTxO set:

```ts
const commitTx = await hydraHead.commit([], null, localParticipant.walletId);
```

- It is the **only** caller of `.commit(...)`; it always passes `[]`.
- There is **no deposit / incremental-commit endpoint** and no auto-commit of
  wallet funds anywhere in the codebase.

**Consequence:** masumi can open a head, but **no buyer funds ever enter it**.
The L2 lock path spends the buyer's *in-head* UTxOs — which never exist. A full
in-head escrow (lock → submit-result → collect) is therefore **impossible with
the current code**, independent of finishing the L2 service wiring.

**Decision needed — how do funds enter a head?**
- **Option A — real initial commit:** populate `commit(...)` with the
  committing wallet's L1 UTxOs (each party commits their own funds before the
  head opens). Simple, but the head must be re-opened to change committed funds,
  and it pulls in Blocker 2 (which L1 provider supplies those UTxOs).
- **Option B — incremental commit (deposit):** add a deposit endpoint so funds
  can enter an already-open head (hydra-node 2.x supports `--deposit-period`,
  which is configured in the demo). More flexible, more work.

## 4. Blocker 2 — L1 provider mismatch (Blockfrost vs devnet) 🔴

masumi uses `BlockfrostProvider` for all L1 work. A real commit (Blocker 1,
Option A) needs the committing wallet's **L1 UTxOs** and must **submit the commit
tx to L1**. On this devnet, L1 is the local cardano-node (network magic 42) —
**Blockfrost cannot see it**. So a real commit against the devnet cannot use the
normal Blockfrost path.

**Decision needed — how is L1 reached for head open/commit on a devnet?**
- Point masumi's L1 provider at the devnet (a Blockfrost-compatible shim, or a
  cardano-node-backed provider) for head lifecycle ops; **or**
- Test the head lifecycle against **real preprod hydra-nodes** (preprod L1 that
  Blockfrost can see) instead of the local devnet; **or**
- Keep masumi's L1 ops on Blockfrost/preprod and only use the local devnet for
  pure in-head L2 validation (commit funds out-of-band via the devnet's own
  tooling).

Note: pure **L2** ops (newTx/snapshot/protocol-parameters) already go through
`HydraProvider`, not Blockfrost, and are fine on the devnet — the mismatch is
specifically the L1 commit/open step.

## 5. Decisions taken + build status (2026-06-07)

Decisions (owner): **complete Hydra inside V2** + **real initial commit** for
fund-entry. Code built against those:

- **Fund-entry (Blocker 1 → real commit):** the head `commit` endpoint
  (`src/routes/api/hydra/head/index.ts`) now loads the local participant's
  wallet + L1 provider, commits the wallet's L1 UTxOs, signs, and submits the
  commit tx to L1 (previously it built an empty commit and never submitted it).
- **V2 L2 lock path:** `purchases/batch-payments/l2-lock.ts` — an ISOLATED
  beta.102 path (`asV2Provider` bridge) that routes FundsLockingRequested
  requests through an open head when one exists, leaving the L1 money-safety
  machinery untouched. Wired as a pre-pass in `batchLatestPaymentEntriesV2`.
- **L2 lifecycle services:** `submit-result` (reference) plus L2 single-item
  paths added to `authorize-refund`, `collection`, `request-refund`,
  `collect-refund`, `authorize-withdrawal` (each gated by `layer: L2`).

Status: typecheck clean, 576/576 unit tests pass, lint clean. **Not yet run
on-chain.**

## 5a. Remaining gate — Blocker 2 (L1 provider for devnet) still open

The full in-head E2E still cannot run against the **local devnet** because the
commit fetches L1 UTxOs + submits via **Blockfrost**, which cannot see the
devnet L1 (magic 42). To execute the E2E either:
- run masumi against **real preprod** hydra-nodes (Blockfrost-visible L1), or
- add a devnet-capable L1 provider for the commit/open step, or
- commit funds out-of-band via the devnet's own tooling and exercise only the
  pure-L2 escrow txs (lock/submit/collect via `HydraProvider`).

## 5b. E2E run via masumi services against the devnet (2026-06-08)

Drove masumi's **own L2 service code** (not raw provider calls) against the
dockerised devnet with a seeded disposable DB (the repo's e2e pattern). Steps in
`hydra-l2-flow/*.mts`: seed test DB → fund the buyer wallet on devnet L1 →
give buyer + seller in-head funds via plain L2 transfers → mark head Open +
connect the connection manager → create requests → call the real service fns.

**Blockfrost commit caveat (refines §5a):** the head `commit` endpoint now
SUBMITS via the hydra-node's `/cardano-transaction` (works on any L1 — fixed),
but it still FETCHES the wallet's L1 UTxOs via Blockfrost. On the devnet
(magic 42, Blockfrost-invisible) the fetch returns nothing, so the commit
endpoint can't be exercised there. It is correct for a real preprod head. For
the devnet e2e, funds were put in-head out-of-band (L2 transfer) instead.

**✅ L2 funds-lock — PASSED end-to-end via `processL2PurchaseLocks()`.** Request
advanced to `FundsLockingInitiated` (`layer=L2`); the FundsLocked datum + funds
landed at the script address in the head.

**🐛 Bug found + fixed (only surfaced by running it):** `l2-lock.ts` called the
synchronous `MeshWallet.getUsedAddress()` on a freshly-constructed wallet. In
mesh beta.102 that throws `bech32.decode input: string expected` — the wallet
must be initialised first (the async address API does that, as
`generateWalletExtended` relies on). The L2 lock would have failed every time in
production. Fixed by priming via `await wallet.getUnusedAddresses()` first.
Unit tests + typecheck could not catch this (type-correct; runtime-only).

**🔴 L2 submit-result — blocked on tx validity windows (slot config).** After
setting up the seller side, the contract-UTxO matcher passed and
`processL2SubmitResult` built + submitted a tx (with the Plutus script) into the
head, but the head ledger rejected it:

```
OutsideValidityIntervalUTxO (ValidityInterval {invalidBefore=125214045,
  invalidHereafter=125214676}) (SlotNo 69808)
```

Root cause: `createTxWindow(network, …)` converts wall-clock deadlines to slots
using **preprod's** static slot config (`SLOT_CONFIG_NETWORK['preprod']`,
slot ≈ 125M), but the head runs on the **devnet's** slot timeline (current slot
≈ 70k). The lock path works precisely because it omits validity windows; the
seller-side L2 paths (`submit-result`, `collection`, refunds, withdrawal) impose
L1-slot windows and so are rejected in-head.

Note: on a **real preprod** Hydra head the head settles on preprod L1, so head
slots = preprod slots and the existing `createTxWindow(preprod)` is correct — so
this is not necessarily a production bug, but L2 on any non-preprod head (incl.
this devnet) needs windows derived from the **head's own slot config**.

Two compounding devnet realities make submit-result un-validatable here:
1. **Slot-config mismatch:** devnet magic 42 genesis ≠ preprod; masumi has no
   way to obtain the head's slot config through its providers.
2. **Stalled L1:** the devnet cardano-node is frozen (slot 69808, `syncProgress`
   ~64%, no advance over 15s; chain-time ~1h20m behind wall-clock), so even the
   correct devnet slot config can't make a window valid — the window must anchor
   to the head's *current* slot, which isn't advancing.

**Recommendation:** validate L2 submit-result/collection against **real preprod
hydra-nodes** (head slots = preprod, chain at wall-clock, existing tx-window code
correct). Alternatively, implement L2-aware tx windows that derive from the
head's slot config + current head slot, and run on a healthy devnet.

## 5c. Slot-config fix + cost-model blocker (2026-06-08, continued)

Implemented the L2-aware tx-window fix and re-ran on a **freshly restarted,
healthy** devnet (the earlier one had stalled at slot 69808 with a zero forecast
horizon — `epochLength=5` — and could not accept any time-bounded tx):

- `createTxWindow` (`src/services/shared/tx-window.ts`) gained an optional
  `slotConfig` override (defaults to `SLOT_CONFIG_NETWORK[network]`, so L1 and
  preprod heads are unchanged).
- New `src/utils/hydra/l2-slot-context.ts` resolves the head's slot config +
  current-slot anchor + window buffers from env (devnet test hook; returns
  `undefined` → preprod path uses the network config + `Date.now()`).
- `processL2SubmitResult` passes that context into `createTxWindow`.

**Result — the slot-config fix works.** The submit-result rejection progressed
`OutsideValidityIntervalUTxO` (preprod slot ~125M) → `OutsideForecast`
(head-scale slot, stalled devnet) → on the healthy devnet, the timing errors are
**gone**. The tx now reaches the head's script-data-hash check.

**🔴 New blocker — `PPViewHashesDontMatch`.** The L2 submit-result tx's script
integrity hash (language views / cost models) does not match what the head's
ledger computes. `HydraProvider.fetchCostModels()` returns `[]` (mesh bundled
defaults), but the head expects ITS cost models (from its zero-fee
protocol-parameters). This is exactly the cost-model/script-data-hash concern in
`docs/adr/0005` / CLAUDE.md. Next step: have `HydraProvider.fetchCostModels()`
(and/or the V2 `isHydra` build path) supply the head's actual cost models so the
language-view hash matches — handled carefully, as cost-model changes affect the
script-data-hash the ledger checks.

Status of validated wins (build green, 597/597 tests, typecheck, lint):
- ✅ L2 funds-lock end-to-end via masumi services (+ wallet-init bug fixed).
- ✅ commit submit via `/cardano-transaction`.
- ✅ L2 tx-window slot-config fix (timing resolved).
- 🔴 L2 submit-result final gate: head cost-model script-data-hash.

Flow scripts: `hydra-l2-flow/00-open-head` … `06-submit-result`. Devnet slot env
for the test: `HYDRA_L2_SLOT_ZERO_TIME_MS`, `HYDRA_L2_SLOT_LENGTH_MS`,
`HYDRA_L2_CURRENT_SLOT` (+ optional buffer overrides).

## 5d. Cost-model fix — head-sourced script-data-hash (2026-06-09)

Implemented the `PPViewHashesDontMatch` fix. Root cause confirmed by reading
`@meshsdk/core-cst@1.9.0-beta.102`: the script-data-hash is computed from the
mesh line's **bundled** `DEFAULT_V*_COST_MODEL_LIST` arrays (`hashScriptData(...)`
in core-cst), **not** from `fetcher.fetchCostModels()`. So `HydraProvider.
fetchCostModels()` returning `[]` was never even consulted by the build — the L2
path simply built against mesh's stock cost models, which differ from the head's.

The L1 path already solves the equivalent problem by patching those bundled
arrays from Blockfrost (`syncMeshCostModelsFromChainV2`). The fix ports that
mechanism to L2, sourced from the head instead of Blockfrost:

- `HydraNode.fetchRawCostModels()` (+ `HydraProvider` delegate) reads the head's
  `/protocol-parameters` `costModels` field → `{ PlutusV1, PlutusV2, PlutusV3 }`
  (same shape Blockfrost returns under `cost_models_raw`).
- New `syncMeshCostModelsFromHeadV2(raw)` in
  `packages/payment-source-v2/src/utils/mesh-cost-model-sync.ts` splices those
  arrays into the **V2 mesh line's** bundled `DEFAULT_V*_COST_MODEL_LIST` under
  the existing replace-mutex.
- All six L2 script-spending service paths (submit-result, authorize-refund,
  collection, collect-refund, authorize-withdrawal, request-refund) now fetch the
  head cost models and call the sync **inside** `withMeshCostModelLock(...)`,
  holding the per-payment-source lock across sync + build + sign (submitTx stays
  outside) — same invariant the L1 path uses, since the arrays are process-global
  and shared with L1. The L2 **lock** (`l2-lock.ts`) is intentionally NOT wired:
  it doesn't spend a Plutus script (no redeemer → no script-data-hash), which is
  why it already passed without this fix.

For a real preprod head the head's cost models equal preprod's, so this patches
to the same values the L1 sync would. For the local devnet they are the devnet's.

Build green: typecheck + lint clean, **606/606 tests** (9 new: 4 for
`fetchRawCostModels`, 5 for `syncMeshCostModelsFromHeadV2`).

**✅ ON-CHAIN VALIDATED (2026-06-09).** Brought the devnet up fresh, opened+funded
a head, locked 40 ADA via `processL2PurchaseLocks` (PASSED), funded the seller
in-head, and ran `06-submit-result`. The log shows `Synced mesh-sdk Plutus cost
models from Hydra head (V2 mesh line)` and the tx builds, signs, and submits.
**`PPViewHashesDontMatch` is GONE** — the script-data-hash now matches the head's
ledger across every attempt. The fix is confirmed correct.

### `OutsideForecast` — SOLVED via devnet slot-config (2026-06-09)

The first attempt hit `OutsideForecast`: the original devnet ran `slotLength=0.1s`
+ `epochLength=5`, which actually **violates** the Shelley stability rule
(`10·k ≤ f·epochLength` → `21600 ≤ 5` is false). With 5-slot epochs the ledger
crosses an epoch boundary every 5 slots and can't forecast slot→time past ~tens
of slots, while the build+submit latency is ~20–40 slots — no validity window is
simultaneously un-expired and forecastable (wide window → `OutsideForecast`,
tight window → `OutsideValidityIntervalUTxO`).

Fix: give the devnet a production-like slot config so the whole test stays inside
epoch 0 (where slot→time is trivially forecastable). The cardano-node config pins
genesis **files**, not hashes, so the template
(`hydra/hydra-cluster/config/devnet/genesis-shelley.json`) can be edited directly:
- `slotLength` 0.1 → **1** (preprod-like),
- `epochLength` 5 → **43200** (now satisfies `10·k ≤ f·epochLength`),
- byron `blockVersionData.slotDuration` 250 → 1000 (seam consistency).

Second gotcha at 1 s slots: the head's out-of-band funding is an **incremental
commit (deposit)** whose default `--deposit-period 10s` (in docker-compose.yaml)
expired before the deposit could be incorporated (L1 settlement is 10× slower at
1 s/block). Raised it to **120s** on all three nodes; the deposit then finalizes
(`CommitFinalized`) in ~2 min and the funds appear in the head snapshot.

**✅ FULL E2E PASS (2026-06-09).** With the new config: head opened + funded, buyer
+ seller funded in-head, **lock PASSED** (40 ADA → script datum), and
**submit-result PASSED** — the build logged `Synced mesh-sdk Plutus cost models
from Hydra head`, submitted, and the head returned **`TxValid` + `SnapshotConfirmed`**.
The script UTxO advanced `FundsLocked → ResultSubmitted` (new continuation
`82dfa881…#0`, 40 ADA, datum present). The vested_pay V2 SubmitResult Plutus
validator executed in-head and passed — both `PPViewHashesDontMatch` (cost models)
and `OutsideForecast` (slot config) are resolved.

Devnet env knobs for the slot context (1 s slots): `HYDRA_L2_SLOT_LENGTH_MS=1000`,
`HYDRA_L2_SLOT_ZERO_TIME_MS=<genesis systemStart ms>`, `HYDRA_L2_CURRENT_SLOT=<tip
slot>` (default buffers are fine — no override needed).

## 5e. Slot-context propagation to all L2 paths + collection (2026-06-09)

Validating the rest of the lifecycle (collection / refund / withdrawal) surfaced a
gap: the L2-aware tx-window wiring (`getHydraL2SlotContext()` → `createTxWindow`)
was only in **submit-result** (the reference path). The other five L2 services
(collection, authorize-refund, request-refund, authorize-withdrawal, collect-refund)
computed their validity window in the **network's** slot config — correct on a real
preprod head, but rejected on the devnet (`OutsideValidityIntervalUTxO`). Propagated
the same wiring to all five (no-op on preprod: `getHydraL2SlotContext()` returns
`undefined` when the env is unset → default network config). Threaded as an optional
`l2SlotCtx` through the two services whose window lives in a shared L1/L2
`validateAndBuildItem` (collection, collect-refund); inline in the other three.
Build green: typecheck + lint + **606 tests**.

**Collection (`CollectCompleted`, seller payout) — IS needed and mechanically works.**
It's the happy-path step where the seller actually receives the locked funds.
Driven against the head it builds, syncs the head cost models, and submits — only
the contract's **seller cooldown** gates the final acceptance. Two devnet-specific
gotchas found and handled:
- Datum times must be anchored to the **devnet slot clock** (not `Date.now()`),
  because the L2 services convert datum times → slots via the same slot context;
  `03-lock.mts` now derives `now` from `HYDRA_L2_SLOT_*` when present.
- `must_start_after(unlock_time)` is the only Withdraw time-gate in vested_pay, but
  the collection **service** floors `invalidBefore` at `max(seller_cooldown, unlock)`.
  In production `unlock_time` is the later bound so this is invisible; with the
  past-unlock test trick `seller_cooldown` (= submit + cooldown + hardcoded 10 min,
  see `newCooldownTime`) becomes binding → collection must wait out that cooldown
  (correct behaviour, ~10–13 min after submit). Not a bug.

## 5f. FULL LIFECYCLE VALIDATED on the head (2026-06-09)

Every V2 escrow op now executes its Plutus validator **in-head** and the head
returns `TxValid` + `SnapshotConfirmed`. Flow scripts `hydra-l2-flow/03..11`:

| Op | Redeemer / builder | State transition | Result |
|----|--------------------|------------------|--------|
| lock | (no script spend) | → FundsLocked | ✅ TxValid |
| submit-result | SubmitResult / interaction | FundsLocked → ResultSubmitted | ✅ TxValid |
| collection | CollectCompleted / **withdraw** | ResultSubmitted → collected (seller paid) | ✅ TxValid |
| request-refund | RequestRefund / interaction | FundsLocked → RefundRequested; ResultSubmitted → Disputed | ✅ TxValid (both) |
| authorize-refund | AuthorizeRefund / interaction | RefundRequested → RefundAuthorized | ✅ TxValid |
| collect-refund | CollectRefund / **withdraw** | RefundAuthorized → collected (buyer refunded) | ✅ TxValid |
| authorize-withdrawal | AuthorizeWithdrawal / interaction | Disputed → WithdrawAuthorized | ✅ TxValid (after buyer-cooldown) |

Both builder paths (single-interaction + withdraw) are proven on-chain through the
full cost-model-sync + `isHydra` + L2-slot-window stack. The only timing gates are
the contract's own seller/buyer cooldowns (`newCooldownTime` = now + cooldown +
hardcoded 10 min), which are correct behaviour — collection and authorize-withdrawal
wait them out; the refund payout chain (request → authorize → collect via
RefundAuthorized) has zero cooldown gates and runs back-to-back with no waits.

Test-harness notes (devnet only; not production): datum times anchor to the devnet
slot clock (`03-lock` reads `HYDRA_L2_SLOT_*`); the disposable test DB has no tx-sync
running, so hot wallets must be unlocked between manual steps
(`UPDATE "HotWallet" SET "lockedAt"=NULL`); and for the ResultSubmitted→Disputed
path the PurchaseRequest's CurrentTransaction must be repointed to the submit-result
tx (`08` with `REQUEST_REFUND_FROM_STATE=ResultSubmitted`).

## 6. Environment left running (for whoever picks this up)

- Hydra devnet: `cd ../hydra/demo && docker compose ps` / `docker compose down`.
- Disposable test DB (does NOT touch the dev DB):
  `docker rm -f masumi-hydra-test-db` to remove. It was seeded via
  `DATABASE_URL=postgresql://postgres:testpass@localhost:5433/masumi_hydra_test?schema=public`
  + `prisma migrate deploy` + `prisma db seed`.
