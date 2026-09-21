# Masumi on Hydra L2: Milestone 4 report (preprod)

**Date:** 2026-09-18, identity run 2026-09-19 · **Network:** Cardano preprod · **hydra-node:** 2.4.1 · **Service:** masumi-payment-service, branch `hydra/m4-preprod-evidence` at commit `610c1b5d`, plus the product fixes in Section 2, which are committed together with this report.

Milestone 4 asked for the Layer 2 built in Milestone 3 to be integrated with the Masumi network so that L2 use is indistinguishable from L1 through the existing tools. This report covers the testnet evidence. Mainnet, the video, and the developer documentation were removed from scope by the project's decision. The independent security audit is performed by an external company and is out of scope here.

**Evidence.** Every file named below is inside one archive, [hydra-l2-milestone4-evidence.tar.gz](hydra-l2-milestone4-evidence.tar.gz) (47 files); paths are relative to its `2026-m4-preprod/` folder. The archive also holds `REPORT-FULL.md`, the full-length version of this report, with the complete account behind every short statement here.

## Results

| Acceptance criterion                                           | Result on preprod                                                         | Evidence                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------- |
| 50 of 50 consecutive settlement transactions, no loss of funds | 50 of 50 valid on chain, every head conserves funds                       | Appendix A              |
| Latency under 500 ms                                           | 37.7 ms median, 46.2 ms p95                                               | `perf/SUMMARY.md`       |
| Transaction cost reduction of 95 %                             | 99.81 % over 10,200 L2 transactions                                       | `perf/COST.md`          |
| SDK/API compatibility with only a configuration change         | Same calls ran on L1 and L2; only the optional `forceLayer` field differs | `api-compat/MATRIX.md`  |
| Agent identity retained on L2, verified through the audit log  | 6 in-head transactions tied to the agent NFT and its KERI-ACDC claims     | `identity/AUDIT-LOG.md` |

## 1. Settlement verification

**Result: 50 of 50 settlement transactions valid on chain, all heads conserve funds, series is consecutive.**

Every transaction was requested through the payment service's own API (`hydra/head/topup`, `hydra/head/withdraw`, `hydra/head/close`, `hydra/head/fanout`), confirmed by the service's own reconciliation, then checked independently on Blockfrost. Four heads carried 8 deposits, 34 withdrawals, 4 closes and 4 fanouts.

All 50 Cardanoscan links and the per-head fund conservation are in Appendix A; every delta is zero. Head 1's figure includes 73,000,000 lovelace carried in from a first attempt on the same head, which stopped at its third withdrawal and left the head open. Its four transactions are verified on chain, listed in Appendix A, and not counted in the 50.

## 2. Product defects found and fixed during the run

On 2026-09-17 the project authorized product fixes for defects the live run exposed. Each fix was reviewed. A spec file is named where the fix has unit tests in this commit.

1. The close transaction hash stayed unrecorded because the node nests the chain-state field one level deeper than the code read it. Fixed in `src/lib/hydra/hydra/head-output-tx.ts`; tested in `head-output-tx.spec.ts`.
2. The split before a top-up could reuse an exact-amount UTxO that carried a datum, which hydra-node refuses to commit. Fixed in `src/services/hydra-topup/pre-split.ts`.
3. Evidence harness only: the head-opening script (`00-open-head.mts`) re-drafted a second deposit after wrongly concluding the first had never appeared.
4. A withdrawal could be accepted while the previous one on the same head was still pending, so its in-head split never confirmed. It now receives an HTTP 409 first, and the guard resolves as not pending when it cannot read the head's state. One gap in this guard remains open and is listed in Section 7. Fixed in `src/services/hydra-decommit/execute.ts`, `src/lib/hydra/hydra/head-output-tx.ts`, `src/lib/hydra/hydra/node-control-queries.ts` and `src/lib/hydra/hydra/node.ts`; tested in `execute.spec.ts` and `head-output-tx.spec.ts`.
5. After a saved snapshot was reloaded, the node re-delivered the identical signed snapshot and the history replay ended the session. An identical re-delivery is now ignored; anything else is still rejected. Fixed in `src/lib/hydra/hydra/node-history-replay.ts`.
6. A withdrawal for an amount the wallet already held exactly always split funds inside the head. An existing pure-ADA UTxO of the exact amount is now reused. Fixed in `src/services/hydra-decommit/execute.ts`; tested in `execute.spec.ts`.
7. The lookup that matches a withdrawal to its Layer 1 payout could record two withdrawals against the same Layer 1 transaction hash. It is now bounded from the withdrawal's creation time, excludes hashes already claimed, and takes the oldest match. Fixed in `src/services/hydra-decommit/l1-payout.ts` and `src/services/hydra-decommit/payout-lookup.ts`; tested in `l1-payout.spec.ts`.
8. Since hydra-node 2.4.1, every L2 lock and escrow action logged a false "persistence failed" error, because the confirmation listener updated the database row about 70-130 milliseconds before the finalize step looked for a pending row. This was bookkeeping only; no funds were at risk. Fixed in `packages/payment-source-v2/src/services/l2-submission/index.ts` and `packages/payment-source-v2/src/services/purchases/batch-payments/l2-lock-execute.ts`. This commit carries no unit test for it. It was checked live: the error was logged on 6 of 6 in-head transactions before the fix and on 0 of 6 in the identity run. The service log is not published; the counts are in `identity/NOTE.md`.

## 3. Performance retention

The latency target applies to L2 transactions. The 50 settlement transactions in Section 1 are L1 transactions by nature and take L1 confirmation time.

| Metric                     | Target   | Measured (run 2)                          |
| -------------------------- | -------- | ----------------------------------------- |
| Per-payment finality p50   | < 500 ms | 37.7 ms                                   |
| Per-payment finality p95   | —        | 46.2 ms                                   |
| Sequential run confirmed   | —        | 200/200                                   |
| Sustained run confirmed    | —        | 10000/10000 (511.2 TPS confirmed)         |
| Transaction cost reduction | 95 %     | **99.81 %** (over 10,200 L2 transactions) |

The cost reduction divides a head's Layer 1 lifecycle fees, each read from Blockfrost, by the number of L2 transactions the head carried, and compares that with the fee of one real L1 escrow lock from Section 4 (`perf/SUMMARY.md`, `perf/COST.md`). At these fees a head needs about 470 L2 transactions to cross 95 %. Run 1 is shown for transparency in `perf/COST.run1-200tx.md`: its sustained leg could not start, and it reached 88.31 % over 200 L2 transactions with p50 41.1 ms and p95 52.6 ms.

The escrow lifecycle (lock, submit result, collect) completed 9 of 10 times in run 1 (`perf/escrow-run1/SUMMARY.md`). In run 2, 0 of 10 locks registered although 9 had confirmed inside the head; Section 7 gives the cause (`perf/escrow-latest/NOTE.md`).

The two benchmark heads were settled on chain as well. These four transactions are additional public evidence, not part of the 50:

- Run 1: close [`c7f09b403e894435…`](https://preprod.cardanoscan.io/transaction/c7f09b403e894435474f4be2c1212a923826f353b6271f7bc986b1694b2a23a5), fanout [`92dff8499053f3e6…`](https://preprod.cardanoscan.io/transaction/92dff8499053f3e663b37c86e4859689f4c16f29deae99a53ce3c1ce60184124)
- Run 2: close [`1f1fc6f2dc78f7ed…`](https://preprod.cardanoscan.io/transaction/1f1fc6f2dc78f7edc4b8a1d9365d43d2da493952ed482f64ccf4eab1b8c9f11e), fanout [`7ed322adfe9eeb7c…`](https://preprod.cardanoscan.io/transaction/7ed322adfe9eeb7c715617e5c48aa50bb82dd3abbb3ccb6cf45f1c6b22987e5e)

## 4. SDK/API compatibility

The same `POST /payment` and `POST /purchase` calls ran on L1 and L2 with only the optional `forceLayer` field changed. With the field omitted the service chose L2 on its own because an open head existed (`api-compat/MATRIX.md`). Responses report the layer in `CurrentTransaction.layer` and the head in `CurrentTransaction.hydraHeadId`.

| Case               | forceLayer sent | Layer chosen by the service | State       | Tx                                                                                                                                 |
| ------------------ | --------------- | --------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| forceLayer L1      | `"L1"`          | L1                          | FundsLocked | [`45ad6d4453e24e84…`](https://preprod.cardanoscan.io/transaction/45ad6d4453e24e84d2de656eda71d6f4d7ad278b3b19127af80cdb0a90fcc43e) |
| forceLayer Hydra   | `"Hydra"`       | L2                          | FundsLocked | `38abe5dc99f94fcf…` (in-head; not on Cardanoscan)                                                                                  |
| forceLayer omitted | `null`          | L2                          | FundsLocked | `c2515612d5180e06…` (in-head; not on Cardanoscan)                                                                                  |

The case data is `api-compat/cases.json` (attempt 4); three failed earlier attempts are kept unedited alongside it (`cases.attempt1.json` through `cases.attempt3.json`). V2 callers must pass `filterPaymentSourceType=Web3CardanoV2` to `GET /registry`, `GET /purchase` and `GET /payment`, which default to a Web3CardanoV1 filter.

A result was submitted for all three cases. The L1 case reached `ResultSubmitted`. The two L2 cases were deferred until the deadline and refunded as designed; the most likely cause, inferred but not proven, is that the selling wallet held no funds inside the head. The identity run in Section 5 repeated the calls with the selling wallet funded inside the head, and both Layer 2 purchases reached `ResultSubmitted` and were then collected.

## 5. Identity retention on L2

An agent's identity in Masumi is its registry NFT, the `agentIdentifier`, together with the KERI-ACDC verification claims attached to it at registration. In-head transactions never appear on a public explorer, so the service's own records must keep a payment tied to that identity. This section exports those records.

One agent was registered through `POST /registry` with a KERI-ACDC claim, and its NFT was minted on preprod: [`01a02e927791023a…`](https://preprod.cardanoscan.io/transaction/01a02e927791023a9af3f1ec95bba37157cf0106c285ff1a9d3dff30f96f907b). Two purchases for that agent were made with the unchanged `POST /payment` and `POST /purchase` calls, then locked, result-submitted and collected, all inside one head.

`identity/AUDIT-LOG.md` lists the resulting 6 in-head transactions in 12 rows, because each is recorded once on the buyer's purchase and once on the seller's payment. Every row carries the agent identifier, the head it ran in, and the issuer AID, holder AID and credential SAID registered for that agent. The run's other records are `identity/run/cases.json`, `identity/run/audit-log.after-submit.json` and `identity/l1-anchors.json`.

The agent identifier can also be decoded from each payment's `blockchainIdentifier`, which embeds it together with the selling wallet's signature over the payment terms, and those signed terms include the agent identifier. That signature is produced when the payment is created and checked when the purchase is created; the in-head transactions carry the same request record and do not re-verify it. Decoding both identifiers in this evidence gives the exported agent identifier (`identity/NOTE.md`). No identity code was changed for this milestone; the export script only reads.

## 6. Wallet operations on L2

Funds move into a head with `hydra/head/topup` and out with `hydra/head/withdraw`, and the in-head balance is read with `hydra/head/balance`; payments and collections use the existing payment and purchase endpoints. Section 1 exercised top-up 8 times, withdraw 34 times, close 4 times and fanout 4 times.

## 7. Known limits stated for the reviewer

`REPORT-FULL.md` gives each point in full.

- Heads are drained of escrows before close, because fanout evaluates every remaining script UTxO in one transaction.
- The service does not record the fanout transaction hash on the head's database row; this report takes fanout hashes from the chain.
- A top-up row reads "Absorbed" before the service's own hydra-node has observed the increment, and a withdrawal is refused until then, which can take several minutes. The wording overpromises.
- Not fixed: withdrawal selection does not yet prefer asset-free outputs, so an output that also holds a native asset can leave the head with a partial ADA withdrawal. It keeps its address on Layer 1, so nothing is lost. Deposits in this run were ADA only.
- Not fixed: the pending-withdrawal guard reads only the service's own node, and a peer node can observe a decrement up to about 20 seconds later. A withdrawal requested in that gap wedges the head until it is closed. This happened once (head 3, 21st withdrawal); no funds moved and the 10 ADA involved returned at fanout. The harness now waits 45 seconds between withdrawals.
- Upstream hydra-node behavior: a snapshot round can strand after a decrement, and recovery is only safe when both nodes report the same confirmed snapshot number. A watchdog mistake in the harness, since corrected, ended head 2 early.
- Contestation was not demonstrated: head 2's peer node tried to contest, but its only large wallet UTxO carried a native token and could not serve as collateral. Fanout settled the older snapshot and all funds returned.
- Honest count: the 50 are the settlement transactions that reached Layer 1, in order. Several withdrawal requests were refused or did not settle, each traceable to a defect in Section 2; none moved funds and none is in the ledger. Head 1 was closed early by an operator mistake and head 2 by the watchdog error, so the series spans four heads of unequal length.
- Ledger repair on head 1, disclosed: defect 7 had given one withdrawal another withdrawal's Layer 1 hash. The row was corrected from the chain's own list of decrement transactions, and one unrecorded withdrawal was appended from the service's database row. The ledger from before the repair is kept alongside it (`settlement/ledger.jsonl.before-repair-*`).
- The escrow benchmark clears the purchase and payment tables when it starts. It ran after the matrix on the same database, so the matrix's L1 escrow (5.435 tADA) can no longer be collected by the service and remains at the contract address on preprod. This was a harness sequencing mistake, not a product behavior.
- When the selling side cannot build an in-head result submission, the service defers it and logs the reason at informational level only, so an operator sees a refund at the deadline without an earlier warning.
- In run 1 of the escrow benchmark one of ten purchases never locked. The cause was not established.
- Not fixed: the service tracks at most 10,000 confirmed in-head transactions it has not yet reconciled (`MAX_UNRECONCILED_CONFIRMED_TRANSACTIONS`, `src/lib/hydra/hydra/node.ts`), and a lock learns that it is confirmed only from that record. A raw benchmark had pushed 10,251 transactions through the head while the service was stopped, so the record filled and logged nothing, and all 10 locks of escrow run 2 timed out as "outcome ambiguous" although 9 had confirmed inside the head. Those 9 escrow UTxOs went through fanout and sit at the contract address (test funds, not recovered). The count and the ruling-out of a message-size cause were measured; that the limit stopped the confirmations is concluded from the code path, not confirmed by a re-run. No funds were at risk. Until it is fixed, keep a head's unreconciled backlog well below 10,000 and do not drive a head with a tool that bypasses the service while the service is stopped.
- The verification claims in Section 5 are the API's documented example values, and their OOBI addresses do not resolve. Section 5 shows that the tie is kept and can be audited. It does not show KERI credential verification, and it was run on testnet only.
- After the Fanout in the identity run, the reconcile job kept polling the finalized head and logged a warning (`[HydraReconcile] Failed to reconcile head`, HTTP 404) about every five seconds, 19 times in the 90 seconds until the service was stopped. No effect on funds or records was observed. The cause was not investigated.

## Replication

Run the API-compatibility matrix and the escrow benchmark on separate databases or heads. Prerequisites are those of [the Milestone 3 report](hydra-l2-benchmark-report.md#replication), and `HYDRA_SCRIPTS_TX_IDS` must point at a published hydra-node 2.4.1 script set; the driver carries the one used here.

- [`18-settlement-run.sh`](../hydra-l2-flow/18-settlement-run.sh) drives the settlement series. It ran once per head with `DEPOSITS=2 DEPOSIT_LOVELACE=40000000 WITHDRAW_LOVELACE=3500000`, giving 5, 5, 20 and 4 settled withdrawals on heads 1-4.
- [`19-verify-settlement-ledger.mts`](../hydra-l2-flow/19-verify-settlement-ledger.mts) checks every hash on Blockfrost and writes `settlement/SUMMARY.md`, which Appendix A copies.
- [`21-api-compat-matrix.sh`](../hydra-l2-flow/21-api-compat-matrix.sh) runs the matrix in Section 4. With `M4_MATRIX_CASES=l2 M4_MATRIX_OUT=<dir>` it made the identity run's purchases, with buyer and selling wallet both funded inside the head.
- [`20-identity-audit-log.mts`](../hydra-l2-flow/20-identity-audit-log.mts) is the read-only identity export. It writes `identity/AUDIT-LOG.md` and `identity/audit-log.json` in place; set `M4_EVIDENCE_ROOT` to a scratch directory to keep existing evidence intact.
- [`22-cost-reduction.mts`](../hydra-l2-flow/22-cost-reduction.mts) and [`replicate-benchmark.sh`](../hydra-l2-flow/replicate-benchmark.sh) produce the figures in Section 3.

## Appendix A. The 50 settlement transactions

Copied without change from `settlement/SUMMARY.md` (generated 2026-09-18T11:16:45.538Z by
`hydra-l2-flow/19-verify-settlement-ledger.mts`, which checks every hash on Blockfrost).

| #   | Head | Kind       | Tx                                                                                                                                 | Block   | Valid |
| --- | ---- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------- | ----- |
| 1   | 1    | deposit    | [`e9efa30047ff056d…`](https://preprod.cardanoscan.io/transaction/e9efa30047ff056ddfc195e3316a68ae88b371bb6ae50c644b813e252910ffc4) | 5190222 | yes   |
| 2   | 1    | deposit    | [`7e17f463b014ba78…`](https://preprod.cardanoscan.io/transaction/7e17f463b014ba7832c4ebc2d2fee41a476c23aa44506b299b4aecaba39bc2bc) | 5190250 | yes   |
| 3   | 1    | withdrawal | [`32b605bbab4c1d26…`](https://preprod.cardanoscan.io/transaction/32b605bbab4c1d266c70b0cb20d95d6d568d22a5c3c4e22e1e31ade03b21e28a) | 5190367 | yes   |
| 4   | 1    | withdrawal | [`109dc4402014091e…`](https://preprod.cardanoscan.io/transaction/109dc4402014091ebe02b5d542009bb9aa52e5e275a4262ae145b68fe2e533f1) | 5190411 | yes   |
| 5   | 1    | withdrawal | [`d2f6d1c24dd0fda3…`](https://preprod.cardanoscan.io/transaction/d2f6d1c24dd0fda3ee0c43490771a6ff0b51ee1584bde6aa7021880a6c36ee62) | 5190413 | yes   |
| 6   | 1    | withdrawal | [`5cfc97beda534290…`](https://preprod.cardanoscan.io/transaction/5cfc97beda534290bf17d00a55c75dc050c17d966c154892819f9deb3de89de3) | 5190417 | yes   |
| 7   | 1    | withdrawal | [`2908957862921aa9…`](https://preprod.cardanoscan.io/transaction/2908957862921aa9eba6290b3018b25e1e62b426cd205e0d1cc613a845e26916) | 5190467 | yes   |
| 8   | 1    | close      | [`cf73c50ffaa4e9e2…`](https://preprod.cardanoscan.io/transaction/cf73c50ffaa4e9e25fca8d0d30bb461ac9dfc7b09e1d050aedb34c07214898fa) | 5190483 | yes   |
| 9   | 1    | fanout     | [`ce382986026183a0…`](https://preprod.cardanoscan.io/transaction/ce382986026183a04e6276adda55637497f5042ac90f9a79f74f034d7c5c6001) | 5190506 | yes   |
| 10  | 2    | deposit    | [`686f58d33391aa0f…`](https://preprod.cardanoscan.io/transaction/686f58d33391aa0f08bee4e3b9644cad682254f83e296504dbfc79a98ef37017) | 5190539 | yes   |
| 11  | 2    | deposit    | [`c2b3721e77ef0363…`](https://preprod.cardanoscan.io/transaction/c2b3721e77ef036308484f339be2c19f5057a91cc766893e1f251d4231bdd7f0) | 5190559 | yes   |
| 12  | 2    | withdrawal | [`e604b4331d89a740…`](https://preprod.cardanoscan.io/transaction/e604b4331d89a7404edda7750ca6a9bb87d6e48536b6ad304868b63f7463f077) | 5190585 | yes   |
| 13  | 2    | withdrawal | [`64d74fbfa796de7e…`](https://preprod.cardanoscan.io/transaction/64d74fbfa796de7ed2c42bedb85e96180e0ce2323acd1bff9717e69773a9478d) | 5190595 | yes   |
| 14  | 2    | withdrawal | [`6b06388f4fff4d78…`](https://preprod.cardanoscan.io/transaction/6b06388f4fff4d78e8aeb78dbf570b45858a6b38b40a03f8337be008535c80ac) | 5190599 | yes   |
| 15  | 2    | withdrawal | [`4dc46cbfb2e2d2e7…`](https://preprod.cardanoscan.io/transaction/4dc46cbfb2e2d2e7e34781bbe033f203e7ae6bed9e53521d7cbd5bd1179ccb8a) | 5190603 | yes   |
| 16  | 2    | withdrawal | [`18ec08d6c988086e…`](https://preprod.cardanoscan.io/transaction/18ec08d6c988086e2e5c2806f70eb440bc0646b3d47db70ec1f54020a3c95665) | 5190606 | yes   |
| 17  | 2    | close      | [`4c083d454064f3df…`](https://preprod.cardanoscan.io/transaction/4c083d454064f3dfb173a5ebf59688bb3a82c8f3e19d4cd0e6835ad8c139446a) | 5190654 | yes   |
| 18  | 2    | fanout     | [`bdb080f5a8686b05…`](https://preprod.cardanoscan.io/transaction/bdb080f5a8686b05e608e503f35b74d23a296a909b8a3df4ef11381a373537be) | 5190680 | yes   |
| 19  | 3    | deposit    | [`769f3dc21ec45831…`](https://preprod.cardanoscan.io/transaction/769f3dc21ec458310499cb5008dc492a60db420a6eb2d89ac11c728f581f5e91) | 5190821 | yes   |
| 20  | 3    | deposit    | [`0bde269563a2f2a2…`](https://preprod.cardanoscan.io/transaction/0bde269563a2f2a292bdf8e25d9ccd75919ed3a23039b5b8cbfd3ebc134181e4) | 5190838 | yes   |
| 21  | 3    | withdrawal | [`99d8e5f471141f51…`](https://preprod.cardanoscan.io/transaction/99d8e5f471141f514f6377f51bcc2196616ffc189977b684888fdbb26dc8262a) | 5190861 | yes   |
| 22  | 3    | withdrawal | [`4f3d9b84bbfaec72…`](https://preprod.cardanoscan.io/transaction/4f3d9b84bbfaec721c8475eefdd058d86711f019a0b862b9954498c7585c50f8) | 5190865 | yes   |
| 23  | 3    | withdrawal | [`e2ad5a27a40a6ea1…`](https://preprod.cardanoscan.io/transaction/e2ad5a27a40a6ea1b015551c57fa5183d70e8d13ecdaf455574700855665de82) | 5190869 | yes   |
| 24  | 3    | withdrawal | [`a871f2f6a1e55aee…`](https://preprod.cardanoscan.io/transaction/a871f2f6a1e55aee08e0a2ed1ef899da52a5a79079224a02add78c8aca4151e7) | 5190872 | yes   |
| 25  | 3    | withdrawal | [`0be1f53b06eae76b…`](https://preprod.cardanoscan.io/transaction/0be1f53b06eae76b7309c143311c2318f3cb1cb61ecd2d094a2864356269d855) | 5190874 | yes   |
| 26  | 3    | withdrawal | [`93114cc1633c522a…`](https://preprod.cardanoscan.io/transaction/93114cc1633c522a48c85d47a91fda085a3ab0f65284900169e17b22c687b6aa) | 5190877 | yes   |
| 27  | 3    | withdrawal | [`d078d0b67cb2d1d3…`](https://preprod.cardanoscan.io/transaction/d078d0b67cb2d1d37a9392f31b664ccf2dd52dbfc5373dd2de392c8d85efe58c) | 5190883 | yes   |
| 28  | 3    | withdrawal | [`4eb8d07e0253c754…`](https://preprod.cardanoscan.io/transaction/4eb8d07e0253c7544970c6fb8dca8f1ccb82cd2673d5c1952422f020f050f989) | 5190887 | yes   |
| 29  | 3    | withdrawal | [`f65f51bc07c6da7c…`](https://preprod.cardanoscan.io/transaction/f65f51bc07c6da7c3bdec044334045d0d86c78e86d088e4a0ed323fe72d68c7e) | 5190890 | yes   |
| 30  | 3    | withdrawal | [`60506daa9c480d40…`](https://preprod.cardanoscan.io/transaction/60506daa9c480d40d05d4d2689cefada0f1687e539d071367153a8872dad39f7) | 5190892 | yes   |
| 31  | 3    | withdrawal | [`69e15c7be8f0c08b…`](https://preprod.cardanoscan.io/transaction/69e15c7be8f0c08b180819a467da5e268bad592d18b4dfc367f045c82d61685a) | 5190894 | yes   |
| 32  | 3    | withdrawal | [`2e7a8300c98f77b8…`](https://preprod.cardanoscan.io/transaction/2e7a8300c98f77b89b2f54b54d2b61c62a5ccaae943d860ef1ca69213104a3f0) | 5190898 | yes   |
| 33  | 3    | withdrawal | [`3c5490b29a3ebd93…`](https://preprod.cardanoscan.io/transaction/3c5490b29a3ebd93fb4c6c76f4cfda29fb79f511b61d9c416879ae8b0b37f424) | 5190902 | yes   |
| 34  | 3    | withdrawal | [`be8debec99ab1397…`](https://preprod.cardanoscan.io/transaction/be8debec99ab13973ca3c7266f345e91934ba09a79231225ae797b6dba59fa45) | 5190906 | yes   |
| 35  | 3    | withdrawal | [`fc5d7ef3db695ffb…`](https://preprod.cardanoscan.io/transaction/fc5d7ef3db695ffb60be8ae24bd7ddc1825928fea6ec7a92ba6bede4943cc799) | 5190909 | yes   |
| 36  | 3    | withdrawal | [`c63fb1004209cb19…`](https://preprod.cardanoscan.io/transaction/c63fb1004209cb1947c590b51091a2d65507b92ae13df33fbee09147431f939f) | 5190913 | yes   |
| 37  | 3    | withdrawal | [`db62d92be1d8c6c8…`](https://preprod.cardanoscan.io/transaction/db62d92be1d8c6c889df6fc88b6ab01f050872b45bf5ce0328d12d7477121629) | 5190916 | yes   |
| 38  | 3    | withdrawal | [`7ab5c00494524702…`](https://preprod.cardanoscan.io/transaction/7ab5c004945247026e74be831456f20375d857b198e129f69b471f48cc13a97e) | 5190921 | yes   |
| 39  | 3    | withdrawal | [`26ff7b77ebfe9e76…`](https://preprod.cardanoscan.io/transaction/26ff7b77ebfe9e7615c189d6a2eb92b15636fb45bfc479390283cfd80f17a52b) | 5190924 | yes   |
| 40  | 3    | withdrawal | [`9d02d7acc27da296…`](https://preprod.cardanoscan.io/transaction/9d02d7acc27da296b8dfcb5bc1847e6aed728acebb493eb8bddb9cb0b73d6e97) | 5190926 | yes   |
| 41  | 3    | close      | [`3e62703a9825b5ca…`](https://preprod.cardanoscan.io/transaction/3e62703a9825b5ca9854cb9742e06e4a541a06b8f7fa77bc3e0ab6fe3fa87121) | 5190996 | yes   |
| 42  | 3    | fanout     | [`4c6cb1602ceb23ac…`](https://preprod.cardanoscan.io/transaction/4c6cb1602ceb23acc7aa7b3e2f38c928fc5bae069a9545d90615e212035458e8) | 5191014 | yes   |
| 43  | 4    | deposit    | [`11f343fbd16eb704…`](https://preprod.cardanoscan.io/transaction/11f343fbd16eb70499d9ebeb86109538124e58818ece5e8576c7cc79df762814) | 5191054 | yes   |
| 44  | 4    | deposit    | [`a381144f60db3bdc…`](https://preprod.cardanoscan.io/transaction/a381144f60db3bdcc3876330f44252e9972ccbb81faa7c8a9835f303a0e59492) | 5191072 | yes   |
| 45  | 4    | withdrawal | [`d997b03854a9cd24…`](https://preprod.cardanoscan.io/transaction/d997b03854a9cd244a2e60f24a347bff0aac7924e17420a040212e6e08bdf61e) | 5191096 | yes   |
| 46  | 4    | withdrawal | [`670ef56b0eb62468…`](https://preprod.cardanoscan.io/transaction/670ef56b0eb624680c05d1a7a9563aade43ec9e0a3ec00368e4c93dcd8269b90) | 5191102 | yes   |
| 47  | 4    | withdrawal | [`2902e4b5d9b8ef69…`](https://preprod.cardanoscan.io/transaction/2902e4b5d9b8ef69c3229eb55cfc86eee545c8d5e1ad40b705bd76434549d621) | 5191108 | yes   |
| 48  | 4    | withdrawal | [`631b12084cac1f65…`](https://preprod.cardanoscan.io/transaction/631b12084cac1f658d8e4105c7814e52466bb01a0ebde98b3a834dfb9b6a39a0) | 5191113 | yes   |
| 49  | 4    | close      | [`eaff40369a1e3718…`](https://preprod.cardanoscan.io/transaction/eaff40369a1e3718692711d81cef9a9fb0e0545cbde6ff79454d93b4e3ed24b8) | 5191116 | yes   |
| 50  | 4    | fanout     | [`1db38c7583a945ba…`](https://preprod.cardanoscan.io/transaction/1db38c7583a945ba4b6133d60bb937c23688c1db1b95a5e85311fe64593fb666) | 5191148 | yes   |

### Fund conservation per head (lovelace)

| Head | Head id             | Carried in | Deposited | Withdrawn (requested) | Withdrawn (settled on L1) | Fanout to wallet | Delta |
| ---- | ------------------- | ---------- | --------- | --------------------- | ------------------------- | ---------------- | ----- |
| 1    | `3c32def46e0cd7f0…` | 73000000   | 80000000  | 17500000              | 17500000                  | 135500000        | 0     |
| 2    | `b505b683e46d601d…` | 0          | 80000000  | 17500000              | 17500000                  | 62500000         | 0     |
| 3    | `0fd5c50edc35de3f…` | 0          | 80000000  | 70000000              | 70000000                  | 10000000         | 0     |
| 4    | `efebfb67e077d6c9…` | 0          | 80000000  | 80000000              | 80000000                  | 0                | 0     |

Delta is carried-in plus deposited minus requested withdrawals minus fanout-to-wallet and must be zero. Requested minus settled is the decommit transactions' own L1 fees.

### Transactions carried into a head (not counted in the series)

These settlement transactions ran on the same head before the counted series began (a first attempt that stopped at its third withdrawal; the head stayed open and was reused, so the funds they left in the head return in that head's fanout).

| Head | Kind       | Tx                                                                                                                                 | Block   | Valid |
| ---- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------- | ----- |
| 1    | deposit    | [`f243046cf3eef087…`](https://preprod.cardanoscan.io/transaction/f243046cf3eef0876430acb322d24bc602fe2a9de55a42e92c4c5c190bf89895) | 5190104 | yes   |
| 1    | deposit    | [`8c848498a4b84734…`](https://preprod.cardanoscan.io/transaction/8c848498a4b84734e0eec8d90f8f167ae66a2a94ba2b49de67a530d8e8d46ef5) | 5190130 | yes   |
| 1    | withdrawal | [`07723219ebc937eb…`](https://preprod.cardanoscan.io/transaction/07723219ebc937eb2627dab115fe347f8ccee3c17895d7a6797b8e675a775585) | 5190147 | yes   |
| 1    | withdrawal | [`b79b4e46148f0de9…`](https://preprod.cardanoscan.io/transaction/b79b4e46148f0de9d4dec96f250639febaa2549f328431a229bde951014e62fd) | 5190152 | yes   |

Every hash above is selected by the head token policy in `head-N/l1-anchors.json`; no L1 address query is involved.
