# Exchain co-sign: spends inside a Hydra head

Audience: Exchain co-signer team (Yuval). Status: draft for review. Date: 2026-10-12.

Provenance tags: VERIFIED = read in this repo or in the hydra-node 2.4.1 source, or run in this session. INFERRED = reasoned, not confirmed.

## Summary

The payment node can pay from a guarded smart wallet while the wallet sits inside an open Hydra head. For these spends the co-sign request carries two new optional context fields:

- `context.hydraHeadId`: the head the spend runs in.
- `context.hydraSnapshot`: the signed header of a confirmed head snapshot, the wallet output, and a KZG membership witness that the output is in that snapshot.

The wallet input does not exist on L1, so Exchain cannot look it up there. Exchain checks the snapshot signatures against party keys that it reads from L1, then checks the witness against the signed accumulator. Then it trusts the wallet output. Exchain needs no access to a head node, and it never receives the rest of the head's UTxO set.

The earlier draft had three open questions. This version answers them as rules:

1. Trusted wallet input: the signed snapshot proof (section 2).
2. Time: read the validity slots in the signed body with the L1 slot config (section 3).
3. Rolling window: one window for L1 and in-head spends together (section 4).

## 1. Request changes

1. `context.hydraHeadId`: the on-chain head id (the policy id of the head tokens), 56 lowercase hex characters. VERIFIED: `packages/payment-source-v2/src/smart-wallet/cosign-client.ts`, `cosignContextSchema`.
2. `context.hydraSnapshot`: an object, schema `hydraSnapshotProofSchema` in the same file. VERIFIED. Fields:
   - `headId`, `version`, `number`, `accumulator` (the signed accumulator hash, hex), `depositTxId` (hex or null).
   - `commitment`: the compressed BLS12-381 G1 commitment C to every output in the head (96 hex characters). Its blake2b-256 is `accumulator`.
   - `witness`: the compressed G1 membership witness π for the wallet output (96 hex characters).
   - `walletOutput`: the wallet output `{ address, value, datumhash?, inlineDatumRaw? }`. `value.lovelace` and every asset quantity are decimal strings, so no JSON stack rounds them.
   - `utxoToCommit`, `utxoToDecommit`: maps from `txId#index` to an output of the same form, or null. These pending sets are small; the signature covers them through their hashes, so they are sent whole.
   - `signatures`: Ed25519 signatures as hex, one per head party, in party order.
3. The node sends both fields only for in-head locks, and always together. VERIFIED: `l2-guarded-lock-execute.ts`, `executeGuardedL2Lock`. The L1 batch path sends neither. Exchain must refuse a request that carries only one of the two, never fall back to the L1 lookup.
4. An in-head request has exactly one intent. VERIFIED: `executeGuardedL2Lock` builds one purchase per body.

Size: the proof does not grow with the head. It carries the header, two G1 points, the wallet output and the pending sets. The payment node builds the witness from the full set; hydra's trusted setup has 4096 G1 powers, so a head holds at most 4095 outputs. VERIFIED: hydra's `trusted_setup.json` has 4096 `g1_monomial` entries, and the shared code caps at `MAX_HYDRA_SNAPSHOT_OUTPUTS = 4095` (`src/lib/hydra/hydra/schemas.ts:13`).

## 2. Rule: how Exchain trusts the in-head wallet input

### Why a signed snapshot

Every party of a head signs each confirmed snapshot. VERIFIED (read in source): `Hydra/Tx/Snapshot.hs`. A party signs only after its own node has applied the transactions. So a valid multisignature means that every party agrees the head holds exactly that multiset of output contents. The payment node cannot invent or change an output content without breaking a signature.

What the signatures do not cover: the output references (`txId#index`). The accumulator and `hashUTxO` hash output contents only; references only set the order. VERIFIED: the accumulator roots and `hashUTxO` read output bytes only (step 4), and an earlier test swapped two refs in a signed snapshot with every signature still valid. So Exchain must never trust `walletUtxoRef` to name the wallet. It identifies the wallet by its state token instead. Each wallet has one state token, minted once with quantity 1, so at most one output anywhere carries it. VERIFIED: `smart-contracts/smart-wallet/lib/smart_wallet/mint.ak:24-31,64-76`.

A snapshot can be old, and an old one can show less value than the wallet holds now, for example before a top-up. The same snapshot is also legitimately sent again while no in-head transaction happens, so refusing repeats is not possible. An old snapshot can therefore hide outflow from a value-based check. Step 10 closes this by fixing the body shape, so value conservation makes the real outflow equal the declared outflow. Exchain also keeps the highest snapshot number it accepted per head and refuses a lower one. Whether the wallet output is still unspent is the head ledger's check when the node submits. If it was spent, the transaction fails in the head and Exchain's witness is useless. INFERRED. A review found the hidden-outflow case.

### Verification steps

1. Check `hydraSnapshot.headId == hydraHeadId`, and that `hydraSnapshot.number` is not lower than the highest number already accepted for that head. Store that number durably, one row per head, and move it in the same database transaction as the budget reservation, before signing:

   ```sql
   INSERT INTO hydra_snapshot_mark (head_id, max_number) VALUES ($headId, $number)
   ON CONFLICT (head_id) DO UPDATE SET max_number = EXCLUDED.max_number
   WHERE hydra_snapshot_mark.max_number <= EXCLUDED.max_number
   RETURNING head_id;
   -- no row returned: the number is older than one already accepted, so refuse.
   ```

   Key the row by `headId`: a new head starts its numbers again. Our preprod fixtures show snapshot 10, then snapshot 12 after a deposit (VERIFIED). That the number never goes down within one head is INFERRED from that run. The reference mock saves its marks in `.state/snapshot-marks.json` before it signs.

2. Get the party keys from L1. Never take them from the request. Then require every key to be on Exchain's own allowlist of trusted Hydra parties. This is a MUST: anyone can mint a token named `HydraHeadV2` under a policy of their own, with a datum that lists their own keys. The L1 read only shows which of the trusted parties form this head and that it is open.
   - Find the output that holds the head state token: policy `hydraHeadId`, asset name `HydraHeadV2`. Compute the unit as `hydraHeadId` followed by the hex of the ASCII string. VERIFIED on preprod with Blockfrost `/assets/{unit}/addresses`, then that address's UTxO with the unit.
   - Decode its inline datum. Require constructor 0 at both levels, or the head is not open. For an open head it is `Constr 0 [Constr 0 [headSeed, headId, parties, contestationPeriod, depositPeriod, version, accumulatorHash, adaOverhead]]`. `parties` is a list of 32-byte Ed25519 keys. VERIFIED on preprod: the list equals the node's `/head` `parameters.parties`.
   - Check that the datum's `headId` field equals `hydraHeadId`.
3. Require exactly one signature per party.
4. Rebuild the signed message. It is the concatenation of six Plutus-data CBOR values. VERIFIED: read in `Snapshot.hs:113-121`, and checked against a live preprod snapshot.
   1. `B headId`
   2. `I version`
   3. `I number`
   4. `B accumulatorHash`
   5. `B decommitOutputsHash` = `hashUTxO(utxoToDecommit)`
   6. `B commitOutputsHash` = `sha256(hashUTxO(utxoToCommit) ‖ depositTxId bytes)`

   Definitions:
   - `hashUTxO(set)` = sha256 of the concatenated Plutus V2 `TxOut` CBOR of the outputs. Order: transaction id bytes, then output index as a number. An empty or null set hashes the empty string.
   - `accumulatorHash` = blake2b-256 of the compressed BLS12-381 G1 KZG commitment to the multiset `utxo ∪ utxoToCommit ∪ utxoToDecommit`. Each output gives the scalar `blake2b-224(sha256(TxOut CBOR))`. The commitment is `Σ cⱼ·τʲ·G1` over the coefficients of `∏(X + sᵢ)`, constant term first. The points are the `g1_monomial` list of hydra's `trusted_setup.json` (sha256 `9a8dcad9eaba191842f57d23d14674cbdea4b3cf7912fcc477821264dfe0c042`). VERIFIED: the rebuild equals the accumulator that the node reported for preprod snapshots 10 and 12.
   - `TxOut` CBOR is `Constr 0 [address, value, datum, Nothing]`, encoded with the Plutus `serialiseData` rules. Decode an inline datum and re-encode it with those rules. Do not copy its raw bytes.

5. Verify each signature (Ed25519 over the raw message bytes) with the party key at the same position.
6. Require `walletOutput` to hold the wallet's state token (policy id and asset name from Exchain's wallet records) with quantity 1. Require that no output in `utxoToDecommit` holds it: those outputs are leaving the head, and the accumulator covers them too. VERIFIED by test.
   - Why one output is enough: each wallet has one state token, minted once with quantity 1, so no second output can carry it. VERIFIED: `mint.ak:24-31,64-76`.
   - The wallet may sit in `utxo` or in `utxoToCommit`. Right after a deposit, the newest confirmed snapshot holds the wallet only in `utxoToCommit`, and Hydra makes no newer snapshot until the next in-head transaction. VERIFIED on preprod: snapshot 12 held the deposited wallet `7659f935…#1` only there. The accumulator covers both sets, so the witness works for both.
7. Check the membership witness. VERIFIED: this is the check Hydra's head contract runs for a partial fanout, `checkMembershipPairing` in Hydra 2.4.1 `hydra-plutus/src/Hydra/Contract/CRS.hs:55-70`.
   1. Require blake2b-256 of the `commitment` bytes to equal `accumulator`.
   2. Decompress `commitment` and `witness` as G1 points. Refuse a point that is not on the curve or not in the prime-order subgroup.
   3. Compute `s = blake2b-224(sha256(TxOut CBOR of walletOutput))` as a big-endian integer (step 4 definitions).
   4. Require `e(C, [1]₂) = e(π, [τ]₂ + s·[1]₂)`.
   5. `[1]₂` and `[τ]₂` are `g2_monomial[0]` and `g2_monomial[1]` of the same `trusted_setup.json` (sha256 `9a8dcad9…c042`, the same file in hydra 2.3.0, 2.4.0 and 2.4.1). VERIFIED by reading the file at tag 2.4.1:
      - `[1]₂` = `93e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8`
      - `[τ]₂` = `b5bfd7dd8cdeb128843bc287230af38926187075cbfbefa81009a2ce615ac53d2914e5870cb452d2afaaab24f3499f72185cbfee53492714734429b7b38608e23926c911cceceac9a36851477ba4c60b087041de621000edc98edada20c1def2`

   The proof carries no ref for the wallet, because refs are not signed. `walletUtxoRef` stays a field of the request; step 9 ties the spent input to the wallet Exchain judged.

8. Require the output's address to equal the wallet address in Exchain's records. The Plutus address encoding has no network id, so compare full bech32 strings. Then use the output as an L1 output: address, value, inline datum.
9. In the signed body, require the one continuing output at the wallet address to hold the wallet's state token with quantity 1. Wallets of one configuration share one address, and refs are not signed. Without this check, a sender could put wallet A's content under wallet B's ref, and the body would spend B while Exchain judged A. The validator makes the continuing output carry the spent input's own state token, so this check ties the spent input to the wallet Exchain judged. VERIFIED: `smart-contracts/smart-wallet/lib/smart_wallet/spend.ak:35-52`. A review found this case.
10. Require the honest builder's exact body shape: the body spends exactly one input (the wallet ref), the fee is 0, it has no certificates, withdrawals, mint, votes, proposals, treasury donation or current-treasury field, and every output is either the one continuing wallet output or an intent output. Why this is safe: Conway value balance is inputs plus withdrawals plus refunds plus mint equals outputs plus fee plus deposits plus donation. With one input, no fee, none of those other fields and no other outputs, the wallet's real value equals the continuing output plus the intent outputs, so the real outflow is exactly the declared outflow, however old the proof is. INFERRED from ledger value conservation. The honest in-head builder already has this shape (VERIFIED: `guarded-l2-lock-builder.ts:95-134`, `setFee('0')`, one `txIn`, continuing `txOut` then lock `txOut`s; collateral is a separate body field, not an input or output). Tested in the mock policy (`cosign-policy.spec.ts`). The rule applies only to in-head spends; L1 spends keep the Blockfrost lookup, which reads the output by its ref; that content cannot change.

Input form: every ref in the pending sets must be canonical (lowercase hex, no leading zeros in the index), every policy id, asset name and datum field strict lowercase hex, every quantity a canonical decimal string, and an output must not carry both `datumhash` and `inlineDatumRaw`, because only one of the two is signed. VERIFIED: `snapshot-proof.ts` and the shared serializer refuse each case, with tests. The verifier returns a fresh copy of the wallet output that holds only signed fields, with the inline datum in its canonical re-encoded bytes. This matters because the shared serializer lowercases keys: an uppercase twin of a policy key would sign as one key while the wire object kept both. A review found that case. VERIFIED by test.

Cost and order: check the Ed25519 signatures first, then the two pairings. The pairing check took about 21 ms in Node, whatever the size of the head. Building the witness is the payment node's work: about 1.5 s at 4095 outputs, against about 3.5 s for the full accumulator rebuild that an earlier version of this design asked of Exchain. VERIFIED on a laptop with the shared code (random outputs, 100 and 4095 per run).

Reference code: `packages/payment-source-v2/src/smart-wallet/hydra-snapshot/snapshot-proof.ts` (`verifyHydraSnapshotProof`, with tests against real preprod snapshots). It uses `verifyHydraSnapshotSignatures` from `src/lib/hydra/hydra/snapshot-verification.ts` (the signature half of the check the payment node runs on every snapshot from its own head nodes) and `verifyHydraMembership` from `src/lib/hydra/hydra/snapshot-membership.ts`. The node builds the witness with `computeHydraMembershipWitness` in `snapshot-accumulator.ts`. The mock co-signer `packages/payment-source-v2/scripts/smart-wallet-hydra/mock.mts` runs these steps, with party keys from Blockfrost and a party allowlist from its env. Exchain can port the code or use it as a library.

### Limits

1. Trust needs independent parties. If one operator runs every party of a head, the signatures prove nothing against that operator. The allowlist in step 2 should therefore hold parties that Exchain runs or that a known third party runs. INFERRED. This is the main remaining risk of this design.
2. The proof form has no field for a reference script, so the payment node cannot send the wallet output or a pending-set output that carries one. Outputs elsewhere in the head may carry reference scripts: the node serializes them for the witness and never sends them. VERIFIED: `build-proof.ts`, and a test that builds a valid witness with a reference-script output in the head. A head with a Byron address output cannot produce a proof. VERIFIED: `src/lib/hydra/hydra/snapshot-serialization.ts:91`.
3. Party keys are on L1 only while the head is open. A closed head has no open datum, so Exchain refuses (step 2). INFERRED: this is correct, because no in-head spend can settle then.

## 3. Rule: time and validity interval

1. An in-head body uses slots on the L1 slot timeline of the network that the head settles on. VERIFIED: `src/utils/hydra/l2-slot-context.ts` header.
2. Exchain reads the window from the signed body's validity start and TTL. It converts both with the public slot config of the network (preprod or mainnet). This is the same rule as for L1 bodies. INFERRED.
3. Exchain ignores `context.submittedAt` for policy decisions. Only the node states it. The body window is signed by the wallet quorum, and the validator enforces it. VERIFIED: `spend.ak:137-142` reads the validity range.
4. Head lag: the head clock follows L1 blocks, so it can be a little behind L1 time. A window start slightly in the past is then normal. Exchain should accept the same start tolerance that it uses for L1 bodies. INFERRED: we did not measure the lag.

## 4. Rule: rolling window

The datum holds one spend counter: `period_start` and `spent_in_period`. VERIFIED: `smart-contracts/smart-wallet/lib/smart_wallet/spend.ak:137-162`. So Exchain must count L1 and in-head spends in one shared window.

How the counter moves:

1. On an agent spend the validator reads `lower`, the window start. If `lower >= period_start + period_length`, the period rolls over: the new `period_start` is `lower`, and the counter restarts at zero. VERIFIED: `spend.ak:138-154`.
2. The validator adds the outflow (input value minus continuing value) and requires the sum to stay within the limit. VERIFIED: `spend.ak:156-157`.
3. When the wallet moves into the head, the datum moves with it unchanged. When it moves back, the in-head counter comes back to L1. INFERRED from the transfer builders, which keep the datum.

Why one window: with separate windows, an agent could spend the full limit on L1, move into the head, and spend the full limit again in the same period. That doubles the allowance. With one window, both sides use one budget. The datum already enforces that on chain.

What Exchain does: read the continuing wallet output in the signed body. Its datum shows `period_start` and `spent_in_period` after this spend. Check them against Exchain's own records for the wallet. Key the records by the wallet's state token, not by L1 or L2. INFERRED.

## 5. What does not change

- Request fields `batchId`, `walletUtxoRef`, `intents`, `txBodyHex`, and the other context fields.
- Response shape, verdicts and partial-approval rules (contract 1.1).
- L1 batches: they carry neither new field.

## 6. How it was tested

- VERIFIED: for preprod snapshot 12 of head `141b9819…0478` (a pending deposit: `utxoToCommit` and `depositTxId` set), the witness the node builds verifies against the accumulator that both parties signed. The verifier rejects a changed wallet output, a real witness for another output, the commitment of another snapshot, a point off the curve, a changed commit set, another deposit id, swapped signatures, wrong or missing party keys, another head, and an output without the state token. So the `commitOutputsHash` rule and the pairing are checked against real signatures.
- VERIFIED: the node builds no proof for the wallet in preprod snapshot 10, where it is only in `utxoToDecommit`. On snapshots signed in the test with fresh keys, the verifier refuses a wallet whose token is in the decommit set and a token held with quantity 2.
- VERIFIED: flipping the sign of `s` in the pairing makes 5 of the 19 proof tests fail, the preprod acceptance among them.
- VERIFIED on preprod, end to end through the payment node API: the wallet moved into the head (deposit `d252bbbb…`). A 5 ADA purchase inside the head was co-signed by the mock after it verified snapshot 12 with party keys read from Blockfrost, and locked (FundsLocked, tx `c6ae4ce5…`). The wallet moved back to L1 (`a70cbf03…`). On L1 its datum showed `spentInPeriod` 20 ADA, up from 15 ADA before the deposit. This is the shared counter of section 4.
- VERIFIED on preprod earlier (before the proof existed): a 10 ADA in-head purchase was co-signed and locked. A 25 ADA purchase was refused by the 20 ADA per-transaction cap.
- Not re-run live: the membership witness, the state-token lookup, the party allowlist, the snapshot-number check, the canonical output copy, the continuing state-token check, the in-head body-shape rule and the mock's lucid decoder for the L1 head datum came after the preprod run above, from a review. They are covered by the tests only.
- Not tested: the real Exchain co-signer.

Correction: an earlier version of step 10 checked the datum counter instead of the body shape. It assumed that "within one period a counter only grows". That was wrong: the owner's UpdatePolicy action may write any datum, including a lower `spent_in_period` (VERIFIED: `update_is_valid`, `spend.ak:201-210`). A stale proof taken before an owner refill and counter reset could then let an extra input or an agent change output take the refill while the counter still looked right. A review found it. The body-shape rule does not depend on the counter. A later review found that the first body-shape rule used the formula "inputs equal outputs plus fee", which leaves out deposits, refunds, withdrawals, mint and treasury donation. A stale proof could then sink hidden value into a stake deposit or a donation (the head's protocol parameters set `stakeAddressDeposit` to 2000000, VERIFIED: `packages/hydra-host/params/preprod.json:54`). Step 10 now refuses all of those fields. Not determined: whether hydra-node accepts certificates or donation in the head at all.

Correction: an earlier version of this note sent the whole head UTxO set and said a smaller membership proof "needs changes in hydra-node". That was wrong. The payment node already holds the full set and the trusted setup, so it can build the witness itself, and hydra 2.4.1 already defines the check for partial fanout. Nothing in hydra-node changes.

Correction: an earlier version of this note said Exchain could look the wallet up by `walletUtxoRef`, because "a TxIn names one output forever". That was wrong. It is true on the ledger, but the snapshot signatures do not cover refs, so the sender could relabel outputs. A review found it by swapping refs in a signed snapshot. Section 2 now selects the wallet by its state token.

## Least confident decisions

1. The independent-party requirement. Without it, the proof is only as honest as the head operator. Exchain must decide which heads it trusts.
2. The membership witness. It follows hydra's own partial-fanout check, and our tests verify it against real preprod signatures. It has not run live with a co-signer yet, and no hydra test vector for a single-output witness was compared byte for byte.
3. The head-lag tolerance in section 3. We did not measure a bound.
4. Refusing older snapshot numbers needs Exchain to store a number per head (step 1). The number stops replay of older snapshots. It cannot stop a node that holds back a newer snapshot, so step 10 stays required.
5. The fields are optional and there is no version bump. A co-signer that ignores unknown fields cannot find the wallet on L1 and refuses. It does not sign the wrong thing.
